// Token store — Modo Supabase
// Lee el access_token de la tabla oauth_tokens en Supabase.
// El token es refresheado externamente (n8n cron cada 2h) y persistido en Supabase.
// Schema esperado:
//   tabla: oauth_tokens (en schema por defecto del client)
//   columnas relevantes: account_label (text), access_token (text), expires_at (timestamptz)
// Configurable vía env vars (acepta convenciones genéricas o de Next.js):
//   SUPABASE_URL  o  NEXT_PUBLIC_SUPABASE_URL     — URL del project
//   SUPABASE_SERVICE_KEY  o  SUPABASE_SERVICE_ROLE_KEY — service_role key (bypass RLS)
//   ML_ACCOUNT_LABEL          — valor a matchear contra account_label (default: 'miami')
//   ML_TOKEN_TABLE            — tabla (default: 'oauth_tokens')

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

interface CachedToken {
  accessToken: string
  expiresAt: number // ms epoch
}

let supabase: SupabaseClient | null = null
let cached: CachedToken | null = null

// Margen de seguridad: refrescar 60s antes del vencimiento real
const REFRESH_MARGIN_MS = 60 * 1000

// --- Lease CAS (compare-and-set) para serializar el refresh cross-proceso ---
// El lease se guarda EN la fila de oauth_tokens (columnas refresh_in_progress /
// locked_until, ver migrations/0001_oauth_tokens_lease.sql). No se usa
// pg_advisory_lock: PostgREST poolea conexiones y el advisory lock no sobrevive
// el pooling.
const LEASE_TTL_MS = 30 * 1000 // vigencia del lease: si el holder muere, se libera
const LEASE_WAIT_POLL_MS = 500 // cada cuánto re-consultar la DB esperando token fresco
const LEASE_WAIT_TIMEOUT_MS = 20 * 1000 // tope de espera por un token de otro proceso

function getUrl(): string | undefined {
  return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
}

function getServiceKey(): string | undefined {
  return process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
}

export function isSupabaseModeEnabled(): boolean {
  return Boolean(getUrl() && getServiceKey())
}

function getSupabaseClient(): SupabaseClient {
  if (supabase) return supabase
  const url = getUrl()
  const key = getServiceKey()
  if (!url || !key) {
    throw new Error(
      'Supabase mode requiere (SUPABASE_URL | NEXT_PUBLIC_SUPABASE_URL) y ' +
        '(SUPABASE_SERVICE_KEY | SUPABASE_SERVICE_ROLE_KEY) en el entorno.'
    )
  }
  supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return supabase
}

export async function getAccessTokenFromSupabase(): Promise<string> {
  // Reusar token cacheado si todavía es válido
  if (cached && cached.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
    return cached.accessToken
  }

  const client = getSupabaseClient()
  const table = process.env.ML_TOKEN_TABLE || 'oauth_tokens'
  const accountLabel = process.env.ML_ACCOUNT_LABEL || 'miami'

  const { data, error } = await client
    .from(table)
    .select('access_token, expires_at')
    .eq('account_label', accountLabel)
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(
      `Error leyendo token de Supabase (${table} where account_label='${accountLabel}'): ${error.message}`
    )
  }

  if (!data || !data.access_token) {
    throw new Error(
      `No se encontró access_token en ${table} para account_label='${accountLabel}'. ` +
        'Asegurate de que n8n haya completado al menos un OAuth callback.'
    )
  }

  const expiresAt = data.expires_at
    ? new Date(data.expires_at).getTime()
    : Date.now() + 6 * 60 * 60 * 1000 // fallback 6h si no hay expires_at

  if (expiresAt < Date.now()) {
    console.error(
      `[ml-mcp] WARNING: token de Supabase ya expiró (${new Date(expiresAt).toISOString()}). ` +
        'n8n debería renovarlo cada 2h. Lo uso igual pero esperá errores 401.'
    )
  }

  cached = { accessToken: data.access_token, expiresAt }
  return cached.accessToken
}

export function clearSupabaseTokenCache(): void {
  cached = null
}

// ===========================================================================
// Lease CAS + persistencia del token (modo standalone auto-refresh con Supabase)
//
// Estas funciones las usa src/auth.ts para serializar el refresh del token ENTRE
// procesos (no sólo dentro de uno). Todas operan sobre la misma tabla/cliente que
// el modo de lectura. NUNCA se loguea el valor de un token.
// ===========================================================================

function tokenTable(): string {
  return process.env.ML_TOKEN_TABLE || 'oauth_tokens'
}

