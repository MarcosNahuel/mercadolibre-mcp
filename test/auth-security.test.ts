// Tests de seguridad del auto-refresh (modo 2, standalone).
// Gate no negociable (docs/PLAN-fusion-mercadolibre-mcp.md B1+B2):
//   B1 — el refresh debe serializarse (single-flight in-process).
//   B2 — jamás se loguea el valor del token, ni truncado.
import { test } from 'node:test'
import assert from 'node:assert/strict'

function setStandaloneEnv() {
  process.env.ML_CLIENT_ID = 'test-client-id'
  process.env.ML_CLIENT_SECRET = 'test-client-secret'
  process.env.ML_REFRESH_TOKEN = 'TG-refresh-token-real-secreto-1234567890'
  delete process.env.ML_ACCESS_TOKEN
  delete process.env.SUPABASE_URL
  delete process.env.NEXT_PUBLIC_SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_KEY
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
}

function mockFetchOnce(response: { access_token: string; expires_in: number; refresh_token?: string }) {
  let calls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (..._args: unknown[]) => {
    calls++
    // Simula latencia de red para que las llamadas concurrentes se solapen de verdad.
    await new Promise((r) => setTimeout(r, 30))
    return {
      ok: true,
      status: 200,
      json: async () => response,
      text: async () => JSON.stringify(response),
    } as Response
  }) as typeof fetch
  return {
    callCount: () => calls,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

test('B1: single-flight — 2 llamadas concurrentes disparan UN solo POST a /oauth/token', async () => {
  setStandaloneEnv()
  const mock = mockFetchOnce({ access_token: 'access-abc', expires_in: 21600 })
  try {
    const { getAccessToken, clearTokenCache } = await import(`../src/auth.ts?t=${Date.now()}`)
    clearTokenCache()
    const [a, b] = await Promise.all([getAccessToken(), getAccessToken()])
    assert.equal(a, 'access-abc')
    assert.equal(b, 'access-abc')
    assert.equal(mock.callCount(), 1, 'debe haber UN solo refresh, no dos en paralelo')
  } finally {
    mock.restore()
  }
})

test('B2: el valor del refresh_token nunca se loguea (ni truncado)', async () => {
  setStandaloneEnv()
  const secretRotated = 'TG-nuevo-refresh-token-secreto-ROTADO-9876543210'
  const mock = mockFetchOnce({ access_token: 'access-xyz', expires_in: 21600, refresh_token: secretRotated })
  const originalError = console.error
  const logged: string[] = []
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '))
  }
  try {
    const { getAccessToken, clearTokenCache } = await import(`../src/auth.ts?t=${Date.now()}`)
    clearTokenCache()
    await getAccessToken()
    const original = process.env.ML_REFRESH_TOKEN
    const leaked = logged.some(
      (line) =>
        line.includes(secretRotated) ||
        line.includes(secretRotated.substring(0, 20)) ||
        (original && line.includes(original.substring(0, 20))),
    )
    assert.equal(leaked, false, `un log contiene el valor del token: ${JSON.stringify(logged)}`)
  } finally {
    console.error = originalError
    mock.restore()
  }
})

test('B1: si el refresh falla, el siguiente llamado reintenta (inflight se limpia)', async () => {
  setStandaloneEnv()
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    if (calls === 1) {
      return { ok: false, status: 500, json: async () => ({}), text: async () => 'error' } as Response
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'access-retry-ok', expires_in: 21600 }),
      text: async () => '',
    } as Response
  }) as typeof fetch
  try {
    const { getAccessToken, clearTokenCache } = await import(`../src/auth.ts?t=${Date.now()}`)
    clearTokenCache()
    await assert.rejects(() => getAccessToken())
    const token = await getAccessToken()
    assert.equal(token, 'access-retry-ok')
    assert.equal(calls, 2, 'el segundo intento debe volver a llamar a fetch (no queda colgado el inflight)')
  } finally {
    globalThis.fetch = originalFetch
  }
})
