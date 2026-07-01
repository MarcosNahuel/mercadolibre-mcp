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
  assert.ok(snap.clients.length > 0, 'snapshot sin clients')
  assert.notEqual(snap.source_commit, 'none', 'snapshot vacio/fallback (EMPTY_SNAPSHOT)')
})

test('traid_client_context: getClient devuelve datos para un slug conocido', () => {
  const snap = loadKnowledge()
  const anySlug = snap.clients[0]?.slug
  assert.ok(anySlug, 'no hay clients en el snapshot')
  const client = getClient(anySlug)
  assert.ok(client)
  assert.equal(client?.slug, anySlug)
})

test('getClient: slug inexistente devuelve undefined (no lanza)', () => {
  assert.equal(getClient('slug-que-no-existe-xyz'), undefined)
})
