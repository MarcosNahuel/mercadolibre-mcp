// OAuth2 para Mercado Libre — soporta 3 modos (en orden de prioridad):
// 0. Supabase (SUPABASE_URL + SUPABASE_SERVICE_KEY) — lee de oauth_tokens, refresheado por n8n
// 1. Token directo (ML_ACCESS_TOKEN) — refresheado externamente por n8n/cron
// 2. Auto-refresh (ML_CLIENT_ID + ML_CLIENT_SECRET + ML_REFRESH_TOKEN) — refresh interno
//
// Se puede forzar el modo con ML_AUTH_MODE=standalone (salta 0 y 1 → usa el
// auto-refresh aunque haya Supabase configurado, para habilitar el lease CAS).
// Sin ML_AUTH_MODE, el comportamiento por default es el histórico (0 → 1 → 2).
//
// REGLA DE LOGGING (no negociable): JAMÁS se loguea el valor de un token (ni
// truncado). Solo "presente/ausente" o "refrescado ok" (ver docs/PLAN-fusion-mercadolibre-mcp.md B2).
//
// SERIALIZACIÓN DEL REFRESH (el refresh_token de ML es de un solo uso: rota en cada
// refresh; dos refresh concurrentes revocan la cuenta con invalid_grant en el segundo):
//   - single-flight in-process: una sola promesa de refresh por proceso (Blocker A).
//   - lease CAS cross-proceso: si además hay Supabase, se adquiere un lease en la fila
//     de oauth_tokens (refresh_in_progress/locked_until) antes de refrescar, para
//     serializar entre réplicas. Fallback: sin Supabase, sólo single-flight in-process.
//     Ver migrations/0001_oauth_tokens_lease.sql y docs/PLAN-fusion-mercadolibre-mcp.md B1.

import type { MLConfig, TokenData } from './types.js'
import {
  isSupabaseModeEnabled,
  getAccessTokenFromSupabase,
  clearSupabaseTokenCache,
  tryAcquireRefreshLease,
  releaseRefreshLease,
  persistRefreshedToken,
  readTokenRow,
  waitForFreshDbToken,
} from './token-store.js'

const ML_AUTH_URL = 'https://api.mercadolibre.com/oauth/token'

// Margen de seguridad: tratar el token como vencido 5 min antes del expiry real.
const REFRESH_MARGIN_MS = 5 * 60 * 1000

let cachedToken: TokenData | null = null
/** single-flight: si ya hay un refresh en curso, todos los callers comparten esa promesa. */
let refreshInflight: Promise<TokenData> | null = null
/** refresh_token rotado por ML en runtime (para persistir a la DB). Nunca se loguea el valor. */
let rotatedRefreshToken: string | null = null

export function getConfig(): MLConfig {
  const clientId = process.env.ML_CLIENT_ID || ''
  const clientSecret = process.env.ML_CLIENT_SECRET || ''
  const refreshToken = process.env.ML_REFRESH_TOKEN || ''
  const siteId = process.env.ML_SITE_ID || 'MLA'

  return { clientId, clientSecret, refreshToken, siteId }
}

/** Cuenta a la que apunta el lease/fila de oauth_tokens (default 'miami', igual que token-store). */
function accountLabel(): string {
  return process.env.ML_ACCOUNT_LABEL || 'miami'
}

/** ¿El usuario forzó el modo standalone (auto-refresh) aunque haya Supabase? */
function forcedStandalone(): boolean {
  return (process.env.ML_AUTH_MODE || '').trim().toLowerCase() === 'standalone'
}

export async function getAccessToken(): Promise<string> {
  const standalone = forcedStandalone()

  // Modo 0: Supabase (multi-tenant, refresheado por n8n). Se salta si se fuerza standalone.
  if (!standalone && isSupabaseModeEnabled()) {
    return getAccessTokenFromSupabase()
  }

  // Modo 1: Token directo (gestionado externamente por n8n, cron, etc.).
  if (!standalone) {
    const directToken = process.env.ML_ACCESS_TOKEN
    if (directToken) {
      return directToken
    }
  }

  // Modo 2: Auto-refresh con OAuth2.
  // Si el token está cacheado y no expiró (con margen), reusar.
  if (cachedToken && cachedToken.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
    return cachedToken.accessToken
  }

  // Single-flight: si ya hay un refresh en curso, compartimos esa promesa en vez
  // de disparar un segundo POST /oauth/token en paralelo (rotaría el refresh_token
  // dos veces y el segundo request fallaría con invalid_grant).
  if (refreshInflight) {
    const tok = await refreshInflight
    return tok.accessToken
  }

  const p = refreshTokenFlow().finally(() => {
    refreshInflight = null
  })
  refreshInflight = p
  const tok = await p
  return tok.accessToken
}

