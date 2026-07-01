# PLAN — Fusión `meli-seller-mcp` (donante) → `mercadolibre-mcp` (paquete publicado)

> Estado: **PLAN, no ejecutado.** Ningún archivo de código tocado todavía.
> Fecha: 2026-06-30 · Autor: sesión Claude Code (TRAID)
> Destino editable: **solo** `mercadolibre-mcp/` (`@nahuelalbornoz/mercadolibre-mcp`, v1.2.0-alpha.0).
> Donantes **SOLO LECTURA** (no se modifican): `meli-seller-mcp`, `globalstats-haussman`, y cualquier otro repo origen.

---

## 0. Contexto y objetivo

`mercadolibre-mcp` es el paquete **publicado** (`@nahuelalbornoz/mercadolibre-mcp` en npm), arquitectura de 5 capas
("TRAID ML Hub Server"). Tiene write tools reales (no es read-only). Su `src/auth.ts` actual arrastra **2 blockers**
de seguridad detectados por el jurado.

`meli-seller-mcp` es un MCP-first **read-only** más nuevo (hexagonal: `core/` transport-agnostic + `adapters/mcp/`),
construido con la auth **blindada**, tests, y 4 tools de analytics read-only que en el publicado son **GAPS**.

Objetivo: **portar lo bueno del donante al publicado** sin romper nada de lo que ya hay:

| # | Qué traer del donante | Estado en publicado |
|---|----------------------|---------------------|
| 1 | Auth **blindada** (refresh con lock/single-flight + CAS lease; NUNCA loguea tokens) | Reemplaza `src/auth.ts` (con los 2 blockers) |
| 2 | **Tests** (auth-lock, pricing-shape, smoke) | No existe runner de tests hoy |
| 3 | **Analytics read-only** (`price_history`, `stockout_risk`, `forecast_demand`, `price_to_win`) | GAPS — no existen |

---

## 1. Inventario de los dos repos (lo que importa para la fusión)

### 1.1 Destino — `mercadolibre-mcp` (NO romper)

- `package.json` → `@nahuelalbornoz/mercadolibre-mcp` **v1.2.0-alpha.0**, ESM, `bin: mercadolibre-mcp`, deps: `@modelcontextprotocol/sdk ^1.27`, `@supabase/supabase-js ^2.106`, `zod ^3.24`. **Sin devDep de test, sin script `test`.**
- `src/index.ts` → registra las **11 tools v1.0** (Capa 1), Capa 0 (`registerUpstreamProxy`), Capa 2 (`registerTraidLayer`). Banner `1:ml(11)`.
- `src/auth.ts` → **3 modos** (Supabase via `token-store.ts` / token directo `ML_ACCESS_TOKEN` / auto-refresh OAuth2). **Aquí viven los 2 blockers** (ver §2).
- `src/token-store.ts` → modo Supabase **read-only** (lee `oauth_tokens`, n8n owna el refresh). **Ya es seguro: no loguea el valor del token.**
- `src/client.ts` → `mlFetch<T>(path, {method, body, params})` + `mlMultiGet`. Llama `getAccessToken()` **sin argumentos**. Retry 429/401.
- `src/upstream-proxy.ts` → Capa 0: proxy al MCP oficial ML, prefijo `official_`. Llama `getAccessToken()` **sin argumentos**.
- `src/tools/*.ts` → patrón **`server.tool(name, description, zodShape, handler)`** que retorna `{ content: [{type:'text', text}] }`. De las 11, **4 son WRITE**: `update_price`, `update_stock`, `answer_question`, `manage_ads`.
- `src/layers/traid/*` → Capa 2 knowledge-tools (`traid_feature_lookup`, `traid_client_context`), bundle `data/knowledge.json`.

**Contrato público que NO se puede cambiar** (lo consumen `client.ts` y `upstream-proxy.ts`):

```ts
export function getConfig(): MLConfig            // usado por tools (siteId)
export async function getAccessToken(): Promise<string>   // CERO argumentos
export function clearTokenCache(): void
```