/** Fila leída de oauth_tokens (subset que nos interesa). `null` si no existe. */
export interface TokenRow {
  accessToken: string
  expiresAt: number // ms epoch
  refreshToken?: string
}

/** Lee la fila del token para una cuenta. Devuelve null si no hay fila/access_token. */
export async function readTokenRow(accountLabel: string): Promise<TokenRow | null> {
  const client = getSupabaseClient()
  const { data, error } = await client
    .from(tokenTable())
    .select('access_token, expires_at, refresh_token')
    .eq('account_label', accountLabel)
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(
      `Error leyendo token de Supabase (${tokenTable()} where account_label='${accountLabel}'): ${error.message}`
    )
  }
  if (!data || !data.access_token) return null

  const expiresAt = data.expires_at
    ? new Date(data.expires_at).getTime()
    : Date.now() + 6 * 60 * 60 * 1000 // fallback 6h
  return {
    accessToken: data.access_token,
    expiresAt,
    refreshToken: data.refresh_token || undefined,
  }
}

/**
 * Adquiere el lease por compare-and-set: marca refresh_in_progress=true SÓLO si
 * estaba libre (false/null) o el lease anterior venció (locked_until < now). El
 * UPDATE condicional es atómico en Postgres. Devuelve true si lo conseguimos.
 */
export async function tryAcquireRefreshLease(accountLabel: string): Promise<boolean> {
  const client = getSupabaseClient()
  const nowIso = new Date().toISOString()
  const lockedUntilIso = new Date(Date.now() + LEASE_TTL_MS).toISOString()

  const { data, error } = await client
    .from(tokenTable())
    .update({ refresh_in_progress: true, locked_until: lockedUntilIso })
    .eq('account_label', accountLabel)
    .or(`refresh_in_progress.is.false,refresh_in_progress.is.null,locked_until.lt.${nowIso}`)
    .select('account_label')

  if (error) {
    throw new Error(`Error adquiriendo lease en ${tokenTable()}: ${error.message}`)
  }
  return Array.isArray(data) && data.length > 0
}

/** Libera el lease (refresh_in_progress=false, locked_until=null). */
export async function releaseRefreshLease(accountLabel: string): Promise<void> {
  const client = getSupabaseClient()
  const { error } = await client
    .from(tokenTable())
    .update({ refresh_in_progress: false, locked_until: null })
    .eq('account_label', accountLabel)
  if (error) throw new Error(error.message)
}

/** Persiste el token refrescado y libera el lease en un solo UPDATE. No fatal si falla. */
export async function persistRefreshedToken(
  accountLabel: string,
  tok: { accessToken: string; expiresAt: number; refreshToken?: string }
): Promise<void> {
  const client = getSupabaseClient()
  const update: Record<string, unknown> = {
    access_token: tok.accessToken,
    expires_at: new Date(tok.expiresAt).toISOString(),
    refresh_in_progress: false,
    locked_until: null,
  }
  if (tok.refreshToken) update.refresh_token = tok.refreshToken

  const { error } = await client
    .from(tokenTable())
    .update(update)
    .eq('account_label', accountLabel)
  if (error) {
    // No fatal: el token ya lo tenemos en memoria. Avisamos SIN el valor.
    console.error(
      `[ml-mcp] No se pudo persistir el token refrescado en la DB (no fatal): ${error.message}`
    )
  } else {
    console.error('[ml-mcp] Token refrescado persistido en la DB (valor no logueado).')
  }
}

/** Espera (poll) a que la DB tenga un token fresco refrescado por otro proceso. */
export async function waitForFreshDbToken(
  accountLabel: string,
  marginMs = REFRESH_MARGIN_MS
): Promise<TokenRow> {
  const deadline = Date.now() + LEASE_WAIT_TIMEOUT_MS
  for (;;) {
    const row = await readTokenRow(accountLabel)
    if (row && row.expiresAt > Date.now() + marginMs) return row
    if (Date.now() >= deadline) {
      throw new Error(
        'Timeout esperando un token fresco desde la DB (otro proceso tiene el lease de refresh).'
      )
    }
    await new Promise((r) => setTimeout(r, LEASE_WAIT_POLL_MS))
  }
}

/**
 * Inyección del cliente Supabase para tests (mock de la DB). `null` lo resetea
 * para que el próximo acceso lo reconstruya desde el entorno.
 */
export function __setSupabaseClientForTest(client: SupabaseClient | null): void {
  supabase = client
}
