// Tests del lease CAS (compare-and-set) para serializar el refresh cross-proceso.
// Se mockea el cliente Supabase (no hay DB real): validamos que
//   - tryAcquireRefreshLease hace un UPDATE condicional y devuelve true sólo si tocó fila
//   - un segundo proceso NO adquiere el lease mientras otro lo tiene (0 filas)
//   - releaseRefreshLease / persistRefreshedToken emiten los UPDATE correctos
//   - jamás se loguea el valor de un token
import { test } from 'node:test'
import assert from 'node:assert/strict'

// --- Mock mínimo del query builder de supabase-js (encadenable) ---
// Cada .from() abre una operación; los métodos encadenan y devuelven this; el await
// final resuelve { data, error }. Registramos la operación para inspeccionarla.
interface RecordedOp {
  table: string
  type: 'update' | 'select'
  payload?: Record<string, unknown>
  filters: Record<string, unknown>
  orClause?: string
}

function makeMockClient(opts: {
  // qué filas devuelve el UPDATE del lease (controla acquired = length>0)
  leaseUpdateReturns?: (op: RecordedOp) => unknown[]
  // qué fila devuelve el SELECT (readTokenRow)
  selectReturns?: () => { access_token: string; expires_at: string; refresh_token?: string } | null
}) {
  const ops: RecordedOp[] = []

  function builder(table: string) {
    const op: RecordedOp = { table, type: 'select', filters: {} }
    const chain: Record<string, unknown> = {}
    const api = {
      update(payload: Record<string, unknown>) {
        op.type = 'update'
        op.payload = payload
        return api
      },
      select(_cols?: string) {
        // en UPDATE...select() resuelve la promesa con filas; en lectura se combina con maybeSingle
        if (op.type === 'update') {
          const rows = opts.leaseUpdateReturns ? opts.leaseUpdateReturns(op) : []
          return Promise.resolve({ data: rows, error: null })
        }
        return api
      },
      eq(col: string, val: unknown) {
        op.filters[col] = val
        return api
      },
      or(clause: string) {
        op.orClause = clause
        return api
      },
      limit(_n: number) {
        return api
      },
      maybeSingle() {
        const row = opts.selectReturns ? opts.selectReturns() : null
        return Promise.resolve({ data: row, error: null })
      },
    }
    Object.assign(chain, api)
    ops.push(op)
    return api
  }

  return {
    client: { from: (table: string) => builder(table) },
    ops,
  }
}

function setStandaloneSupabaseEnv() {
  process.env.ML_AUTH_MODE = 'standalone'
  process.env.ML_ACCOUNT_LABEL = 'test-acct'
  process.env.ML_TOKEN_TABLE = 'oauth_tokens'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_KEY = 'service-role-key-fake'
  process.env.ML_CLIENT_ID = 'cid'
  process.env.ML_CLIENT_SECRET = 'csecret'
  process.env.ML_REFRESH_TOKEN = 'TG-refresh-secreto-abc'
  delete process.env.ML_ACCESS_TOKEN
}

test('CAS: tryAcquireRefreshLease devuelve true cuando el UPDATE condicional tocó la fila', async () => {
  setStandaloneSupabaseEnv()
  const { client, ops } = makeMockClient({ leaseUpdateReturns: () => [{ account_label: 'test-acct' }] })
  const store = await import(`../src/token-store.ts?t=${Date.now()}`)
  store.__setSupabaseClientForTest(client as never)

  const acquired = await store.tryAcquireRefreshLease('test-acct')
  assert.equal(acquired, true)

  const leaseOp = ops.find((o) => o.type === 'update')
  assert.ok(leaseOp, 'debe haber un UPDATE')
  assert.equal(leaseOp!.payload!.refresh_in_progress, true)
  assert.ok(leaseOp!.payload!.locked_until, 'debe setear locked_until')
  assert.equal(leaseOp!.filters.account_label, 'test-acct')
  // El filtro CAS: libre (false/null) o lease vencido.
  assert.match(leaseOp!.orClause ?? '', /refresh_in_progress\.is\.false/)
  assert.match(leaseOp!.orClause ?? '', /locked_until\.lt\./)

  store.__setSupabaseClientForTest(null)
})

