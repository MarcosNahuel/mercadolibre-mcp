// Capa 1 · price_to_win — "precio para ganar" el buy-box / competencia de catálogo
// de una publicación (READ-ONLY). Portado de meli-seller-mcp (a su vez de
// globalstats-haussman) al patrón server.tool()→content del paquete.
//
// Solo lectura: un GET contra ML → GET /items/{id}/price_to_win?version=v2.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { mlFetch } from '../client.js'

/** Salida estructurada normalizada del análisis price_to_win. */
export interface PriceToWinResult {
  item_id: string
  current_price: number | null
  price_to_win: number | null
  status: string | null
  visit_share: string | null
  boosts: Array<Record<string, unknown>>
  raw: unknown
}

/**
 * Normaliza el payload crudo de ML a la forma estructurada. Función PURA
 * (sin red) para poder testear el mapeo de campos.
 */
export function normalizePriceToWin(
  item_id: string,
  raw: Record<string, unknown>
): PriceToWinResult {
  return {
    item_id,
    current_price: typeof raw.current_price === 'number' ? raw.current_price : null,
    price_to_win: typeof raw.price_to_win === 'number' ? raw.price_to_win : null,
    status: typeof raw.status === 'string' ? raw.status : null,
    visit_share: typeof raw.visit_share === 'string' ? raw.visit_share : null,
    boosts: Array.isArray(raw.boosts) ? (raw.boosts as Array<Record<string, unknown>>) : [],
    raw,
  }
}

export function registerPriceToWin(server: McpServer) {
  server.tool(
    'price_to_win',
    'Precio para ganar el buy-box / competencia de catálogo de una publicación en ' +
      'Mercado Libre (solo lectura). Devuelve precio actual, precio sugerido para ganar, ' +
      'estado de competencia, participación de visitas y boosts que afectan el ranking.',
    {
      item_id: z.string().min(1).describe('ID de la publicación en ML (ej: MLA123456789)'),
    },
    async ({ item_id }) => {
      const raw = await mlFetch<Record<string, unknown>>(
        `/items/${encodeURIComponent(item_id)}/price_to_win`,
        { params: { version: 'v2' } }
      )
      const result = normalizePriceToWin(item_id, raw)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      }
    }
  )
}
