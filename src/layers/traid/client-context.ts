// Capa 2 — traid_client_context
// Devuelve metadata operativa de un cliente TRAID.
// Spec: knowledge/stack/mcp-traid-ml-hub/spec-capa2-traid-knowledge.md §2.4

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getClient, loadKnowledge } from '../../knowledge/loader.js'
import type { ClientEntry } from '../types.js'

export function registerTraidClientContext(server: McpServer) {
  server.tool(
    'traid_client_context',
    'Devuelve metadata operativa del cliente TRAID actual (seller_ids, schema Supabase, n8n folder, ' +
      'repos, bloqueantes pendientes). Si no se pasa slug, usa TRAID_CLIENT_SLUG env var (auto-detect). ' +
      'Usar al arrancar sesión Claude en un proyecto cliente para cargar contexto sin parsear archivos.',
    {
      slug: z
        .string()
        .optional()
        .describe('Slug del cliente (`adrian`, `pablo`, `hernan`, `lubbi`, etc.). Si se omite, usa TRAID_CLIENT_SLUG.'),
    },
    async ({ slug }) => {
      const effectiveSlug = slug || process.env.TRAID_CLIENT_SLUG

      if (!effectiveSlug) {
        const snap = loadKnowledge()
        const known = snap.clients.map((c) => `- \`${c.slug}\` — ${c.title} (status: ${c.status})`).join('\n')
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `## traid_client_context() — sin slug\n\n` +
                `⚠ No se pasó \`slug\` y \`TRAID_CLIENT_SLUG\` env var no está set.\n\n` +
                `**Clientes conocidos en el knowledge snapshot** (${snap.clients.length}):\n${known || '(ninguno)'}\n\n` +
                `Pasá el slug como argumento, o configurá la env var en tu \`.mcp.json\`:\n` +
                `\`\`\`json\n"env": { "TRAID_CLIENT_SLUG": "adrian" }\n\`\`\``,
            },
          ],
        }
      }

      const client = getClient(effectiveSlug)
      if (!client) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `## traid_client_context("${effectiveSlug}")\n\n` +
                `❌ Cliente \`${effectiveSlug}\` no encontrado en el knowledge snapshot.\n\n` +
                `Verificar que existe \`knowledge/clientes/${effectiveSlug}/README.md\` en CONOCIMIENTO-NAHUEL y ` +
                `regenerar el snapshot con \`npm run build:knowledge\`.`,
            },
          ],
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: formatClientMarkdown(client),
          },
        ],
      }
    }
  )
}

function formatClientMarkdown(c: ClientEntry): string {
  const lines: string[] = [
    `## traid_client_context("${c.slug}")`,
    '',
    `### ${c.title}`,
    `**Status**: ${c.status} | **Canal principal**: ${c.canal_principal}`,
    '',
    `**Site IDs detectados**: ${c.site_ids.length > 0 ? c.site_ids.join(', ') : '(ninguno detectado)'}`,
    '',
    `📖 README completo: \`${c.markdown_path}\``,
    '',
    `> Infraestructura (Supabase/n8n) y bloqueantes de negocio NO viajan en este ` +
      `snapshot público (npm) — leelos del README completo en CONOCIMIENTO-NAHUEL, ` +
      `o corré con \`TRAID_KNOWLEDGE_MODE=filesystem\` sobre ese repo local.`,
  ]

  return lines.join('\n')
}
