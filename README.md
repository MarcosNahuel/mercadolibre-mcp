# Mercado Libre MCP Server — para Claude Code, Cursor y agentes de IA

[![npm version](https://img.shields.io/npm/v/@nahuelalbornoz/mercadolibre-mcp.svg)](https://www.npmjs.com/package/@nahuelalbornoz/mercadolibre-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@nahuelalbornoz/mercadolibre-mcp.svg)](https://www.npmjs.com/package/@nahuelalbornoz/mercadolibre-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

**`@nahuelalbornoz/mercadolibre-mcp`** — servidor [MCP](https://modelcontextprotocol.io/) (Model Context Protocol) para vendedores de Mercado Libre. 11 tools de operación (con write-back), proxy al MCP oficial de ML, token-store Supabase multi-tenant, y **knowledge tools** ("TRAID ML Hub", v1.2.0+) que exponen features, gotchas y patrones reusables programáticamente. Compatible con Claude Code, Cursor, Continue y cualquier cliente MCP.

```bash
npx @nahuelalbornoz/mercadolibre-mcp
```

## Por qué esta vs las alternativas

- **vs el MCP oficial de ML**: este paquete lo **envuelve** (Capa 0, tools `official_*`, siempre actualizado server-side) y le agrega las operaciones de seller que el oficial no expone (precio/stock/preguntas/ads con write-back, métricas, reputación, competencia).
- **vs [`@nahuelalbornoz/mercadolibre-mcp-read`](https://www.npmjs.com/package/@nahuelalbornoz/mercadolibre-mcp-read)**: ese es el subset **read-only** (7 tools, sin riesgo de tocar la tienda). Usá este paquete completo cuando necesites escribir (precios, stock, respuestas, ads); usá el `-read` si solo hacés análisis/reporting.
- **Auth flexible**: 3 modos (Supabase multi-tenant, token directo, auto-refresh standalone) — elegís según si tenés un backend (n8n/cron) renovando el token o no.

---

## Arquitectura — 5 capas

```
CAPA 4 · _meta_*    introspection (TBD v1.2.0 GA)
CAPA 3 · flow_*     composite workflows opt-in (TBD v1.2.0-rc)
CAPA 2 · traid_*    knowledge tools ★ NUEVO en v1.2.0
CAPA 1 · ml_*       endpoints ML hand-coded (11 v1.0 + 9 nuevas en beta)
CAPA 0 · official_* proxy MCP oficial ML (v1.1.0)
```

| Capa | Cuándo cambia | Quién la usa |
|---|---|---|
| **0 — official** | Cuando ML actualiza server-side (transparente) | Devs buscando docs ML on-demand |
| **1 — ml** | Cuando descubrimos gotcha o endpoint nuevo | Cualquier tool de Capa 3 o devs |
| **2 — traid** | Cuando agregamos feature al `knowledge/` | Todo agente Claude arrancando feature ML en cualquier repo TRAID |
| **3 — flow** | Cuando pulimos un workflow de negocio | Proyectos cliente que activan el flow via config |
| **4 — meta** | Casi nunca | Devs debuggeando conexión MCP |

Specs completos: `knowledge/stack/mcp-traid-ml-hub/` en el repo CONOCIMIENTO-NAHUEL.

---

## Capa 1 — Tools ML (11 v1.0 + extensiones)

Las 11 tools existentes v1.0 (preservadas con backwards-compat 100%):

| Tool | Descripción | Tipo |
|---|---|---|
| `list_products` | Lista productos/publicaciones de un vendedor | Lectura |
| `get_orders` | Obtiene órdenes/ventas con detalle | Lectura |
| `update_price` | Actualiza precio de una publicación | Escritura |
| `update_stock` | Actualiza stock de una publicación | Escritura |
| `list_questions` | Lista preguntas recibidas | Lectura |
| `answer_question` | Responde una pregunta | Escritura |
| `get_item_metrics` | Métricas: visitas, conversión, salud | Lectura |
| `manage_ads` | Gestiona Product Ads (activar/pausar/status) | Escritura |
| `get_reputation` | Reputación del vendedor | Lectura |
| `search_competitors` | Busca productos de la competencia | Lectura |
| `get_categories` | Categorías y atributos para publicar | Lectura |
| `price_to_win` | Precio para ganar el buy-box / competencia de catálogo | Lectura |
| `price_history` | Historial de cambios de precio de una publicación | Lectura |
| `stockout_risk` | Riesgo de quiebre de stock (días de cobertura + velocidad) | Lectura |

Las 3 últimas (`price_to_win`, `price_history`, `stockout_risk`) se sumaron en la **fusión `meli-seller-mcp` (2026-07-18)** — ver más abajo.

En v1.2.0-beta llegan 9 tools más con prefijo `ml_*` para endpoints validados que faltaban: `ml_items_price_to_win`, `ml_users_items_visits_bulk`, `ml_products_catalog`, `ml_products_catalog_items`, `ml_items_shipping_options`, `ml_marketplace_benchmarks` (con pre-flight Global Selling check), `ml_orders_billing`, `ml_claims_search`, `ml_stock_fulfillment`. Ver `spec-capa1-ml-raw.md`.

---

## Capa 2 — Knowledge tools (★ nuevo)

Tools que exponen el **catálogo TRAID** (155+ features auditadas en 10 repos cliente) y conocimiento operativo programáticamente.

**Disponibles hoy** (prototypes que demuestran el patrón):

### `traid_feature_lookup(query, limit?, category?)`

Busca features reusables. Ej: `traid_feature_lookup("repricing")` → top 5 con `motor-repricing-semaforo-7-estados.md` (lubbi-erp) en primer lugar.

### `traid_client_context(slug?)`

Devuelve metadata del cliente actual (seller_ids, schema Supabase, n8n folder, bloqueantes). Auto-detect via `TRAID_CLIENT_SLUG` env.

**TBD en próximas alphas**:

- `traid_pattern_for(use_case)` — patrón reusable para un caso de uso
- `traid_gotcha_search(query)` — busca gotchas API ML conocidos
- `traid_endpoint_catalog(pattern?)` — endpoints validados/rotos/workarounds
- `traid_sql_snippet(domain)` — schemas SQL canónicos
- `traid_stack_advice(component)` — recomendación stack TRAID 2026
- `traid_anti_pattern_check(description)` — check vs 10 anti-patterns

Spec completo: `knowledge/stack/mcp-traid-ml-hub/spec-capa2-traid-knowledge.md`.

---

## Capa 0 — Proxy MCP oficial ML

Al boot, conecta al servidor oficial `https://mcp.mercadolibre.com/mcp` y re-registra sus tools con prefijo `official_*`. Cuando ML agrega endpoints, los ves automáticamente sin re-buildear.

Tools típicas: `official_search_documentation`, `official_get_documentation_page`, `official_product_description`, `official_product_reviews`, `official_seller_reputation`.

Desactivable con `ML_SKIP_UPSTREAM_PROXY=1` o `TRAID_DISABLE_LAYERS=official`.

---

## Setup

Tres modos de autenticación (orden de prioridad — se elige el primero configurado):

### Opción A: Supabase (multi-tenant, recomendado v1.1.0+)

```json
{
  "mcpServers": {
    "traid-ml-hub": {
      "command": "npx",
      "args": ["-y", "@nahuelalbornoz/mercadolibre-mcp"],
      "env": {
        "SUPABASE_URL": "https://YOUR_PROJECT.supabase.co",
        "SUPABASE_SERVICE_KEY": "${SUPABASE_SERVICE_ROLE_KEY}",
        "ML_ACCOUNT_LABEL": "miami",
        "ML_TOKEN_TABLE": "oauth_tokens",
        "ML_SITE_ID": "MLA",

        "TRAID_CLIENT_SLUG": "adrian",
        "TRAID_KNOWLEDGE_MODE": "bundled"
      }
    }
  }
}
```

Schema mínimo esperado de la tabla de tokens:

```sql
create table oauth_tokens (
  account_label text primary key,
  access_token  text not null,
  refresh_token text,
  expires_at    timestamptz,
  updated_at    timestamptz default now()
);
```

### Opción B: Token directo

```json
{
  "env": {
    "ML_ACCESS_TOKEN": "APP_USR-...",
    "ML_SITE_ID": "MLA",
    "TRAID_CLIENT_SLUG": "pablo"
  }
}
```

### Opción C: Auto-refresh standalone

```json
{
  "env": {
    "ML_CLIENT_ID": "tu_client_id",
    "ML_CLIENT_SECRET": "tu_client_secret",
    "ML_REFRESH_TOKEN": "tu_refresh_token",
    "ML_SITE_ID": "MLA"
  }
}
```

---

## Env vars v1.2.0+

| Env | Default | Propósito |
|---|---|---|
| `TRAID_CLIENT_SLUG` | (vacío) | Slug del cliente actual (`adrian`, `pablo`, `hernan`, etc.). Habilita `traid_client_context` sin args. |
| `TRAID_KNOWLEDGE_MODE` | `bundled` | `bundled` (default, snapshot JSON en el paquete) · `filesystem` (lee del repo CONOCIMIENTO-NAHUEL via `TRAID_KNOWLEDGE_PATH`) · `pinecone` (v1.3). |
| `TRAID_KNOWLEDGE_PATH` | (vacío) | Path al repo CONOCIMIENTO-NAHUEL (solo modo `filesystem`). |
| `TRAID_FLOWS_ENABLED` | (vacío) | CSV con nombres de `flow_*` a registrar. Default vacío = solo Capas 0+1+2+4. |
| `TRAID_DISABLE_LAYERS` | (vacío) | CSV de capas a deshabilitar (`official,ml,traid,flow`). |
| `GCP_PROJECT_ID` | (vacío) | Activa flows que usan Vertex Gemini. Sin esto, los flows W3.* arrancan disabled. |

Env vars existentes v1.1.0 (preservadas): `ML_ACCESS_TOKEN`, `ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `ML_REFRESH_TOKEN`, `ML_SITE_ID`, `ML_ACCOUNT_LABEL`, `ML_TOKEN_TABLE`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ML_SKIP_UPSTREAM_PROXY`.

---

## Sites soportados

| Site ID | País |
|---|---|
| MLA | Argentina |
| MLU | Uruguay |
| MLB | Brasil |
| MLC | Chile |
| MLM | México |
| MCO | Colombia |
| CBT | Global Selling (cross-border) |

---

## Uso desde Claude

```
"Listame los productos activos"
"Mostrá las órdenes de hoy"
"Actualizá el precio de MLA123456 a $5000"
"Qué preguntas sin responder tengo?"
"Buscá competencia para repuestos de freno Toyota"

# Nuevo en v1.2.0 (Capa 2):
"Buscame features de TRAID relacionadas a OAuth multi-tenant"
"Qué contexto tengo del cliente actual?"
```

---

## Desarrollo

```bash
cd PROYECTOS/mercadolibre-mcp
npm install
npm run build               # Compilar TypeScript
npm run build:knowledge     # Regenerar data/knowledge.json desde CONOCIMIENTO-NAHUEL
npm run dev                 # Dev con tsx + reload
```

Requiere que el repo CONOCIMIENTO-NAHUEL esté en `../CONOCIMIENTO-NAHUEL` para `build:knowledge`.

### Tests del knowledge snapshot

```bash
node -e "const {searchFeatures} = require('./dist/knowledge/loader.js'); console.log(searchFeatures('repricing', {limit: 3}))"
```

---

## Seguridad

- **Auto-refresh serializado (single-flight + lease CAS)**: el refresh del token (modo standalone) está serializado in-process — dos refrescos concurrentes ya no revocan la cuenta (el `refresh_token` de ML es de un solo uso). Con Supabase configurado, además se serializa **entre procesos/réplicas** con un lease *compare-and-set* (CAS) sobre `oauth_tokens` (columnas `refresh_in_progress`/`locked_until`). Requiere aplicar `migrations/0001_oauth_tokens_lease.sql` (idempotente, RLS inline service_role-only). Sin la migración, el single-flight in-process sigue protegiendo la carrera. Ver la sección "Fusión meli-seller-mcp".
- **Nunca se loguea el valor de un token**, ni truncado. Solo "presente/ausente/rotado".
- **Candados de tools**: el registro pasa por un gate (`src/tool-guard.ts`) que **corta el arranque** si se intentara registrar una tool de compra u operación destructiva (`buy_*`, `purchase`, `checkout`, `delete`, `cancel`, `refund`, `pay*`, en inglés y español). Las 4 tools de escritura permitidas (`update_price`, `update_stock`, `answer_question`, `manage_ads`) están en una allowlist explícita.
- Reportar vulnerabilidades: [issues del repo](https://github.com/MarcosNahuel/mercadolibre-mcp/issues) o `contacto@traid.agency`.

---

## Fusión `meli-seller-mcp` — 2026-07-18

Este paquete **absorbió** lo mejor del repo hermano `meli-seller-mcp` (un MCP read-only más nuevo, con la auth blindada y analytics porteadas de `globalstats-haussman`), que queda archivado. Qué se trajo:

**Absorbido:**

- **Lease CAS del token** (seguridad): el refresh del modo standalone ahora puede serializarse **cross-proceso** con un lease en la DB, no sólo in-process. Cableado en `src/auth.ts` sobre helpers de `src/token-store.ts` (`tryAcquireRefreshLease`/`releaseRefreshLease`/`persistRefreshedToken`/`readTokenRow`/`waitForFreshDbToken`). Se activa cuando hay Supabase configurado; `ML_AUTH_MODE=standalone` fuerza el auto-refresh aunque haya Supabase (para usar el lease). Migración nueva: `migrations/0001_oauth_tokens_lease.sql`.
- **3 analytics read-only nuevas** (Capa 1, `src/tools/`), reimplementadas en **TypeScript puro** con el patrón `server.tool()→content` del paquete:
  - `price_to_win` — precio para ganar el buy-box / competencia de catálogo (`GET /items/{id}/price_to_win?version=v2`).
  - `price_history` — historial de cambios de precio (`GET /pricing-automation/items/{id}/price/history`).
  - `stockout_risk` — riesgo de quiebre de stock: días de cobertura y velocidad de venta, calculado en vivo (órdenes + stock). Suma un helper `mlGetAll` (paginado offset/limit) a `src/client.ts`.
- **Candados** de tools destructivas/de compra (ver Seguridad).

**Qué falta / fuera de alcance:**

- **`forecast_demand`** (pronóstico de demanda Prophet/Python) **NO se portó**: introduce una dependencia de host (Python + `prophet` + `pandas`) que no queremos como dependencia dura en todos los deploys. Queda como trabajo futuro detrás de un flag.
- El **broker de tokens central**: a futuro, el refresh delegará en el *token broker* de traid-saas (`/internal/v1/token`) cuando esté vivo; el lease CAS local queda como **defensa propia** (funciona sin el broker y lo complementa).

## Related

- [`@nahuelalbornoz/mercadolibre-mcp-read`](https://www.npmjs.com/package/@nahuelalbornoz/mercadolibre-mcp-read) — subset read-only (7 tools), sin riesgo de tocar la tienda.
- [Model Context Protocol](https://modelcontextprotocol.io/) — especificación del protocolo.
- [Mercado Libre Developers](https://developers.mercadolibre.com/) — docs oficiales de la API.

## Licencia

MIT
