// OAuth2 para Mercado Libre — soporta 3 modos (en orden de prioridad):
// 0. Supabase (SUPABASE_URL + SUPABASE_SERVICE_KEY) — lee de oauth_tokens, refresheado por n8n
// 1. Token directo (ML_ACCESS_TOKEN) — refresheado externamente por n8n/cron
// 2. Auto-refresh (ML_CLIENT_ID + ML_CLIENT_SECRET + ML_REFRESH_TOKEN) — refresh interno cada 6h
//
// REGLA DE LOGGING (no negociable): JAMÁS se loguea el valor de un token (ni
// truncado). Solo "presente/ausente" o "refrescado ok" (ver docs/PLAN-fusion-mercadolibre-mcp.md B2).
//
// El modo 2 serializa el refresh con single-flight in-process (una sola promesa
// de refresh por proceso): el refresh_token de ML es de un solo uso (rota en cada
// refresh) — dos refresh concurrentes revocan la cuenta (invalid_grant en el segundo).
// Ver docs/PLAN-fusion-mercadolibre-mcp.md B1.

import type { MLConfig, TokenData } from './types.js'
import {
  isSupabaseModeEnabled,
  getAccessTokenFromSupabase,
  clearSupabaseTokenCache,
} from './token-store.js'

const ML_AUTH_URL = 'https://api.mercadolibre.com/oauth/token'

let cachedToken: TokenData | null = null
/** single-flight: si ya hay un refresh en curso, todos los callers comparten esa promesa. */
let refreshInflight: Promise<TokenData> | null = null

export function getConfig(): MLConfig {
  const clientId = process.env.ML_CLIENT_ID || ''
  const clientSecret = process.env.ML_CLIENT_SECRET || ''
  const refreshToken = process.env.ML_REFRESH_TOKEN || ''
  const siteId = process.env.ML_SITE_ID || 'MLA'

  return { clientId, clientSecret, refreshToken, siteId }
}

export async function getAccessToken(): Promise<string> {
  // Modo 0: Supabase (multi-tenant, refresheado por n8n)
  if (isSupabaseModeEnabled()) {
    return getAccessTokenFromSupabase()
  }

  // Modo 1: Token directo (gestionado externamente por n8n, cron, etc.)
  const directToken = process.env.ML_ACCESS_TOKEN
  if (directToken) {
    return directToken
  }

  // Modo 2: Auto-refresh con OAuth2
  // Si el token está cacheado y no expiró (con 5 min de margen), reusar
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cachedToken.accessToken
  }

  // Single-flight: si ya hay un refresh en curso, compartimos esa promesa en vez
  // de disparar un segundo POST /oauth/token en paralelo (rotaría el refresh_token
  // dos veces y el segundo request fallaría con invalid_grant).
  if (refreshInflight) {
    const tok = await refreshInflight
    return tok.accessToken
  }

  const p = refreshToken().finally(() => {
    refreshInflight = null
  })
  refreshInflight = p
  const tok = await p
  return tok.accessToken
}

async function refreshToken(): Promise<TokenData> {
  const config = getConfig()

  if (!config.clientId || !config.clientSecret || !config.refreshToken) {
    throw new Error(
      'Configurá ML_ACCESS_TOKEN (token directo) o ML_CLIENT_ID + ML_CLIENT_SECRET + ML_REFRESH_TOKEN (auto-refresh). ' +
      'Si usás n8n para renovar el token, configurá ML_ACCESS_TOKEN.'
    )
  }

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
    refresh_token: string
  }

  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }

  // Actualizar el refresh_token si ML devuelve uno nuevo. NUNCA logueamos el valor
  // (ni truncado) — solo que rotó.
  if (data.refresh_token && data.refresh_token !== config.refreshToken) {
    process.env.ML_REFRESH_TOKEN = data.refresh_token
    console.error('[ml-mcp] Refresh token rotado por ML (nuevo valor aplicado, no se loguea).')
  }

  console.error('[ml-mcp] Access token refrescado ok.')
  return cachedToken
}

// Para tests o reset manual (limpia ambos caches)
export function clearTokenCache(): void {
  cachedToken = null
  refreshInflight = null
  clearSupabaseTokenCache()
}
