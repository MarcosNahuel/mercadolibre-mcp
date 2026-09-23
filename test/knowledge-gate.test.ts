// Gate de release v1.2.0-alpha.0 (SPEC-MASTER.md §8):
// "knowledge snapshot generado del repo, traid_feature_lookup('repricing') devuelve >= 3 hits válidos."
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchFeatures, getClient, loadKnowledge } from '../src/knowledge/loader.js'

test('gate alpha.0: traid_feature_lookup("repricing") devuelve >= 3 hits', () => {
  const hits = searchFeatures('repricing')
  assert.ok(hits.length >= 3, `esperaba >= 3 hits, hubo ${hits.length}`)
  assert.ok(hits[0].score > 0)
  assert.ok(hits[0].entry.slug.length > 0)
})

test('el snapshot bundled no esta vacio (fallback silencioso seria un bug)', () => {
  const snap = loadKnowledge()
  assert.ok(snap.features.length > 0, 'snapshot sin features: revisar data/knowledge.json')
  assert.notEqual(snap.source_commit, 'none', 'snapshot vacio/fallback (EMPTY_SNAPSHOT)')
})

// Contención D-2026-09-23-01: el snapshot que se versiona y empaqueta NUNCA lleva
// fichas de clientes TRAID (nombre/rubro). traid_client_context sin match debe
// devolver la lista vacía, no datos reales. Si este test falla porque `clients`
// dejó de estar vacío, es una regresión de seguridad, no un bug de test.
test('contención: el snapshot NO trae fichas de clientes (clients vacío)', () => {
  const snap = loadKnowledge()
  assert.equal(snap.clients.length, 0, `snapshot con ${snap.clients.length} clientes: no debe versionarse/publicarse con datos de clientes`)
})

test('getClient: cualquier slug devuelve undefined (no hay clients en el snapshot público)', () => {
  assert.equal(getClient('adrian'), undefined)
  assert.equal(getClient('slug-que-no-existe-xyz'), undefined)
})
