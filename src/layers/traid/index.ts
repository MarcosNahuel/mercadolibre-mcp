// Capa 2 — registro de knowledge tools.
// Spec: knowledge/stack/mcp-traid-ml-hub/spec-capa2-traid-knowledge.md

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerTraidFeatureLookup } from './feature-lookup.js'
import { registerTraidClientContext } from './client-context.js'

/**
 * Registra todas las tools de Capa 2 en el server MCP.
 * En v1.2.0-alpha.0 sólo están implementadas 2 (feature_lookup + client_context).
 * El resto (pattern_for, gotcha_search, endpoint_catalog, sql_snippet, stack_advice, anti_pattern_check)
 * llegan en v1.2.0-alpha.1.
 */
export function registerTraidLayer(server: McpServer): void {
  registerTraidFeatureLookup(server)
  registerTraidClientContext(server)
  // TODO v1.2.0-alpha.1:
  // registerTraidGotchaSearch(server)
  // registerTraidPatternFor(server)
  // registerTraidEndpointCatalog(server)
  // registerTraidSqlSnippet(server)
  // registerTraidStackAdvice(server)
  // registerTraidAntiPatternCheck(server)
}
