import type { UnpluginOptions } from "unplugin";

export type TransformHandler = (
  code: string,
  id: string,
) => Promise<{ code: string; map: unknown } | undefined>;

/**
 * transform/load/resolveId are declared as unplugin object hooks
 * (`{ filter, handler }`) so bundlers can filter modules natively instead of
 * calling into JS for every file. Tests drive the handler directly; the
 * filters are asserted on their own.
 */
export function transformHandler(plugin: UnpluginOptions): TransformHandler {
  const hook = plugin.transform;
  if (typeof hook !== "object") throw new TypeError("transform is not an object hook");
  return hook.handler as unknown as TransformHandler;
}

/** The declared `filter` of an object hook, for wiring assertions. */
export function hookFilter(
  hook: UnpluginOptions["transform" | "load" | "resolveId"],
): { code?: unknown; id?: unknown } | undefined {
  if (typeof hook !== "object") throw new TypeError("hook is not an object hook");
  return hook.filter;
}
