// Tests de los candados: el gate debe bloquear tools destructivas/de compra y
// dejar pasar las de gestión legítimas (incluidas las 4 de escritura permitidas).
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  isDestructiveToolName,
  isWriteToolName,
  areWritesEnabled,
  assertToolAllowed,
  guardServer,
  WRITE_TOOL_ALLOWLIST,
} from '../src/tool-guard.ts'

/** Guarda/restaura ML_WRITES_ENABLED para no filtrar estado entre tests. */
function withWritesEnv(value: string | undefined, fn: () => void) {
  const prev = process.env.ML_WRITES_ENABLED
  if (value === undefined) delete process.env.ML_WRITES_ENABLED
  else process.env.ML_WRITES_ENABLED = value
  try {
    fn()
  } finally {
    if (prev === undefined) delete process.env.ML_WRITES_ENABLED
    else process.env.ML_WRITES_ENABLED = prev
  }
}

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
  withWritesEnv('1', () => {
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

    // Legítima pasa (con ML_WRITES_ENABLED=1).
    ;(guarded as unknown as { tool: (n: string) => void }).tool('update_price')
    assert.deepEqual(calls, ['update_price'])

    // Destructiva tira, incluso con escrituras habilitadas.
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
})

// ============================================================================
// Candado de escritura por defecto (contención D-2026-09-23-01)
// ============================================================================

test('areWritesEnabled: default OFF sin la env var', () => {
  withWritesEnv(undefined, () => {
    assert.equal(areWritesEnabled(), false)
  })
})

test('areWritesEnabled: OFF con valores basura, ON sólo con "1"/"true"', () => {
  withWritesEnv('0', () => assert.equal(areWritesEnabled(), false))
  withWritesEnv('false', () => assert.equal(areWritesEnabled(), false))
  withWritesEnv('yes', () => assert.equal(areWritesEnabled(), false))
  withWritesEnv('', () => assert.equal(areWritesEnabled(), false))
  withWritesEnv('1', () => assert.equal(areWritesEnabled(), true))
  withWritesEnv('true', () => assert.equal(areWritesEnabled(), true))
  withWritesEnv('TRUE', () => assert.equal(areWritesEnabled(), true))
  withWritesEnv(' 1 ', () => assert.equal(areWritesEnabled(), true))
})

test('isWriteToolName: reconoce exactamente las 4 de WRITE_TOOL_ALLOWLIST', () => {
  for (const name of WRITE_TOOL_ALLOWLIST) {
    assert.equal(isWriteToolName(name), true, `${name} debería ser write tool`)
  }
  for (const name of ['list_products', 'get_orders', 'price_to_win', 'official_search_documentation']) {
    assert.equal(isWriteToolName(name), false, `${name} NO debería ser write tool`)
  }
})

test('assertToolAllowed: bloquea las 4 tools de escritura sin ML_WRITES_ENABLED (default read-only)', () => {
  withWritesEnv(undefined, () => {
    for (const name of WRITE_TOOL_ALLOWLIST) {
      assert.throws(
        () => assertToolAllowed(name),
        /read-only|deshabilitada/,
        `${name} debería estar bloqueada sin ML_WRITES_ENABLED`
      )
    }
  })
})

test('assertToolAllowed: las 4 de escritura pasan con ML_WRITES_ENABLED=1', () => {
  withWritesEnv('1', () => {
    for (const name of WRITE_TOOL_ALLOWLIST) {
      assert.doesNotThrow(() => assertToolAllowed(name), `${name} no debería bloquearse con el flag en 1`)
    }
  })
})

test('assertToolAllowed: tools de sólo lectura nunca se bloquean por el candado de escritura', () => {
  withWritesEnv(undefined, () => {
    for (const name of ['list_products', 'get_orders', 'get_reputation', 'price_to_win']) {
      assert.doesNotThrow(() => assertToolAllowed(name))
    }
  })
})

test('guardServer: registra una write tool sin candado -- este test MUERDE si alguien apaga el gate', () => {
  // Prueba adversarial: simula el escenario que la contención prohíbe -- una tool
  // de escritura registrándose sin ML_WRITES_ENABLED. Si `assertToolAllowed` (o el
  // proxy de `guardServer`) se rompe/comenta, este test deja de tirar y falla acá.
  withWritesEnv(undefined, () => {
    const fakeServer = {
      tool: (_name: string) => {
        /* no-op: si llega hasta acá sin tirar, el candado no mordió */
      },
    }
    const guarded = guardServer(fakeServer as never)
    for (const name of WRITE_TOOL_ALLOWLIST) {
      assert.throws(
        () => (guarded as unknown as { tool: (n: string) => void }).tool(name),
        /read-only|deshabilitada/,
        `guardServer dejó pasar '${name}' sin ML_WRITES_ENABLED -- candado roto`
      )
    }
  })
})