### 1.2 Donante — `meli-seller-mcp` (SOLO LECTURA)

- `src/core/auth/index.ts` → auth blindada. `AuthContext` + `getAccessToken(ctx, {forceRefresh})`. Dos modos: **supabase** (read-only, n8n owna refresh) y **standalone** (auto-refresh **serializado**: single-flight in-process `Map<key,Promise>` + **lease CAS cross-proceso** sobre `oauth_tokens.refresh_in_progress`/`locked_until`). **Regla de logging: jamás imprime el valor de un token, ni truncado.**
- `src/core/http/index.ts` → `mlGet`/`mlGetAll`/`mlFetch` con 429 (Retry-After), 5xx backoff+jitter, **401 → forceRefresh serializado + 1 retry**. No loguea Authorization.
- `src/core/ml/{price_history,stockout_risk,forecast_demand,price_to_win}.ts` → handlers **transport-agnostic**: exponen `{ name, description, inputSchema (zod), handler(input, ctx) }` y retornan **datos estructurados** (no `content`). Portados de `globalstats-haussman`.
- `src/core/forecast/{index.ts,forecast_runner.py}` → wrapper **out-of-process Python/Prophet** para `forecast_demand`. Degrada elegante si falta Python (no tumba el server).
- `src/adapters/mcp/server.ts` → adapta core→MCP con **lista blanca + gate read-only** (`assertReadOnly`, `WRITE_TOOL_DENYLIST`). **Este gate NO se porta tal cual** (ver §6, riesgo crítico).
- `migrations/0001_oauth_tokens_lease.sql` → crea/extiende `oauth_tokens` con columnas de lease, **RLS inline** (ENABLE + FORCE, sin policy = service_role-only, previene CVE-2025-48757).
- `tests/{auth-lock,pricing,readonly-gate,smoke}.test.ts` + `tests/helpers/fetchMock.ts` → vitest, 19/19. Red mockeada.

---

## 2. Los 2 blockers del `src/auth.ts` actual (lo que hay que matar)

Archivo: `mercadolibre-mcp/src/auth.ts`.

- **Blocker A — refresh SIN lock (carrera que revoca el refresh_token).**
  `getAccessToken()` (modo 2, líneas ~40-91) hace `fetch(ML_AUTH_URL, ...)` directo. Dos llamadas concurrentes con el
  token vencido disparan **dos** `POST /oauth/token` en paralelo; ML **rota** el `refresh_token` en cada uno y el
  segundo invalida al primero → cuenta deslogueada. No hay single-flight ni cache compartido del in-flight.
- **Blocker B — loguea el `refresh_token` (línea 87).**
  `console.error(`[ml-mcp] Refresh token actualizado. Nuevo: ${data.refresh_token.substring(0, 20)}...`)`.
  Imprime 20 chars del secreto al stderr (logs de Dokploy/CI). Viola la regla TRAID "nunca imprimir valores de secretos".

El donante resuelve **ambos**: single-flight + lease CAS (A) y la regla de logging "jamás el valor del token" (B,
`callMlRefresh` solo loguea `"token refrescado ok"` / `"refresh_token rotado"`).

---

## 3. Punto 1 — Portar la auth blindada

**Decisión recomendada: merge quirúrgico de bajo blast-radius**, NO refactor hexagonal completo. Se reemplaza el
**interior** de `src/auth.ts` por la lógica del donante, **preservando el contrato público** (`getAccessToken()` sin
args, `getConfig()`, `clearTokenCache()`) para que `client.ts` y `upstream-proxy.ts` **no se toquen**.

### 3.1 Archivos origen → destino

