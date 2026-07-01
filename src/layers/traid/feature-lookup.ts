// Capa 2 — traid_feature_lookup
// Busca features reusables en knowledge/features/ del repo CONOCIMIENTO-NAHUEL.
// Spec: knowledge/stack/mcp-traid-ml-hub/spec-capa2-traid-knowledge.md §2.1

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { searchFeatures } from '../../knowledge/loader.js'
import type { FeatureEntry, SearchHit } from '../types.js'

export function registerTraidFeatureLookup(server: McpServer) {
  server.tool(
    'traid_feature_lookup',
    'Busca features reusables del catálogo TRAID (155+ features auditadas en 10 repos cliente). ' +
      'Devuelve top N matches con descripción, dónde se implementó, cómo reusar, trade-offs. ' +
      'Usar para no reinventar la rueda en proyectos nuevos. ' +
      'Ej: query="repricing" → motor-repricing-semaforo-7-estados (lubbi-erp).',
    {
      query: z.string().describe('Slug exacto, keyword o frase descriptiva (ej: "repricing", "oauth multi tenant ml", "bot preventa")'),
      limit: z.number().int().min(1).max(10).default(5).optional().describe('Máx hits a devolver (default 5)'),
      category: z
        .enum(['DATOS', 'AUTOMATIZACION', 'SOFTWARE', 'N8N', 'BOTS', 'STACK'])
        .optional()
        .describe('Filtrar por categoría primaria'),
    },
    async ({ query, limit, category }) => {
      const hits = searchFeatures(query, { limit: limit ?? 5, category })

      if (hits.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `## traid_feature_lookup("${query}")\n\n` +
                `❌ Sin matches.\n\n` +
                `Sugerencias:\n` +
                `- Probar con keywords más amplias (ej: "pricing" en vez de "repricing semáforo lubbi")\n` +
                `- Quitar el filtro de category si lo usaste\n` +
                `- Buscar gotcha relacionado con \`traid_gotcha_search\`\n` +
                `- Ver patrón con \`traid_pattern_for\``,
            },
          ],
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: formatHitsMarkdown(query, hits, category),
          },
        ],
      }
    }
  )
}

function formatHitsMarkdown(
  query: string,
  hits: SearchHit<FeatureEntry>[],
  category?: string
): string {
  const lines: string[] = [
    `## traid_feature_lookup("${query}"${category ? `, category=${category}` : ''}) — ${hits.length} match${hits.length === 1 ? '' : 'es'}`,
    '',
  ]

  hits.forEach((hit, i) => {
    const f = hit.entry
    const scoreEmoji = hit.score >= 0.9 ? '⭐' : hit.score >= 0.6 ? '✓' : '·'
    lines.push(`### ${i + 1}. ${f.title} ${scoreEmoji} score=${hit.score.toFixed(2)}`)
    lines.push(
      `**Slug**: \`${f.slug}\` | **Repo origen**: ${f.repos_origin.join(', ') || 'n/a'} | ` +
        `**Categoría**: ${f.category_primary} | **Reusabilidad**: ${f.reusability} | **Estado**: ${f.status}`
    )
    lines.push('')
    if (f.summary) {
      lines.push(f.summary.length > 280 ? f.summary.slice(0, 280) + '…' : f.summary)
      lines.push('')
    }

    if (f.files_main.length > 0) {
      lines.push(`**Archivos clave**:`)
      f.files_main.slice(0, 6).forEach((file) => lines.push(`- \`${file}\``))
      if (f.files_main.length > 6) lines.push(`- _(+${f.files_main.length - 6} más)_`)
      lines.push('')
    }

    if (f.trade_offs.pros.length > 0 || f.trade_offs.cons.length > 0) {
      if (f.trade_offs.pros.length > 0) {
        lines.push(`**Pros**: ${f.trade_offs.pros.slice(0, 3).join(' · ')}`)
      }
      if (f.trade_offs.cons.length > 0) {
        lines.push(`**Contras**: ${f.trade_offs.cons.slice(0, 3).join(' · ')}`)
      }
      lines.push('')
    }

    if (f.how_to_reuse) {
      const reuse = f.how_to_reuse.length > 500 ? f.how_to_reuse.slice(0, 500) + '…' : f.how_to_reuse
      lines.push(`**Cómo reusar**:`)
      lines.push(reuse)
      lines.push('')
    }

    lines.push(`📖 Memo completo: \`${f.markdown_path}\``)
    lines.push(`_(matched on: ${hit.matched_on.join(', ')})_`)
    lines.push('')
    lines.push('---')
    lines.push('')
  })

  return lines.join('\n').trim()
}
