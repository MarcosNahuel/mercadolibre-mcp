// Knowledge loader — carga el snapshot JSON con 3 modos.
// Spec: knowledge/stack/mcp-traid-ml-hub/spec-capa2-traid-knowledge.md §5

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  KnowledgeSnapshot,
  FeatureEntry,
  ClientEntry,
  GotchaEntry,
  EndpointEntry,
  PatternEntry,
  SqlSnippetEntry,
  StackAdviceEntry,
  AntiPatternEntry,
  SearchHit,
} from '../layers/types.js'

const EMPTY_SNAPSHOT: KnowledgeSnapshot = {
  version: '0',
  generated_at: '',
  source_commit: 'none',
  features: [],
  clients: [],
  gotchas: [],
  endpoints: [],
  patterns: [],
  sql_snippets: [],
  stack_advice: [],
  anti_patterns: [],
}

let cached: KnowledgeSnapshot | null = null

export function loadKnowledge(): KnowledgeSnapshot {
  if (cached) return cached

  const mode = process.env.TRAID_KNOWLEDGE_MODE || 'bundled'

  try {
    if (mode === 'filesystem') {
      cached = loadFromFilesystem()
    } else if (mode === 'pinecone') {
      // Pinecone mode no implementado en v1.2.0 — fallback a bundled
      console.error('[knowledge] pinecone mode no implementado en v1.2.0, usando bundled fallback')
      cached = loadBundled()
    } else {
      cached = loadBundled()
    }
  } catch (err) {
    console.error(`[knowledge] failed to load ${mode}:`, (err as Error).message)
    cached = EMPTY_SNAPSHOT
  }

  console.error(
    `[knowledge] loaded mode=${mode} commit=${cached.source_commit} ` +
    `features=${cached.features.length} clients=${cached.clients.length} ` +
    `gotchas=${cached.gotchas.length}`
  )

  return cached
}

function loadBundled(): KnowledgeSnapshot {
  // El JSON vive en data/knowledge.json relativo al package root.
  // dist/knowledge/loader.js → dist/../data/knowledge.json = packagedRoot/data/knowledge.json
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(here, '..', '..', 'data', 'knowledge.json'),    // dist/knowledge → ../data
    path.resolve(here, '..', '..', '..', 'data', 'knowledge.json'), // src/knowledge → ../../data
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8')
      return JSON.parse(raw) as KnowledgeSnapshot
    }
  }
  throw new Error(
    `bundled snapshot no encontrado. Buscado en:\n  ${candidates.join('\n  ')}\n` +
    `Si estás en dev, correr: npm run build:knowledge`
  )
}

function loadFromFilesystem(): KnowledgeSnapshot {
  const knowledgePath = process.env.TRAID_KNOWLEDGE_PATH
  if (!knowledgePath) {
    throw new Error('TRAID_KNOWLEDGE_PATH required when TRAID_KNOWLEDGE_MODE=filesystem')
  }
  const jsonPath = path.join(knowledgePath, 'data', 'knowledge.json')
  if (fs.existsSync(jsonPath)) {
    const raw = fs.readFileSync(jsonPath, 'utf-8')
    return JSON.parse(raw) as KnowledgeSnapshot
  }

  // Fallback: si no hay data/ pre-built, buscar uno relativo al MCP package
  const fallback = path.resolve(knowledgePath, '..', 'mercadolibre-mcp', 'data', 'knowledge.json')
  if (fs.existsSync(fallback)) {
    const raw = fs.readFileSync(fallback, 'utf-8')
    return JSON.parse(raw) as KnowledgeSnapshot
  }

  throw new Error(
    `filesystem mode: no se encontró data/knowledge.json en ${knowledgePath} ni en ${fallback}. ` +
    `Correr: python scripts/build_knowledge_snapshot.py --knowledge-root . --output data/knowledge.json`
  )
}

// ============================================================================
// Search helpers — keyword + fuzzy ranking sin deps externas
// ============================================================================

