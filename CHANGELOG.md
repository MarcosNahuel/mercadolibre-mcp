# Changelog

Todas las versiones de `@nahuelalbornoz/mercadolibre-mcp` en orden inverso.

## [1.2.0-alpha.1] — 2026-07-01

> Publicada bajo el dist-tag `alpha` (no `latest`) — instalar explícitamente con
> `npx @nahuelalbornoz/mercadolibre-mcp@alpha`. `latest` sigue apuntando a la línea
> estable (1.1.x) hasta que Capa 2 esté completa (8/8 tools) y se valide contra una
> cuenta real (release-gate de `v1.2.0-beta`, ver SPEC-MASTER §8).
>
> Reemplaza a `1.2.0-alpha.0` (publicada 2026-05-29, nunca commiteada a git): mismo
> pivot arquitectónico, más el fix de seguridad de 1.1.1, snapshot de knowledge
> regenerado (36 features / 8 clients, antes 23/3) y suite de tests nueva.

### Fixed (seguridad, igual que 1.1.1)
- **Auto-refresh serializado (single-flight in-process)**: dos refrescos concurrentes
  del `refresh_token` (de un solo uso en ML) ya no revocan la cuenta con `invalid_grant`
  en el segundo request.
- **Nunca se loguea el valor del token** (ni truncado/substring) — antes se imprimían
  los primeros 20 caracteres del `refresh_token` rotado en logs.

### Pivot arquitectónico — "TRAID ML Hub Server"

El MCP deja de ser sólo "wrapper de tools de seller" y pasa a ser un **hub de contexto + tools para devs TRAID trabajando con ML en cualquier proyecto**. Las 11 tools v1.0 siguen viviendo intactas (backwards-compat 100%). Encima se agregan 4 capas más.

### Architecture (5 capas)

```
CAPA 4 · _meta_*    introspection (TBD v1.2.0 GA)
CAPA 3 · flow_*     composite workflows (opt-in, TBD v1.2.0-rc)
CAPA 2 · traid_*    knowledge tools (NEW) ← el quiebre conceptual
CAPA 1 · ml_*       raw endpoints ML (las 11 v1.0 + 9 nuevas)
CAPA 0 · official_* proxy MCP oficial ML (existente, v1.1.0)
```

### Added

- **Knowledge snapshot bundled**: `data/knowledge.json` (118 KB, regenerado 2026-07-01) con 36 features TRAID, 8 clients, 15 gotchas, 10 endpoints, 15 patterns, 5 sql snippets, 10 stack advice, 10 anti-patterns. Generado por `npm run build:knowledge` desde el repo CONOCIMIENTO-NAHUEL.
- **Skeleton de capas**: `src/layers/{traid}/` con interfaces y registry pattern.
- **2 tools prototype de Capa 2**: `traid_feature_lookup`, `traid_client_context` — demuestran el patrón knowledge tools.
- **Suite de tests** (`test/`): auth-security (single-flight + no-token-log), knowledge-gate (release-gate de alpha: `traid_feature_lookup("repricing")` >= 3 hits), traid-layer (smoke de registro de tools).
- **3 env vars nuevas**:
  - `TRAID_CLIENT_SLUG` — slug del cliente actual (`adrian`, `pablo`, etc.), habilita `traid_client_context` sin args.
  - `TRAID_KNOWLEDGE_MODE` — `bundled` (default) · `filesystem` (lee del repo CONOCIMIENTO-NAHUEL via `TRAID_KNOWLEDGE_PATH`) · `pinecone` (v1.3).
  - `TRAID_FLOWS_ENABLED` — CSV con nombres de `flow_*` a registrar (default vacío). Todavía sin flows implementados.

### Changed

- **Naming**: package se mantiene como `@nahuelalbornoz/mercadolibre-mcp`. Rebrand a `@traid/ml-hub` queda para v2.0 (sin org npm hoy).
- **Description del paquete**: actualizada para reflejar las 5 capas.
- **Build script**: agregado `build:knowledge` que invoca el pipeline Python. `prepublishOnly` ahora corre `build:knowledge` antes de `build`.

### Backwards compatibility

- ✅ Las 11 tools v1.0 (`list_products`, `get_orders`, `update_price`, `update_stock`, `list_questions`, `answer_question`, `get_item_metrics`, `manage_ads`, `get_reputation`, `search_competitors`, `get_categories`) siguen funcionando idénticas.
- ✅ Los 3 modos de auth de v1.1.1 (Supabase, token directo, auto-refresh) preservados.
- ✅ Upstream proxy al MCP oficial preservado, sigue con prefijo `official_`.
- ⚠ En v1.2.0 GA cada tool v1.0 obtendrá alias `ml_*` (ej: `ml_list_products`). Ambos nombres coexistirán hasta v2.0 donde se removerá el v1.0.