/**
 * Orquesta el refresh. Con Supabase configurado, serializa cross-proceso con un
 * lease CAS sobre oauth_tokens; sin Supabase, sólo el single-flight in-process
 * (que ya envuelve a este flujo) protege la carrera.
 */
async function refreshTokenFlow(): Promise<TokenData> {
  const config = getConfig()

  if (!config.clientId || !config.clientSecret || !config.refreshToken) {
    throw new Error(
      'Configurá ML_ACCESS_TOKEN (token directo) o ML_CLIENT_ID + ML_CLIENT_SECRET + ML_REFRESH_TOKEN (auto-refresh). ' +
      'Si usás n8n para renovar el token, configurá ML_ACCESS_TOKEN.'
    )
  }

  // Sin Supabase: sólo single-flight in-process (límite documentado: multi-proceso
  // sin Supabase no serializa entre procesos).
  if (!isSupabaseModeEnabled()) {
    const tok = await callMlRefresh(config)
    cachedToken = tok
    return tok
  }

  // Con Supabase: lease CAS cross-proceso.
  const label = accountLabel()
  const acquired = await tryAcquireRefreshLease(label)
  if (!acquired) {
    // Otro proceso está refrescando: esperamos a que aparezca un token fresco en la DB.
    console.error('[ml-mcp] Lease de refresh ocupado por otro proceso; esperando token fresco desde la DB...')
    const row = await waitForFreshDbToken(label, REFRESH_MARGIN_MS)
    cachedToken = { accessToken: row.accessToken, expiresAt: row.expiresAt }
    return cachedToken
  }

  try {
    // Doble chequeo: otro proceso pudo refrescar justo antes de que tomáramos el lease.
    const row = await readTokenRow(label)
    if (row && row.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
      console.error('[ml-mcp] Token ya fresco en la DB (refrescado por otro proceso); no se refresca.')
      cachedToken = { accessToken: row.accessToken, expiresAt: row.expiresAt }
      return cachedToken
    }

    const tok = await callMlRefresh(config)
    // Persiste el token (+ refresh_token rotado si lo hay) y libera el lease en un UPDATE.
    await persistRefreshedToken(label, {
      accessToken: tok.accessToken,
      expiresAt: tok.expiresAt,
      refreshToken: rotatedRefreshToken ?? undefined,
    })
    cachedToken = tok
    return tok
  } finally {
    await releaseRefreshLease(label).catch((e) =>
      console.error(`[ml-mcp] No se pudo liberar el lease de refresh (no fatal): ${(e as Error).message}`)
    )
  }
}

/** POST /oauth/token con grant_type=refresh_token. Serializado por el caller. */
async function callMlRefresh(config: MLConfig): Promise<TokenData> {
  const response = await fetch(ML_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
    }),
  })

  if (!response.ok) {
    // No incluimos el body de la respuesta: podría reflejar el refresh_token enviado.
    throw new Error(
      `Error renovando token ML (HTTP ${response.status}). ` +
      'Verificá que ML_CLIENT_ID, ML_CLIENT_SECRET y ML_REFRESH_TOKEN sean correctos.'
    )
  }

  const data = await response.json() as {
    access_token: string
    expires_in: number
    refresh_token?: string
  }

  // Actualizar el refresh_token si ML devuelve uno nuevo. NUNCA logueamos el valor
  // (ni truncado) — solo que rotó.
  if (data.refresh_token && data.refresh_token !== config.refreshToken) {
    process.env.ML_REFRESH_TOKEN = data.refresh_token
    rotatedRefreshToken = data.refresh_token
    console.error('[ml-mcp] Refresh token rotado por ML (nuevo valor aplicado, no se loguea).')
  }

  console.error('[ml-mcp] Access token refrescado ok.')
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }
}

// Para tests o reset manual (limpia ambos caches)
export function clearTokenCache(): void {
  cachedToken = null
  refreshInflight = null
  rotatedRefreshToken = null
  clearSupabaseTokenCache()
}
