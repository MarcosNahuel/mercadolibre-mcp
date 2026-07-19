// Tests de la LÓGICA (matemática/normalización) de las 3 analytics porteadas.
// No tocan la red: ejercitan las funciones puras exportadas por cada tool.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyRisk,
  aggregateStockoutRisk,
  type ItemDetail,
} from '../src/tools/stockout_risk.ts'
import { normalizePriceToWin } from '../src/tools/price_to_win.ts'
import { normalizePriceHistory } from '../src/tools/price_history.ts'

const TH = { critical_days: 7, warning_days: 21 }

// ----------------------------- classifyRisk -----------------------------

test('classifyRisk: stock 0 ⇒ critico con cobertura 0 (ya quebrado)', () => {
  assert.deepEqual(classifyRisk(0, 5, TH), { risk: 'critico', coverage: 0 })
})

test('classifyRisk: velocidad 0 ⇒ sin_riesgo, cobertura null (no rota)', () => {
  assert.deepEqual(classifyRisk(100, 0, TH), { risk: 'sin_riesgo', coverage: null })
})

test('classifyRisk: cobertura ≤ critical ⇒ critico', () => {
  // 10 unidades, 2/día ⇒ 5 días de cobertura ≤ 7
  assert.deepEqual(classifyRisk(10, 2, TH), { risk: 'critico', coverage: 5 })
})

test('classifyRisk: critical < cobertura ≤ warning ⇒ alto', () => {
  // 30 / 2 = 15 días (7 < 15 ≤ 21)
  assert.deepEqual(classifyRisk(30, 2, TH), { risk: 'alto', coverage: 15 })
})

test('classifyRisk: warning < cobertura ≤ 2·warning ⇒ medio', () => {
  // 60 / 2 = 30 días (21 < 30 ≤ 42)
  assert.deepEqual(classifyRisk(60, 2, TH), { risk: 'medio', coverage: 30 })
})

test('classifyRisk: cobertura > 2·warning ⇒ bajo', () => {
  // 200 / 2 = 100 días (> 42)
  assert.deepEqual(classifyRisk(200, 2, TH), { risk: 'bajo', coverage: 100 })
})

// ----------------------------- aggregateStockoutRisk -----------------------------

test('aggregateStockoutRisk: cuenta por nivel, ordena por severidad y respeta include_no_sales', () => {
  const ids = ['A', 'B', 'C', 'D']
  const details = new Map<string, ItemDetail>([
    ['A', { title: 'Crítico', available_quantity: 4, status: 'active' }], // 4/ (28/28=1) ⇒ cov 4 ⇒ critico
    ['B', { title: 'Bajo', available_quantity: 300, status: 'active' }], // cov alta ⇒ bajo
    ['C', { title: 'Sin ventas', available_quantity: 50, status: 'active' }], // 0 ventas ⇒ sin_riesgo
    ['D', { title: 'Borrado', available_quantity: 10, status: 'active' }], // sin detalle? no, presente
  ])
  const units = new Map<string, number>([
    ['A', 28], // 28 unidades / 28 días = 1/día ⇒ cobertura 4
    ['B', 28],
    ['C', 0],
    ['D', 28], // 10 / 1 = 10 días ⇒ alto
  ])
  const { rows, counts, total } = aggregateStockoutRisk(ids, details, units, {
    window_days: 28,
    critical_days: 7,
    warning_days: 21,
    include_no_sales: true,
  })

  assert.equal(total, 4)
  assert.equal(counts.critico, 1)
  assert.equal(counts.alto, 1)
  assert.equal(counts.bajo, 1)
  assert.equal(counts.sin_riesgo, 1)
  // El más urgente primero.
  assert.equal(rows[0].item_id, 'A')
  assert.equal(rows[0].risk, 'critico')
})

test('aggregateStockoutRisk: include_no_sales=false descarta ítems sin ventas', () => {
  const ids = ['A', 'B']
  const details = new Map<string, ItemDetail>([
    ['A', { available_quantity: 10, status: 'active' }],
    ['B', { available_quantity: 10, status: 'active' }],
  ])
  const units = new Map<string, number>([['A', 28]]) // B sin ventas
  const { rows, total } = aggregateStockoutRisk(ids, details, units, {
    window_days: 28,
    critical_days: 7,
    warning_days: 21,
    include_no_sales: false,
  })
  assert.equal(total, 1)
  assert.equal(rows[0].item_id, 'A')
})

test('aggregateStockoutRisk: ítem sin detalle (borrado entre search y multiget) se saltea', () => {
  const ids = ['A', 'GHOST']
  const details = new Map<string, ItemDetail>([['A', { available_quantity: 5, status: 'active' }]])
  const units = new Map<string, number>([['A', 28], ['GHOST', 28]])
  const { total } = aggregateStockoutRisk(ids, details, units, {
    window_days: 28,
    critical_days: 7,
    warning_days: 21,
    include_no_sales: true,
  })
  assert.equal(total, 1, 'GHOST no tiene detalle ⇒ no se evalúa')
})

// ----------------------------- normalizePriceToWin -----------------------------

test('normalizePriceToWin: mapea campos presentes y tolera ausentes', () => {
  const out = normalizePriceToWin('MLA1', {
    current_price: 1000,
    price_to_win: 950,
    status: 'competing',
    visit_share: '0.42',
    boosts: [{ id: 'shipping' }],
  })
  assert.equal(out.current_price, 1000)
  assert.equal(out.price_to_win, 950)
  assert.equal(out.status, 'competing')
  assert.equal(out.visit_share, '0.42')
  assert.equal(out.boosts.length, 1)
})

test('normalizePriceToWin: campos faltantes o de tipo inesperado ⇒ null / []', () => {
  const out = normalizePriceToWin('MLA1', { status: 123 as unknown as string })
  assert.equal(out.current_price, null)
  assert.equal(out.price_to_win, null)
  assert.equal(out.status, null) // 123 no es string
  assert.deepEqual(out.boosts, [])
})

// ----------------------------- normalizePriceHistory -----------------------------

test('normalizePriceHistory: usa events si está, sino results', () => {
  const withEvents = normalizePriceHistory('MLA1', { events: [{ p: 1 }, { p: 2 }] })
  assert.equal(withEvents.count, 2)
  const withResults = normalizePriceHistory('MLA1', { results: [{ p: 3 }] })
  assert.equal(withResults.count, 1)
  const empty = normalizePriceHistory('MLA1', {})
  assert.equal(empty.count, 0)
  assert.deepEqual(empty.events, [])
})
