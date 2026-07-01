// Smoke test de Capa 2: registerTraidLayer no debe tirar y debe registrar
// exactamente las 2 tools prototype de alpha.0 (traid_feature_lookup, traid_client_context).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerTraidLayer } from '../src/layers/traid/index.js'

class FakeServer {
  registered: string[] = []
  tool(name: string, ..._rest: unknown[]) {
    this.registered.push(name)
  }
}

test('registerTraidLayer registra exactamente traid_feature_lookup y traid_client_context', () => {
  const server = new FakeServer()
  assert.doesNotThrow(() => registerTraidLayer(server as never))
  assert.deepEqual(
    [...server.registered].sort(),
    ['traid_client_context', 'traid_feature_lookup'],
  )
})

test('traid_feature_lookup: el handler responde sin lanzar ante query real', async () => {
  const server = new FakeServer()
  let handler: ((args: { query: string; limit?: number; category?: string }) => Promise<unknown>) | null = null
  server.tool = (name: string, _desc: unknown, _schema: unknown, fn: typeof handler) => {
    if (name === 'traid_feature_lookup') handler = fn
  }
  registerTraidLayer(server as never)
  assert.ok(handler, 'handler de traid_feature_lookup no se registro')
  const result = await handler!({ query: 'repricing' })
  assert.ok(result)
})
