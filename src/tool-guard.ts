// Candados del registro de tools.
//
// Dos candados independientes, ambos aplicados por `guardServer` a TODO registro
// de tool (Capa 0 proxy oficial, Capa 1 ML, Capa 2 knowledge):
//
// 1. Denylist de DESTRUCTIVAS/COMPRA (comprar, pagar, borrar, cancelar, reembolsar)
//    — SIEMPRE bloqueadas, no hay flag que las habilite. Corta el arranque si una
//    tool con ese tipo de nombre intentara registrarse, por más que alguien la
//    agregue por error.
// 2. Candado de ESCRITURA por defecto (`update_price`, `update_stock`,
//    `answer_question`, `manage_ads`): sólo se registran si `ML_WRITES_ENABLED`
//    está en `1`/`true`. Sin la env var, el server arranca READ-ONLY — el registro
//    de esas 4 tools tira, no sólo se omite silenciosamente. `ML_WRITES_ENABLED` es
//    un flag de producción (canon TRAID): default OFF.
//
// Cómo se aplica: index.ts envuelve el `McpServer` con `guardServer(...)` antes de
// pasarlo a los `register*`. Todo `server.tool(name, ...)` / `server.registerTool(name, ...)`
// pasa primero por `assertToolAllowed(name)`. index.ts además evita LLAMAR a los
// `register*` de escritura cuando el flag está apagado (para no ensuciar el log de
// arranque con errores esperados) — pero el gate de acá es la autoridad real: si
// algo (hoy o en el futuro, incluido el proxy oficial) intenta registrar una de
// estas 4 tools sin el flag, el gate corta igual.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/**
 * Superficie de ESCRITURA permitida a propósito (documental). Estas tools tocan
 * la tienda pero son operaciones de gestión esperadas, no compras/borrados. Sólo
 * se registran con `ML_WRITES_ENABLED=1` — ver `areWritesEnabled()`.
 */
export const WRITE_TOOL_ALLOWLIST = [
  'update_price',
  'update_stock',
  'answer_question',
  'manage_ads',
] as const

/**
 * Patrones de operaciones DESTRUCTIVAS / de COMPRA prohibidas. Si el nombre de una
 * tool matchea alguno, el registro falla (fail-fast al boot). Deliberadamente
 * conservador: cubre comprar/pagar/checkout, borrar/destruir/eliminar, cancelar y
 * reembolsar, en inglés y español.
 */
export const DESTRUCTIVE_TOOL_PATTERNS: RegExp[] = [
  /(^|_)buy(_|$)/i,
  /(^|_)purchase(_|$)/i,
  /(^|_)checkout(_|$)/i,
  /(^|_)comprar(_|$)/i,
  /(^|_)delete(_|$)/i,
  /(^|_)destroy(_|$)/i,
  /(^|_)remove(_|$)/i,
  /(^|_)borrar(_|$)/i,
  /(^|_)eliminar(_|$)/i,
  /(^|_)cancel(_|$)/i,
  /(^|_)cancelar(_|$)/i,
  /(^|_)refund(_|$)/i,
  /(^|_)reembolso(_|$)/i,
  /(^|_)pay(ment)?(_|$)/i,
]

/** ¿El nombre de la tool cae en la clase destructiva/compra? */
export function isDestructiveToolName(name: string): boolean {
  return DESTRUCTIVE_TOOL_PATTERNS.some((re) => re.test(name))
}

/** ¿El nombre es una de las 4 tools de escritura permitidas a propósito? */
export function isWriteToolName(name: string): boolean {
  return (WRITE_TOOL_ALLOWLIST as readonly string[]).includes(name)
}

/**
 * ¿Están habilitadas las escrituras? Flag de producción, default OFF (read-only).
 * Valores que habilitan (case-insensitive, con espacios recortados): `1`, `true`.
 * Cualquier otro valor (incluido no seteada) deja el server en modo lectura.
 */
export function areWritesEnabled(): boolean {
  const raw = (process.env.ML_WRITES_ENABLED || '').trim().toLowerCase()
  return raw === '1' || raw === 'true'
}

/**
 * Corta el arranque si:
 *  - una tool destructiva/de compra intenta registrarse (siempre, sin excepción), o
 *  - una tool de escritura (update_price/update_stock/answer_question/manage_ads)
 *    intenta registrarse sin `ML_WRITES_ENABLED=1`.
 */
export function assertToolAllowed(name: string): void {
  if (isDestructiveToolName(name)) {
    throw new Error(
      `[gate] tool '${name}' bloqueada: operación destructiva o de compra no permitida en este servidor.`
    )
  }
  if (isWriteToolName(name) && !areWritesEnabled()) {
    throw new Error(
      `[gate] tool '${name}' bloqueada: escritura deshabilitada por defecto. ` +
        `Este servidor arranca READ-ONLY — setear ML_WRITES_ENABLED=1 explícitamente ` +
        `(env del cliente MCP, nunca hardcodeado) para habilitar precio/stock/respuestas/ads.`
    )
  }
}

/**
 * Envuelve el server para que TODO registro de tool pase por el gate. Devuelve un
 * proxy que delega en el server real, interceptando `tool` y `registerTool` (el
 * nombre es el primer argumento en ambas APIs del SDK).
 */
export function guardServer(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'tool' || prop === 'registerTool') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- frontera con el SDK
        const orig = Reflect.get(target, prop, receiver) as (...args: any[]) => unknown
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- passthrough al SDK
        return (...args: any[]) => {
          const name = args[0]
          if (typeof name === 'string') assertToolAllowed(name)
          return orig.apply(target, args)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as McpServer
}