| Origen (donante, read-only) | Destino (editable) | Acción |
|---|---|---|
| `meli-seller-mcp/src/core/auth/index.ts` | `mercadolibre-mcp/src/auth.ts` | Reescribir interior: traer `AuthContext`, single-flight (`inflight` Map), `rotatedRefreshToken` Map, lease CAS (`tryAcquireLease`/`releaseLease`/`persistTokenToDb`/`waitForFreshDbToken`), `callMlRefresh` **sin log de token**. |
| `meli-seller-mcp/src/core/auth/index.ts` (función `log`) | `mercadolibre-mcp/src/auth.ts` | Adoptar `log()` que solo dice "presente/ausente/refrescado ok". Borrar el `substring(0,20)`. |
| `meli-seller-mcp/migrations/0001_oauth_tokens_lease.sql` | `mercadolibre-mcp/migrations/0001_oauth_tokens_lease.sql` (nuevo dir) | Copiar **textual** (incluye RLS inline + comentario `rls-skip`). Solo necesaria si se adopta el lease CAS cross-proceso. |

### 3.2 Cómo encaja sin romper el contrato

- Mantener `getConfig()` y `getAccessToken(): Promise<string>` **idénticos en firma**. Internamente, `getAccessToken()`
  construye/usa un `AuthContext` singleton (de env) y delega en la lógica del donante. El `forceRefresh` queda como
  **detalle interno** (lo dispara `client.ts` en 401, que hoy ya hace `clearTokenCache()` — se puede mantener ese path
  o, opcional fase 2, exponer `getAccessToken({forceRefresh})` como overload aditivo).
- **Mapear los 3 modos actuales a los 2 del donante**:
  - Modo 0 (Supabase read-only de `token-store.ts`) ≡ donante "supabase". El `token-store.ts` actual **ya es seguro**;
    se puede **conservar** o consolidar dentro de `auth.ts`. **Recomendado conservar** `token-store.ts` para minimizar
    blast-radius; solo se le suma (opcional) el path de lease si se quiere refresh interno.
  - Modo 1 (token directo `ML_ACCESS_TOKEN`) → mantener como atajo (el donante no lo tiene pero es trivial y usado).
  - Modo 2 (auto-refresh) → reemplazar por el **standalone serializado** del donante (single-flight + CAS opcional).
- `clearTokenCache()` sigue existiendo → mapear a `resetAuthState()`/`tokenCache.delete(key)` del donante.

### 3.3 Riesgos y qué NO romper

- **NO cambiar la firma de `getAccessToken()`** → si cambia, rompe `client.ts` (línea `const token = await getAccessToken()`)
  y `upstream-proxy.ts` (`token = await getAccessToken()`). Cualquier `ctx`/`opts` debe ser **opcional con default**.
- **Preservar los nombres de env vars** ya documentados: `SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_URL`,
  `SUPABASE_SERVICE_KEY`/`SUPABASE_SERVICE_ROLE_KEY`, `ML_ACCESS_TOKEN`, `ML_CLIENT_ID/SECRET/REFRESH_TOKEN`,
  `ML_TOKEN_TABLE`, `ML_ACCOUNT_LABEL`, `ML_SITE_ID`. El donante agrega `ML_AUTH_MODE` (opcional, default inferido).
  **Default debe mantener el comportamiento actual** para no sorprender deploys existentes.
- **Lease CAS requiere columnas nuevas** (`refresh_in_progress`, `locked_until`) en `oauth_tokens`. Si NO se corre la
  migración, el `tryAcquireLease` fallaría. Mitigación: el path standalone **sin Supabase** usa solo single-flight
  in-process (no toca la tabla) → la corrección del Blocker A **no depende** de la migración. El CAS es mejora extra.
- **Token logging**: auditar que ningún otro archivo (`client.ts`, `upstream-proxy.ts`, tools) imprima tokens. Hoy no
  lo hacen — verificarlo en el diff.

---

## 4. Punto 2 — Portar los tests

El destino **no tiene runner de tests** (sin `vitest` en devDeps, sin script `test`). Hay que habilitarlo.

### 4.1 Archivos origen → destino