test('CAS: un segundo proceso NO adquiere el lease mientras otro lo tiene (0 filas)', async () => {
  setStandaloneSupabaseEnv()
  const { client } = makeMockClient({ leaseUpdateReturns: () => [] }) // el UPDATE condicional no tocó nada
  const store = await import(`../src/token-store.ts?t=${Date.now()}`)
  store.__setSupabaseClientForTest(client as never)

  const acquired = await store.tryAcquireRefreshLease('test-acct')
  assert.equal(acquired, false, 'sin filas devueltas ⇒ el lease está tomado por otro proceso')

  store.__setSupabaseClientForTest(null)
})

test('CAS: persistRefreshedToken escribe access_token+expires_at y libera el lease', async () => {
  setStandaloneSupabaseEnv()
  const { client, ops } = makeMockClient({})
  const store = await import(`../src/token-store.ts?t=${Date.now()}`)
  store.__setSupabaseClientForTest(client as never)

  await store.persistRefreshedToken('test-acct', {
    accessToken: 'access-nuevo',
    expiresAt: Date.now() + 3600_000,
    refreshToken: 'TG-rotado-xyz',
  })
  const op = ops.find((o) => o.type === 'update')
  assert.ok(op)
  assert.equal(op!.payload!.access_token, 'access-nuevo')
  assert.equal(op!.payload!.refresh_in_progress, false)
  assert.equal(op!.payload!.locked_until, null)
  assert.equal(op!.payload!.refresh_token, 'TG-rotado-xyz')

  store.__setSupabaseClientForTest(null)
})

test('CAS: releaseRefreshLease limpia refresh_in_progress y locked_until', async () => {
  setStandaloneSupabaseEnv()
  const { client, ops } = makeMockClient({})
  const store = await import(`../src/token-store.ts?t=${Date.now()}`)
  store.__setSupabaseClientForTest(client as never)

  await store.releaseRefreshLease('test-acct')
  const op = ops.find((o) => o.type === 'update')
  assert.ok(op)
  assert.equal(op!.payload!.refresh_in_progress, false)
  assert.equal(op!.payload!.locked_until, null)

  store.__setSupabaseClientForTest(null)
})

test('CAS: el flujo de auth con lease adquirido refresca UNA vez, persiste y no loguea el token', async () => {
  setStandaloneSupabaseEnv()
  // Lease libre → lo adquirimos; readTokenRow (SELECT) devuelve null → hay que refrescar.
  const { client } = makeMockClient({
    leaseUpdateReturns: () => [{ account_label: 'test-acct' }],
    selectReturns: () => null,
  })

  // Mock del POST /oauth/token
  const secret = 'TG-refresh-ROTADO-super-secreto-000'
  let refreshCalls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    refreshCalls++
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'access-fresh', expires_in: 21600, refresh_token: secret }),
      text: async () => '',
    } as Response
  }) as typeof fetch

  const logged: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '))
  }

  try {
    // Sin cache-bust: token-store debe ser la MISMA instancia que auth.ts importa
    // internamente, para que el mock inyectado sea visible desde el flujo de auth.
    const store = await import('../src/token-store.ts')
    store.__setSupabaseClientForTest(client as never)
    const auth = await import('../src/auth.ts')
    auth.clearTokenCache()

    const [a, b] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()])
    assert.equal(a, 'access-fresh')
    assert.equal(b, 'access-fresh')
    assert.equal(refreshCalls, 1, 'single-flight: un solo POST a /oauth/token aunque haya 2 callers')

    const leaked = logged.some((l) => l.includes(secret) || l.includes(secret.substring(0, 20)))
    assert.equal(leaked, false, `un log filtró el valor del token: ${JSON.stringify(logged)}`)

    store.__setSupabaseClientForTest(null)
  } finally {
    console.error = originalError
    globalThis.fetch = originalFetch
  }
})
