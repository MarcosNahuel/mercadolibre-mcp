// Tests de los candados: el gate debe bloquear tools destructivas/de compra y
// dejar pasar las de gestión legítimas (incluidas las 4 de escritura permitidas).
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  isDestructiveToolName,
  assertToolAllowed,
  guardServer,
  WRITE_TOOL_ALLOWLIST,
} from '../src/tool-guard.ts'

test('isDestructiveToolName: bloquea comprar/borrar/cancelar/pagar (en/es)', () => {
  for (const name of [
    'buy_item',
    'purchase_order',
    'checkout',
    'comprar_producto',
    'delete_item',
    'item_delete',
    'destroy_listing',
    'remove_item',
    'borrar_publicacion',
    'eliminar_orden',
    'cancel_order',
    'cancelar_envio',
    'refund_order',
    'payment_create',
    'pay_seller',
  ]) {
    assert.equal(isDestructiveToolName(name), true, `${name} debería estar bloqueada`)
  }
})

test('isDestructiveToolName: NO bloquea las tools legítimas del paquete', () => {
  for (const name of [
    'list_products',
    'get_orders',
    'update_price',
    'update_stock',
    'list_questions',
    'answer_question',
    'get_item_metrics',
    'manage_ads',
    'get_reputation',
    'search_competitors',
    'get_categories',
    'price_to_win',
    'price_history',
    'stockout_risk',
    'official_search_documentation',
  ]) {
    assert.equal(isDestructiveToolName(name), false, `${name} NO debería bloquearse`)
  }
})

test('WRITE_TOOL_ALLOWLIST: las 4 de escritura permitidas no caen en el denylist', () => {
  for (const name of WRITE_TOOL_ALLOWLIST) {
    assert.equal(isDestructiveToolName(name), false)
  }
})

test('assertToolAllowed: tira para una tool destructiva', () => {
  assert.throws(() => assertToolAllowed('buy_item'), /bloqueada/)
})

test('guardServer: server.tool con nombre destructivo corta el arranque', () => {
  const calls: string[] = []
  const fakeServer = {
    tool: (name: string) => {
      calls.push(name)
    },
    registerTool: (name: string) => {
      calls.push(name)
    },
  }
  const guarded = guardServer(fakeServer as never)

  // Legítima pasa.
  ;(guarded as unknown as { tool: (n: string) => void }).tool('update_price')
  assert.deepEqual(calls, ['update_price'])

  // Destructiva tira.
  assert.throws(
    () => (guarded as unknown as { tool: (n: string) => void }).tool('buy_item'),
    /bloqueada/
  )
  // registerTool también gateado.
  assert.throws(
    () => (guarded as unknown as { registerTool: (n: string) => void }).registerTool('delete_item'),
    /bloqueada/
  )
})
