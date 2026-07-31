// Capa 1 · price_history — historial de cambios de precio de una publicación
// (READ-ONLY). Portado de meli-seller-mcp (a su vez de globalstats-haussman) al
// patrón server.tool()→content del paquete.
//
// Endpoint: GET /pricing-automation/items/{item_id}/price/history
//   - Es una LECTURA pura (GET): expone el histórico de cambios de precio.
//   - NO es una operación de ESCRITURA de pricing-automation (crear/editar reglas
//     de precio automático): eso queda fuera de esta tool.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { mlFetch } from '../client.js'

export type PriceHistoryEvent = Record<string, unknown>

/** Respuesta cruda del endpoint (ML alterna entre `events` y `results`). */
export interface RawPriceHistory {
  events?: unknown[]
  results?: unknown[]
  paging?: Record<string, unknown>
}

export interface PriceHistoryResult {
  item_id: string
  count: number
  events: PriceHistoryEvent[]
  paging?: Record<string, unknown>
}

/**
 * Normaliza el payload crudo (ML alterna `events`/`results`). Función PURA
 * (sin red) para poder testear el mapeo.
 */
export function normalizePriceHistory(
  item_id: string,
  raw: RawPriceHistory
): PriceHistoryResult {
  const events = (raw.events ?? raw.results ?? []) as PriceHistoryEvent[]
  return { item_id, count: events.length, events, paging: raw.paging }
}

export function registerPriceHistory(server: McpServer) {
  server.tool(
    'price_history',
    'Historial de cambios de precio de una publicación de Mercado Libre (solo lectura). ' +
      'Devuelve los eventos de cambio de precio del item en una ventana de días, paginados. ' +
      'Requiere item_id; days/page/size son opcionales.',
    {
      item_id: z.string().min(1).describe('ID de la publicación en ML (ej: MLA123456789)'),
      days: z.number().int().min(1).max(180).default(30).describe('Ventana del histórico en días (1-180, default 30)'),
      page: z.number().int().min(0).default(0).describe('Página (0-based) del paginado del endpoint'),
      size: z.number().int().min(1).max(200).default(50).describe('Tamaño de página (1-200, default 50)'),
    },
    async ({ item_id, days, page, size }) => {
      const raw = await mlFetch<RawPriceHistory>(
        `/pricing-automation/items/${encodeURIComponent(item_id)}/price/history`,
        { params: { days, page, size } }
      )
      const result = normalizePriceHistory(item_id, raw)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      }
    }
  )
}
