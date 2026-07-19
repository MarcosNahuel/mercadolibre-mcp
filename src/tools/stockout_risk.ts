// Capa 1 · stockout_risk — riesgo de quiebre de stock por publicación (READ-ONLY).
// Portado de meli-seller-mcp (replica la lógica de la vista `max_v_stockout_risk`
// de globalstats-haussman, pero calculada en vivo desde la API de ML).
//
//   velocidad_dia   = unidades_vendidas_en_ventana / dias_de_ventana
//   dias_cobertura  = stock_disponible / velocidad_dia      (∞ si no rota)
//   riesgo          = clasificación por umbrales sobre dias_cobertura
//
// Fuentes ML (todas GET):
//   - GET /users/me                          → seller_id (si no se pasa override)
//   - GET /orders/search?seller=…&date_from… → unidades vendidas por ítem (paginado)
//   - GET /users/{id}/items/search           → ids de publicaciones del seller (paginado)
//   - GET /items?ids=…&attributes=…          → stock + título + estado (multiget)

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { mlFetch, mlGetAll } from '../client.js'

const DAY_MS = 86_400_000
/** Cuántos ids admite el multiget `/items?ids=` por llamada. */
const MULTIGET_CHUNK = 20

export type RiskLevel = 'critico' | 'alto' | 'medio' | 'bajo' | 'sin_riesgo'

export interface StockoutRiskRow {
  item_id: string
  title: string
  status: string
  available_quantity: number
  units_sold_window: number
  velocity_per_day: number
  /** Días hasta el quiebre al ritmo actual. `null` ⇒ no rota (cobertura infinita). */
  days_of_coverage: number | null
  risk: RiskLevel
}

export interface StockoutRiskResult {
  seller_id: number
  window_days: number
  from: string
  to: string
  thresholds: { critical_days: number; warning_days: number }
  generated_at: string
  total_items_evaluated: number
  counts_by_risk: Record<RiskLevel, number>
  items: StockoutRiskRow[]
}

const RISK_SEVERITY: Record<RiskLevel, number> = {
  critico: 0,
  alto: 1,
  medio: 2,
  bajo: 3,
  sin_riesgo: 4,
}

// --------------------------- lógica pura (testeable) ---------------------------

/**
 * Clasifica el riesgo de quiebre a partir de stock y velocidad de venta. PURA.
 *   - stock ≤ 0            ⇒ critico (cobertura 0, ya quebrado)
 *   - velocidad ≤ 0        ⇒ sin_riesgo (no rota, cobertura infinita/null)
 *   - cobertura ≤ critical ⇒ critico ; ≤ warning ⇒ alto ; ≤ 2·warning ⇒ medio ; resto ⇒ bajo
 */
export function classifyRisk(
  stock: number,
  velocity: number,
  thresholds: { critical_days: number; warning_days: number }
): { risk: RiskLevel; coverage: number | null } {
  if (stock <= 0) return { risk: 'critico', coverage: 0 }
  if (velocity <= 0) return { risk: 'sin_riesgo', coverage: null }

  const coverage = stock / velocity
  const { critical_days, warning_days } = thresholds
  let risk: RiskLevel
  if (coverage <= critical_days) risk = 'critico'
  else if (coverage <= warning_days) risk = 'alto'
  else if (coverage <= warning_days * 2) risk = 'medio'
  else risk = 'bajo'

  return { risk, coverage }
}

export interface ItemDetail {
  title?: string
  available_quantity?: number
  status?: string
}

export interface AggregateArgs {
  window_days: number
  critical_days: number
  warning_days: number
  include_no_sales: boolean
  limit?: number
}

/**
 * Construye las filas de riesgo, cuenta por nivel y ordena por severidad. PURA
 * (sin red): recibe los ids, el detalle por id, las unidades vendidas por id y
 * los parámetros. Ésta es la matemática que testeamos.
 */
export function aggregateStockoutRisk(
  itemIds: string[],
  details: Map<string, ItemDetail>,
  unitsSold: Map<string, number>,
  args: AggregateArgs
): { rows: StockoutRiskRow[]; counts: Record<RiskLevel, number>; total: number } {
  const thresholds = { critical_days: args.critical_days, warning_days: args.warning_days }
  const counts: Record<RiskLevel, number> = {
    critico: 0,
    alto: 0,
    medio: 0,
    bajo: 0,
    sin_riesgo: 0,
  }
  const rows: StockoutRiskRow[] = []

  for (const itemId of itemIds) {
    const body = details.get(itemId)
    if (!body) continue // ítem inaccesible/borrado entre el search y el multiget

    const stock = body.available_quantity ?? 0
    const unitsWindow = unitsSold.get(itemId) ?? 0
    if (!args.include_no_sales && unitsWindow <= 0) continue

    const velocity = unitsWindow / args.window_days
    const { risk, coverage } = classifyRisk(stock, velocity, thresholds)

    counts[risk] += 1
    rows.push({
      item_id: itemId,
      title: body.title ?? '',
      status: body.status ?? 'unknown',
      available_quantity: stock,
      units_sold_window: unitsWindow,
      velocity_per_day: round(velocity, 4),
      days_of_coverage: coverage === null ? null : round(coverage, 2),
      risk,
    })
  }

  // Más urgente primero: por severidad, luego por menor cobertura.
  rows.sort((a, b) => {
    const sev = RISK_SEVERITY[a.risk] - RISK_SEVERITY[b.risk]
    if (sev !== 0) return sev
    const ca = a.days_of_coverage ?? Number.POSITIVE_INFINITY
    const cb = b.days_of_coverage ?? Number.POSITIVE_INFINITY
    return ca - cb
  })

  return { rows, counts, total: rows.length }
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}