| Origen (donante) | Destino | Notas |
|---|---|---|
| `tests/helpers/fetchMock.ts` | `mercadolibre-mcp/tests/helpers/fetchMock.ts` | Copiar tal cual (mock de `Response` + router por URL). |
| `tests/auth-lock.test.ts` | `mercadolibre-mcp/tests/auth-lock.test.ts` | **Adaptar imports** a la nueva `src/auth.ts` (singleton vs `AuthContext` inyectado). El corazón (2 refresh concurrentes ⇒ 1 fetch; ningún log contiene el token) se mantiene. |
| `tests/pricing.test.ts` | `mercadolibre-mcp/tests/pricing.test.ts` | Valida shape de `price_to_win`/`price_history`. Adaptar a cómo queden los handlers en destino (§5). |
| `tests/smoke.test.ts` | `mercadolibre-mcp/tests/smoke.test.ts` | Exporta `VERSION` desde `src/index.ts`. Hoy `index.ts` no exporta `VERSION` → o se agrega un `export const PACKAGE_VERSION` reusable, o se adapta el test. |
| `tests/readonly-gate.test.ts` | **NO portar tal cual** | El destino **tiene write tools** → el gate read-only no aplica. Ver §6. |

### 4.2 Cambios de packaging para tests

- Agregar a `devDependencies`: `vitest ^2.1` (ya hay `@types/node`, `tsx`, `typescript`).
- Agregar scripts: `"test": "vitest run"`, `"test:watch": "vitest"`, opcional `"typecheck": "tsc --noEmit"`.
- Asegurar que `tests/` quede **fuera del tarball npm** (el `files` del destino ya es allowlist: `dist`, `data`,
  `README.md`, `LICENSE`, `SKILL.md`, `CHANGELOG.md` → tests **no** entran. OK).
- Verificar que `tsconfig.json` no incluya `tests/` en el build de `dist/` (o usar `tsconfig` separado para test).

### 4.3 Riesgos / qué no romper

- Los tests del donante asumen **`AuthContext` inyectable**. Si la `auth.ts` del destino usa singleton de env, hay que
  exponer un hook de inyección para test (ej. `getAccessTokenWithCtx(ctx)` interno o `resetAuthState()` + ctx builder)
  **sin** ensuciar el contrato público. Es el principal trabajo de adaptación.
- No agregar `vitest` como `dependency` (solo `devDependency`) — no debe ir al runtime publicado.

---

## 5. Punto 3 — Portar las 4 analytics read-only (los GAPS)

Tools a portar: **`price_history`, `stockout_risk`, `forecast_demand`, `price_to_win`** (limpio, del donante, ya
porteadas de haussman). Van a **Capa 1 (`ml_*`)** como tools read-only nuevas, registradas junto a las 11 existentes.

### 5.1 Archivos origen → destino

| Origen (donante, read-only) | Destino | Adaptación |
|---|---|---|
| `src/core/ml/price_to_win.ts` | `mercadolibre-mcp/src/tools/price_to_win.ts` | Reescribir como `registerPriceToWin(server)` con patrón `server.tool(...)` → `content`. |
| `src/core/ml/price_history.ts` | `mercadolibre-mcp/src/tools/price_history.ts` | idem. |
| `src/core/ml/stockout_risk.ts` | `mercadolibre-mcp/src/tools/stockout_risk.ts` | idem; usa `mlGetAll` (paginado) → ver §5.2. |
| `src/core/ml/forecast_demand.ts` | `mercadolibre-mcp/src/tools/forecast_demand.ts` | idem; depende de `core/forecast` (Python) → ver §5.3. |
| `src/core/forecast/index.ts` + `forecast_runner.py` | `mercadolibre-mcp/src/forecast/index.ts` + `forecast_runner.py` | Copiar el wrapper out-of-process. Sumar al `files`/build el `.py`. |

### 5.2 Choque arquitectónico a resolver (clave)

Donante (transport-agnostic): handler retorna **datos estructurados**, usa `mlGet(path, params, ctx)` / `mlGetAll`.
Destino: tools llaman `server.tool(name, desc, zodShape, handler)` y retornan `content`, usan `mlFetch(path, {params})`.

