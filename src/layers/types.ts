// Tipos compartidos del MCP TRAID ML Hub (v1.2.0+).
// Define interfaces para la arquitectura de 5 capas.
// Spec: knowledge/stack/mcp-traid-ml-hub/SPEC-MASTER.md

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export type LayerName = 'official' | 'ml' | 'traid' | 'flow' | 'meta'

export interface LayerConfig {
  name: LayerName
  enabled: boolean
  register: (server: McpServer) => Promise<void> | void
}

// ============================================================================
// Capa 2 — Knowledge tools — shape del snapshot (mirror del spec-capa2 §3)
// ============================================================================

export interface KnowledgeSnapshot {
  version: string
  generated_at: string
  source_commit: string
  features: FeatureEntry[]
  clients: ClientEntry[]
  gotchas: GotchaEntry[]
  endpoints: EndpointEntry[]
  patterns: PatternEntry[]
  sql_snippets: SqlSnippetEntry[]
  stack_advice: StackAdviceEntry[]
  anti_patterns: AntiPatternEntry[]
}

export interface FeatureEntry {
  slug: string
  title: string
  summary: string
  category_primary: 'DATOS' | 'AUTOMATIZACION' | 'SOFTWARE' | 'N8N' | 'BOTS' | 'STACK'
  category_secondary: string[]
  repos_origin: string[]
  reusability: 'alta' | 'media' | 'baja'
  status: 'production' | 'staging' | 'wip'
  files_main: string[]
  tech_stack: string[]
  trade_offs: { pros: string[]; cons: string[] }
  how_to_reuse: string
  related_features: string[]
  markdown_path: string
}

// Vista PUBLICA de un cliente TRAID (este snapshot se bundlea en el paquete npm
// publico). NUNCA debe llevar infraestructura interna (supabase_project/schema,
// n8n_folder/project, repo_local) ni texto de negocio (blockers) -- eso se filtro en
// 1.2.0-alpha.0 (publicado 2026-05-29, deprecado). Ver mercadolibre-mcp/CHANGELOG.md.
export interface ClientEntry {
  slug: string
  title: string
  status: 'lead' | 'draft' | 'active' | 'handoff' | 'archived'
  canal_principal: string
  site_ids: string[]
  markdown_path: string
}

export interface GotchaEntry {
  id: string
  endpoint_pattern: string
  summary: string
  workaround: string
  source: string
  validated_at: string
  severity: 'alta' | 'media' | 'baja'
}

export interface EndpointEntry {
  endpoint: string
  status: 'validated_200' | 'exclusive_global_selling' | 'deprecated' | 'broken' | 'unvalidated'
  returns: string[]
  gotchas: string[]
  use_cases: string[]
  last_validated_at?: string | null
  validated_in_seller?: string | null
}

export interface PatternEntry {
  use_case: string
  feature_slug: string
  key_files: string[]
  tldr: string
  when_to_use: string[]
  when_not_to_use: string[]
  example_implementations: string[]
}

export interface SqlSnippetEntry {
  domain: string
  sql: string
  source_feature: string
  dependencies: string[]
  notes?: string | null
}

export interface StackAdviceEntry {
  component: string
  pick: string
  why: string
  alternatives: Array<{ name: string; when: string }>
  anti_picks: Array<{ name: string; why: string }>
  source: string
}

export interface AntiPatternEntry {
  id: string
  summary: string
  why_fails: string
  solution: string
  keywords: string[]
}

// ============================================================================
// Search result types
// ============================================================================

export interface SearchHit<T> {
  entry: T
  score: number
  matched_on: string[]
}
