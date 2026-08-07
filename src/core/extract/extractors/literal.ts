import { hasSourceForm } from "../../codegen/context.js";
import type { Extractor } from "../types.js";

/**
 * z.literal(). Values with a JS source form compile to an inline `===` chain;
 * anything else — a symbol, an object — has none, so the node retains the
 * ORIGINAL schema in `__rf[]` and codegen tests membership against its own
 * `_zod.def.values` at runtime. `Array.prototype.includes` is SameValueZero,
 * exactly the comparison zod's `new Set(def.values).has(input)` performs, and
 * reporting that same array as the issue's `values` is exactly what zod reports.
 *
 * Zod's public argument type (`util.Literal`) admits none of these, but its
 * runtime accepts them and its own parse ACCEPTS the matching value — so
 * `z.literal(someSymbol)` is a schema that really works, and previously
 * compiled to `x===undefined` (see `hasSourceForm`): it rejected the very symbol
 * it was built from and accepted `undefined`.
 */
export const extractLiteral: Extractor = (def, ctx) => {
  if (def.values.every(hasSourceForm)) {
    return { type: "literal", values: def.values };
  }
  // Same constraint as default/catch: without a ref table there is nowhere to
  // reach the value list from, so the schema has to stay with zod.
  if (!ctx.refs) return ctx.fallback("unsupported");
  const refIndex = ctx.refs.length;
  ctx.refs.push({ schema: ctx.schema, accessPath: ctx.path });
  return { type: "literal", values: def.values, refIndex };
};