Dos opciones:

- **Opción A (recomendada, mínima): adaptar cada handler al patrón del destino.** En cada `register*`:
  1. Tomar la lógica de dominio del handler donante (clasificación de riesgo, agregación diaria, parseo price_to_win).
  2. Reemplazar `mlGet(path, params, ctx)` → `mlFetch(path, { params })` (cliente existente del destino).
     **Falta `mlGetAll` (paginado offset/limit) en el destino** → portar `mlGetAll` a `client.ts` como helper aditivo
     (no cambia `mlFetch`). `stockout_risk` y `forecast_demand` lo necesitan.
  3. Envolver el resultado estructurado en `{ content: [{ type:'text', text: JSON.stringify(result, null, 2) }] }`.
  4. Registrar el zod **shape** (no el objeto). Para `stockout_risk` (zod `.refine()` cross-field) usar el patrón
     `toRawShape` del donante (desenvolver `ZodEffects` → `.shape`) y re-validar dentro del handler con el schema completo.
- **Opción B (mayor blast-radius): traer `core/` entero** (auth+http+ml+adapters) y montar una capa hexagonal dentro
  del paquete. Más limpio a futuro pero rompe el estilo actual de `src/tools/*` y duplica auth/http. **Descartada para
  esta fusión** (objetivo: fundir sin romstper, no reescribir el paquete).

### 5.3 `forecast_demand` y la dependencia Python

- `forecast_demand` necesita **Python3 + `prophet` + `pandas`** (out-of-process). El wrapper **degrada elegante**
  (retorna `warnings` + `forecast: []`) si falta → no tumba el server. Mantener esa degradación.
- **Empaquetado**: `tsc` no emite el `.py`. Para que `dist/` lo tenga: (a) agregar `forecast_runner.py` al `files` del
  `package.json` y a un paso de copia post-build, o (b) documentar `ML_FORECAST_SCRIPT` apuntando a ruta absoluta.
- **Opción conservadora**: portar `forecast_demand` **detrás de un flag** (ej. registrarla solo si Python disponible /
  env `TRAID_FORECAST_ENABLED`) para no introducir una dependencia de host en todos los deploys. Las otras 3 analytics
  (`price_history`, `stockout_risk`, `price_to_win`) son **TS puro** y entran sin fricción.

### 5.4 Registro en `index.ts`

- Importar y llamar `registerPriceToWin/registerPriceHistory/registerStockoutRisk/registerForecastDemand(server)` en el
  bloque `if (!skipMl) { ... }`, **después** de las 11 existentes.
- Actualizar el banner: `1:ml(11)` → `1:ml(14)` o `1:ml(15)` según se incluya forecast.
- **No tocar** el orden ni el registro de las 11 v1.0, ni Capa 0/2.

### 5.5 Riesgos / qué NO romper

- **NO portar el gate read-only** (`assertReadOnly`/`WRITE_TOOL_DENYLIST`) del donante: el destino **expone write tools**
  (`update_price`, etc.) a propósito. Importar ese gate **rompería** esas 4 tools al boot. (Ver §6.)
- Las 4 nuevas son read-only → no agregan superficie de escritura. Bien.
- `stockout_risk`/`forecast_demand` hacen `GET /users/me`, `/orders/search` paginado, `/items` multiget → asegurar que
  `mlGetAll` portado respete el corte `MAX_OFFSET` (~10k) para no loopear.
- Mantener nombres de tools **sin colisión** con upstream-proxy: el proxy registra con prefijo `official_`, así que
  `price_to_win` local no choca con `official_*`. OK.

---

## 6. Backwards-compat — la lista de "NO romper" (resumen duro)

1. **Las 11 tools v1.0** (`list_products`, `get_orders`, `update_price`, `update_stock`, `list_questions`,
   `answer_question`, `get_item_metrics`, `manage_ads`, `get_reputation`, `search_competitors`, `get_categories`)
   → idénticas en nombre, schema y comportamiento. Los 4 **write tools** siguen funcionando (no aplicar gate read-only).