// --------------------------- fetching (ML) ---------------------------

interface MlOrderItemLine {
  item: { id: string; title?: string }
  quantity: number
}
interface MlOrder {
  id: number
  status: string
  order_items: MlOrderItemLine[]
}
interface MlMultiGetEntry {
  code: number
  body: { id: string; title?: string; available_quantity?: number; status?: string }
}

/** Suma unidades vendidas por item_id en la ventana (excluye órdenes canceladas). */
async function fetchUnitsSold(
  sellerId: number,
  fromIso: string,
  toIso: string
): Promise<Map<string, number>> {
  const orders = await mlGetAll<MlOrder>('/orders/search', {
    seller: sellerId,
    'order.date_created.from': fromIso,
    'order.date_created.to': toIso,
    sort: 'date_desc',
  })

  const units = new Map<string, number>()
  for (const order of orders) {
    if (order.status === 'cancelled') continue
    for (const line of order.order_items ?? []) {
      const id = line.item?.id
      if (!id) continue
      units.set(id, (units.get(id) ?? 0) + (line.quantity ?? 0))
    }
  }
  return units
}

/** Lista los ids de publicaciones del seller (paginado), filtrando por estado. */
async function fetchItemIds(sellerId: number, status: 'active' | 'paused' | 'all'): Promise<string[]> {
  const params: Record<string, string | number> = {}
  if (status !== 'all') params.status = status
  return mlGetAll<string>(`/users/${sellerId}/items/search`, params)
}

/** Trae stock/título/estado en lotes via multiget `/items?ids=`. */
async function fetchItemDetails(itemIds: string[]): Promise<Map<string, ItemDetail>> {
  const byId = new Map<string, ItemDetail>()
  for (let i = 0; i < itemIds.length; i += MULTIGET_CHUNK) {
    const chunk = itemIds.slice(i, i + MULTIGET_CHUNK)
    const entries = await mlFetch<MlMultiGetEntry[]>('/items', {
      params: { ids: chunk.join(','), attributes: 'id,title,available_quantity,status' },
    })
    for (const entry of entries) {
      if (entry.code === 200 && entry.body?.id) byId.set(entry.body.id, entry.body)
    }
  }
  return byId
}

async function resolveSellerId(override: number | undefined): Promise<number> {
  if (override) return override
  const me = await mlFetch<{ id: number }>('/users/me')
  return me.id
}

export function registerStockoutRisk(server: McpServer) {
  server.tool(
    'stockout_risk',
    'Riesgo de quiebre de stock por publicación: días de cobertura y velocidad de ' +
      'venta (unidades/día) sobre una ventana histórica. Read-only, calculado en vivo ' +
      'desde la API de Mercado Libre (órdenes + stock). Sin escrituras.',
    {
      window_days: z.number().int().min(7).max(365).default(90).describe('Ventana histórica (días) para medir la velocidad de venta'),
      critical_days: z.number().positive().default(7).describe('Días de cobertura ≤ este umbral ⇒ riesgo critico'),
      warning_days: z.number().positive().default(21).describe('Días de cobertura ≤ este umbral (y > critical) ⇒ riesgo alto'),
      status: z.enum(['active', 'paused', 'all']).default('active').describe('Estado de las publicaciones a evaluar'),
      include_no_sales: z.boolean().default(true).describe('Si es false, descarta ítems sin ventas en la ventana'),
      limit: z.number().int().min(1).max(5000).optional().describe('Corta el array items a los N de mayor riesgo (no afecta los conteos)'),
      seller_id: z.number().int().positive().optional().describe('Override del seller_id (default: el de /users/me del token)'),
    },
    async ({ window_days, critical_days, warning_days, status, include_no_sales, limit, seller_id }) => {
      if (warning_days <= critical_days) {
        return {
          content: [{ type: 'text' as const, text: 'Input inválido: warning_days debe ser mayor que critical_days.' }],
          isError: true,
        }
      }

      const to = new Date()
      const from = new Date(to.getTime() - window_days * DAY_MS)
      const fromIso = from.toISOString()
      const toIso = to.toISOString()

      const sellerId = await resolveSellerId(seller_id)

      // 1) Velocidad (ventas en la ventana) y 2) catálogo del seller, en paralelo.
      const [unitsSold, itemIds] = await Promise.all([
        fetchUnitsSold(sellerId, fromIso, toIso),
        fetchItemIds(sellerId, status),
      ])
      // 3) Stock/título/estado de esas publicaciones.
      const details = await fetchItemDetails(itemIds)

      const { rows, counts, total } = aggregateStockoutRisk(itemIds, details, unitsSold, {
        window_days,
        critical_days,
        warning_days,
        include_no_sales,
        limit,
      })
      const items = limit ? rows.slice(0, limit) : rows

      const result: StockoutRiskResult = {
        seller_id: sellerId,
        window_days,
        from: fromIso,
        to: toIso,
        thresholds: { critical_days, warning_days },
        generated_at: toIso,
        total_items_evaluated: total,
        counts_by_risk: counts,
        items,
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      }
    }
  )
}