### Specs (en CONOCIMIENTO-NAHUEL)

- `knowledge/stack/mcp-traid-ml-hub/SPEC-MASTER.md` — arquitectura 5 capas
- `knowledge/stack/mcp-traid-ml-hub/spec-capa0-official-proxy.md`
- `knowledge/stack/mcp-traid-ml-hub/spec-capa1-ml-raw.md`
- `knowledge/stack/mcp-traid-ml-hub/spec-capa2-traid-knowledge.md`
- `knowledge/stack/mcp-traid-ml-hub/spec-capa3-composite-workflows.md` (los 15 flows)

## [1.1.1] — 2026-07-01

> Patch de seguridad sobre la línea estable (`latest`). Sin cambios de arquitectura
> ni tools nuevas — mismo alcance que 1.1.0.

### Fixed (seguridad)
- **Auto-refresh serializado (single-flight in-process)**: dos refrescos concurrentes
  del `refresh_token` (de un solo uso en ML) ya no revocan la cuenta con `invalid_grant`
  en el segundo request.
- **Nunca se loguea el valor del token** (ni truncado/substring) — antes se imprimían
  los primeros 20 caracteres del `refresh_token` rotado en logs.

## [1.1.0] — 2026-05-28

### Added
- **Modo Supabase** (prioridad 0 en auth) — el `access_token` se lee de una tabla `oauth_tokens` (column `account_label`) en Supabase, ideal para setups multi-tenant donde n8n/cron persisten el token refresheado. Activa cuando hay `SUPABASE_URL` (o `NEXT_PUBLIC_SUPABASE_URL`) y `SUPABASE_SERVICE_KEY` (o `SUPABASE_SERVICE_ROLE_KEY`).
- **Upstream proxy** — al boot, conecta como cliente MCP al servidor oficial de Mercado Libre (`https://mcp.mercadolibre.com/mcp`) y re-registra sus tools con prefijo `official_`. Beneficio: el surface oficial queda siempre actualizado server-side sin re-build. Desactivable con `ML_SKIP_UPSTREAM_PROXY=1`.
- Nueva dep `@supabase/supabase-js ^2.106.2`.
- Nuevos archivos `src/token-store.ts` y `src/upstream-proxy.ts`.

### Changed
- Refactor de `src/auth.ts`: ahora delega a token-store cuando Supabase está configurado. Backwards-compat preservado — los modos 1 (`ML_ACCESS_TOKEN`) y 2 (auto-refresh con `ML_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN`) siguen funcionando igual.
- Nombre del paquete oficial pasó a `@nahuelalbornoz/mercadolibre-mcp` (el scope `@traid` queda como referencia histórica).

### Failure modes
- Si el upstream oficial no es reachable al boot, las 11 tools TRAID arrancan igual y el server logea un warning a stderr.
- Si la row de `oauth_tokens` no existe o el `expires_at` ya pasó, el cliente igual usa el token pero advierte por stderr.

## [1.0.0] — 2026-04-18

### Added
- Release inicial con 11 tools (7 de lectura + 4 de escritura con write-back).
- OAuth2 con dos modos: token directo o auto-refresh con `ML_CLIENT_ID` + `ML_CLIENT_SECRET` + `ML_REFRESH_TOKEN`.
- Soporte para MLA (Argentina), MLM (México), MLB (Brasil) y resto de sitios Mercado Libre.
- Compatibilidad con Claude Code, Cursor, Continue y cualquier cliente MCP.
- SKILL.md con metadata para distribución en marketplaces.

### Tools (lectura)
- `list_products` — publicaciones del seller
- `get_orders` — órdenes con detalle
- `list_questions` — preguntas recibidas
- `get_item_metrics` — métricas de publicación
- `get_reputation` — reputación del vendedor
- `search_competitors` — competencia por keyword
- `get_categories` — árbol de categorías

### Tools (escritura / write-back)
- `update_price` — actualiza precio de una publicación
- `update_stock` — actualiza stock disponible
- `answer_question` — responde preguntas de potenciales compradores
- `manage_ads` — pausa/activa publicaciones y edita ads

### Notes
- Versión full con write-back — para subset read-only ver `@nahuelalbornoz/mercadolibre-mcp-read`.