2. **Upstream-proxy (Capa 0)** → sigue registrando `official_*`; `getAccessToken()` no cambia de firma.
3. **Knowledge-tools (Capa 2)** → `registerTraidLayer`, bundle `data/knowledge.json`, env `TRAID_*` intactos.
4. **3 modos de auth** y **todos los env vars** existentes → comportamiento por **default** preservado; `ML_AUTH_MODE`
   es opt-in con inferencia compatible.
5. **Contrato público** de `auth.ts` (`getConfig`, `getAccessToken()`, `clearTokenCache`) → estable.
6. **Tarball npm** → `files` allowlist; tests/migrations/`.py`-no-empaquetado según corresponda; **cero secretos**.

---

## 7. Bump de versión

- **Actual**: `1.2.0-alpha.0`. **Propuesto**: `1.2.0-alpha.1`.
  - Es **aditivo** (4 tools read-only nuevas) + **fix de seguridad** (auth) → no rompe API pública → sigue en la línea
    `1.2.0` pre-release. (El CHANGELOG ya reservaba `alpha.1` para más knowledge-tools; consolidar ambas cosas o usar
    `alpha.1` para esto y correr knowledge-tools a `alpha.2` — **decisión de Nahuel**.)
- Actualizar en **3 lugares** que hoy hardcodean la versión: `package.json` `"version"`, `src/index.ts`
  `const PACKAGE_VERSION`, y el `version` del `McpServer`. Agregar entrada nueva al tope de `CHANGELOG.md` (Added:
  4 analytics tools; Security: refresh con lock + no-log de tokens; Tests: vitest).

---

## 8. Checklist de re-publicación a npm — **PASO MANUAL, requiere OK de Nahuel**

> ⛔ **NO publicar ni deployar en esta sesión.** Esta es la receta para cuando Nahuel diga OK.

1. `npm run build` → `tsc` limpio (ESM estricto). Verificar `dist/` poblado.
2. `npm test` → vitest verde (auth-lock + pricing + smoke). **Gate honesto: lo corre el orquestador, no el agente.**
3. `npm run build:knowledge` → regenera `data/knowledge.json` (lo hace `prepublishOnly`).
4. **`npm pack --dry-run`** → revisar la lista del tarball:
   - Incluye: `dist/`, `data/knowledge.json`, `README.md`, `LICENSE`, `SKILL.md`, `CHANGELOG.md` (+ `forecast_runner.py`
     si forecast se empaqueta).
   - **Excluye**: `.env*`, `.mcp.json`, `src/`, `tests/`, `migrations/`, `node_modules/`. **Cero secretos.**
5. Confirmar `version` bumpeada en `package.json` y que el tag de git no exista aún.
6. **`npm publish --access public`** (scope `@nahuelalbornoz` → requiere `--access public`). Corre `prepublishOnly`
   (build:knowledge + build) automáticamente. **← este comando solo con OK explícito de Nahuel.**
7. Post-publish: `git tag v1.2.0-alpha.1 && git push --tags`; verificar en `https://www.npmjs.com/package/@nahuelalbornoz/mercadolibre-mcp`.
8. Entregar en **rama + PR** (nunca merge directo a master). El publish va después del merge aprobado.

---

## 9. Registro en MCP Registry (para promo)

- **Registry oficial** (`registry.modelcontextprotocol.io`): crear/actualizar `server.json` con `name`
  (`io.github.MarcosNahuel/mercadolibre-mcp` o el namespace que valide ownership del repo GitHub), `description`,
  `packages` (npm `@nahuelalbornoz/mercadolibre-mcp@1.2.0-alpha.1`), y env vars requeridas. Publicar con el CLI
  `mcp-publisher` (login GitHub OAuth → `mcp-publisher publish`). **PASO MANUAL, con OK.**
