#!/usr/bin/env node

// TRAID ML Hub MCP Server (v1.2.0+) — arquitectura de 5 capas
// Spec: knowledge/stack/mcp-traid-ml-hub/SPEC-MASTER.md (en repo CONOCIMIENTO-NAHUEL)
//
//   CAPA 4 · _meta_*    introspection (TBD v1.2.0 GA)
//   CAPA 3 · flow_*     composite workflows opt-in (TBD v1.2.0-rc)
//   CAPA 2 · traid_*    knowledge tools (★ NUEVO en v1.2.0)
//   CAPA 1 · ml_*       endpoints ML hand-coded (las 11 v1.0 + extensiones)
//   CAPA 0 · official_* proxy al MCP oficial ML (v1.1.0)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

// Capa 1 — las 11 tools TRAID (v1.0, preservadas)
import { registerListProducts } from './tools/products.js'
import { registerGetOrders } from './tools/orders.js'
import { registerUpdatePrice } from './tools/pricing.js'
import { registerUpdateStock } from './tools/stock.js'
import { registerListQuestions, registerAnswerQuestion } from './tools/questions.js'
import { registerGetItemMetrics } from './tools/metrics.js'
import { registerManageAds } from './tools/ads.js'
import { registerGetReputation } from './tools/reputation.js'
import { registerSearchCompetitors } from './tools/competitors.js'
import { registerGetCategories } from './tools/categories.js'

// Capa 0 — proxy MCP oficial
import { registerUpstreamProxy } from './upstream-proxy.js'

// Capa 2 — knowledge tools
import { registerTraidLayer } from './layers/traid/index.js'

const PACKAGE_VERSION = '1.2.0-alpha.1'

const server = new McpServer({
  name: 'traid-ml-hub',
  version: PACKAGE_VERSION,
})

// ============================================================================
// Config: qué capas activar
// ============================================================================

const disabledLayers = new Set(
  (process.env.TRAID_DISABLE_LAYERS || '').split(',').map((s) => s.trim()).filter(Boolean)
)
const skipUpstream = process.env.ML_SKIP_UPSTREAM_PROXY === '1' || disabledLayers.has('official')
const skipMl = disabledLayers.has('ml')
const skipTraid = disabledLayers.has('traid')
const skipFlow = disabledLayers.has('flow') || !process.env.TRAID_FLOWS_ENABLED

// ============================================================================
// Capa 1 — ML raw tools (siempre, salvo opt-out)
// ============================================================================

if (!skipMl) {
  registerListProducts(server)
  registerGetOrders(server)
  registerUpdatePrice(server)
  registerUpdateStock(server)
  registerListQuestions(server)
  registerAnswerQuestion(server)
  registerGetItemMetrics(server)
  registerManageAds(server)
  registerGetReputation(server)
  registerSearchCompetitors(server)
  registerGetCategories(server)
}

// ============================================================================
// Capa 2 — Knowledge tools (siempre, salvo opt-out)
// ============================================================================

if (!skipTraid) {
  try {
    registerTraidLayer(server)
  } catch (err) {
    console.error('[traid-ml-hub] Capa 2 (knowledge tools) falló al registrar:', (err as Error).message)
    console.error('[traid-ml-hub]   → las otras capas siguen funcionando. Para correr build:knowledge ver README.')
  }
}

// ============================================================================
// Capa 3 — Flows (opt-in via TRAID_FLOWS_ENABLED, no implementados en alpha.0)
// ============================================================================

// TODO v1.2.0-rc:
// if (!skipFlow) {
//   const enabled = (process.env.TRAID_FLOWS_ENABLED || '').split(',').map(s => s.trim()).filter(Boolean)
//   registerFlowLayer(server, enabled)
// }

// ============================================================================
// Main loop
// ============================================================================

async function main() {
  let proxiedCount = 0
  if (!skipUpstream) {
    proxiedCount = await registerUpstreamProxy(server)
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)

  const capaStatus = [
    !skipUpstream ? `0:official(${proxiedCount})` : '0:off',
    !skipMl ? '1:ml(11)' : '1:off',
    !skipTraid ? '2:traid(2)' : '2:off',
    !skipFlow ? '3:flow(0)' : '3:off',
    '4:meta(0)',
  ].join(' ')

  console.error(
    `[traid-ml-hub] v${PACKAGE_VERSION} iniciado · capas: ${capaStatus}` +
      (process.env.TRAID_CLIENT_SLUG ? ` · client=${process.env.TRAID_CLIENT_SLUG}` : '')
  )
}

main().catch((error) => {
  console.error('[traid-ml-hub] Error fatal:', error)
  process.exit(1)
})
