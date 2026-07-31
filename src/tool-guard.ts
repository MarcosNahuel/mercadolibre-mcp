// Candados del registro de tools.
//
// Este paquete EXPONE tools de escritura a propósito (precio, stock, respuestas,
// ads) — no es read-only. Pero hay una clase de operaciones que NUNCA debe
// registrarse ni exponerse: compras y operaciones destructivas (comprar, pagar,
// borrar, cancelar, reembolsar). Este gate corta el arranque si una tool con ese
// tipo de nombre intentara registrarse, por más que alguien la agregue por error.
//
// Cómo se aplica: index.ts envuelve el `McpServer` con `guardServer(...)` antes de
// pasarlo a los `register*`. Todo `server.tool(name, ...)` / `server.registerTool(name, ...)`
// pasa primero por `assertToolAllowed(name)`.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/**
 * Superficie de ESCRITURA permitida a propósito (documental). Estas tools tocan
 * la tienda pero son operaciones de gestión esperadas, no compras/borrados.
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

/** Corta el arranque si una tool destructiva/de compra intenta registrarse. */
export function assertToolAllowed(name: string): void {
  if (isDestructiveToolName(name)) {
    throw new Error(
      `[gate] tool '${name}' bloqueada: operación destructiva o de compra no permitida en este servidor.`
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