- **Smithery**: el repo ya trae `smithery.json` → actualizar la entrada (tools nuevas + versión) y re-sincronizar.
- Verificar que la descripción de promo liste las **15 tools** (11 v1.0 + 4 analytics) y la nota de **seguridad**
  (auth con lock, no-log de tokens) como diferencial.
- **No** registrar nada con valores de secretos; el `server.json` solo declara **nombres** de env vars.

---

## 10. Orden de ejecución sugerido (cuando se implemente, en rama aparte)

1. Rama `feat/fusion-meli-seller-mcp` (nunca master).
2. Auth blindada (§3) + borrar los 2 blockers → **primero**, es el fix de seguridad.
3. Habilitar vitest + portar `auth-lock`/`fetchMock` (§4) → probar que el lock funciona antes de seguir.
4. Portar `mlGetAll` a `client.ts` + las 3 analytics TS-puras (`price_history`, `stockout_risk`, `price_to_win`) (§5).
5. `forecast_demand` detrás de flag + empaquetado del `.py` (§5.3).
6. Portar `pricing.test.ts`/`smoke.test.ts` adaptados (§4).
7. Bump versión + CHANGELOG (§7).
8. PR. Gate honesto (build+test re-corridos por orquestador). **Recién con OK: publish (§8) + registry (§9).**

---

## Resumen en 8 bullets

1. **Destino** `mercadolibre-mcp` (`@nahuelalbornoz/mercadolibre-mcp` v1.2.0-alpha.0, 5 capas, **con** write tools);
   **donante** `meli-seller-mcp` (MCP-first read-only, auth blindada, tests, analytics porteadas de haussman). Solo se
   edita el destino; donantes son lectura.
2. **Auth (Punto 1)**: reemplazar el interior de `src/auth.ts` por la lógica del donante (single-flight + lease CAS,
   **sin loguear tokens**), matando los 2 blockers (refresh sin lock en línea ~53; `refresh_token.substring(0,20)` en
   línea 87) **sin cambiar** la firma pública `getAccessToken(): Promise<string>` que usan `client.ts`/`upstream-proxy.ts`.
3. **Tests (Punto 2)**: habilitar vitest (devDep + script `test`), portar `fetchMock`/`auth-lock`/`pricing`/`smoke`
   adaptando imports; **no** portar `readonly-gate` (el destino no es read-only). Tests fuera del tarball.
4. **Analytics (Punto 3)**: portar `price_history`, `price_to_win`, `stockout_risk` (TS puro) y `forecast_demand`
   (Python/Prophet out-of-process, detrás de flag) a `src/tools/` con el patrón `server.tool()→content`, sumando un
   helper `mlGetAll` (paginado) a `client.ts`. Registrarlas en Capa 1 tras las 11 existentes (banner `1:ml(14/15)`).
5. **NO romper**: las 11 tools v1.0 (incl. 4 writes), upstream-proxy `official_*`, knowledge-tools Capa 2, los 3 modos
   de auth + env vars por default, y el contrato público de `auth.ts`. **Riesgo crítico**: no importar el gate
   read-only del donante (rompería los write tools).
6. **Migración**: copiar `0001_oauth_tokens_lease.sql` (RLS inline, service_role-only) **solo** si se adopta el lease CAS
   cross-proceso; la corrección del refresh-race no depende de ella (single-flight in-process basta sin Supabase).
7. **Versión**: bump a `1.2.0-alpha.1` en 3 puntos (`package.json`, `PACKAGE_VERSION` en `index.ts`, `McpServer`) +
   entrada nueva en `CHANGELOG.md` (Added/Security/Tests).
8. **Manual con OK de Nahuel**: re-publicación npm (`npm run build` → `npm test` → `npm pack --dry-run` audita tarball
   sin secretos → `npm publish --access public`) y registro en **MCP Registry oficial** (`server.json` + `mcp-publisher`)
   + actualizar **Smithery**. En esta sesión **NO** se publica, **NO** se deploya, entrega en **rama + PR**.