export function searchFeatures(
  query: string,
  opts: { limit?: number; category?: string } = {}
): SearchHit<FeatureEntry>[] {
  const snap = loadKnowledge()
  const limit = opts.limit ?? 5
  const q = query.toLowerCase().trim()

  const hits: SearchHit<FeatureEntry>[] = []

  for (const f of snap.features) {
    if (opts.category && f.category_primary !== opts.category) continue

    let score = 0
    const matched: string[] = []

    // 1. Exact slug
    if (f.slug === query) {
      score = 1.0
      matched.push('slug-exact')
    }

    // 2. Slug fuzzy
    if (f.slug.toLowerCase().includes(q)) {
      score = Math.max(score, 0.7)
      matched.push('slug-fuzzy')
    }

    // 3. Title contains
    if (f.title.toLowerCase().includes(q)) {
      score += 0.5
      matched.push('title')
    }

    // 4. Summary contains
    if (f.summary.toLowerCase().includes(q)) {
      score += 0.3
      matched.push('summary')
    }

    // 5. Category match
    if (f.category_primary.toLowerCase().includes(q)) {
      score += 0.2
      matched.push('category')
    }

    // 6. Tech stack match
    if (f.tech_stack.some((t) => t.toLowerCase().includes(q))) {
      score += 0.2
      matched.push('tech_stack')
    }

    // 7. Repo origin match
    if (f.repos_origin.some((r) => r.toLowerCase().includes(q))) {
      score += 0.15
      matched.push('repo_origin')
    }

    // 8. Reusability boost
    if (f.reusability === 'alta') score += 0.15

    // 9. Status boost (production > staging > wip)
    if (f.status === 'production') score += 0.1

    if (score > 0) {
      hits.push({ entry: f, score: Math.min(score, 2), matched_on: matched })
    }
  }

  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit)
}

export function getFeature(slug: string): FeatureEntry | undefined {
  return loadKnowledge().features.find((f) => f.slug === slug)
}

export function getClient(slug: string): ClientEntry | undefined {
  return loadKnowledge().clients.find((c) => c.slug === slug)
}

export function searchGotchas(query: string, limit = 10): SearchHit<GotchaEntry>[] {
  const snap = loadKnowledge()
  const q = query.toLowerCase().trim()
  const hits: SearchHit<GotchaEntry>[] = []

  for (const g of snap.gotchas) {
    let score = 0
    const matched: string[] = []

    if (g.id.toLowerCase().includes(q)) {
      score += 0.5
      matched.push('id')
    }
    if (g.endpoint_pattern.toLowerCase().includes(q)) {
      score += 0.7
      matched.push('endpoint_pattern')
    }
    if (g.summary.toLowerCase().includes(q)) {
      score += 0.4
      matched.push('summary')
    }
    if (g.workaround.toLowerCase().includes(q)) {
      score += 0.2
      matched.push('workaround')
    }
    if (g.severity === 'alta') score += 0.1

    if (score > 0) hits.push({ entry: g, score, matched_on: matched })
  }

  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit)
}

export function getEndpointsMatching(pattern: string): EndpointEntry[] {
  const snap = loadKnowledge()
  if (!pattern) return snap.endpoints

  const regex = globToRegex(pattern)
  return snap.endpoints.filter((e) => regex.test(e.endpoint))
}

export function getPattern(useCase: string): PatternEntry | undefined {
  const snap = loadKnowledge()
  const q = useCase.toLowerCase().trim()
  // Exact + fuzzy match en use_case
  return (
    snap.patterns.find((p) => p.use_case === useCase) ??
    snap.patterns.find((p) => p.use_case.toLowerCase().includes(q)) ??
    snap.patterns.find((p) =>
      q.split(/\s+/).every((token) => p.use_case.toLowerCase().includes(token))
    )
  )
}

export function getSqlSnippet(domain: string): SqlSnippetEntry | undefined {
  return loadKnowledge().sql_snippets.find((s) => s.domain === domain)
}

export function getStackAdvice(component: string): StackAdviceEntry | undefined {
  return loadKnowledge().stack_advice.find((s) => s.component === component)
}

export function checkAntiPatterns(description: string): Array<{
  entry: AntiPatternEntry
  confidence: number
  matched_keywords: string[]
}> {
  const snap = loadKnowledge()
  const desc = description.toLowerCase()
  const results: Array<{ entry: AntiPatternEntry; confidence: number; matched_keywords: string[] }> = []

  for (const ap of snap.anti_patterns) {
    const matchedKeywords = ap.keywords.filter((k) => desc.includes(k.toLowerCase()))
    if (matchedKeywords.length === 0) continue

    // Confidence = ratio de keywords matched
    const confidence = Math.min(matchedKeywords.length / Math.max(ap.keywords.length, 1) + 0.2, 1)
    results.push({ entry: ap, confidence, matched_keywords: matchedKeywords })
  }

  results.sort((a, b) => b.confidence - a.confidence)
  return results
}

// ============================================================================
// Internals
// ============================================================================

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(escaped, 'i')
}
