import type { SchemaIR } from "../../types.js";
import type { ExtractorContext, ZodDef, ZodSchema } from "../types.js";

/**
 * Port of `$ZodTuple`'s own `optStart` computation, run against the LIVE item
 * schemas:
 *
 * ```js
 * const reversedIndex = [...items].reverse().findIndex((i) => i._zod.optin !== "optional");
 * const optStart = reversedIndex === -1 ? 0 : items.length - reversedIndex;
 * ```
 *
 * i.e. the start of the trailing run of optional-in items (0 when every item is
 * optional-in). See {@link TupleIR.optStart} for why this is read from the zod
 * schema rather than inferred from the extracted IR.
 */
function computeOptStart(items: unknown[]): number {
  let start = items.length;
  for (let i = items.length - 1; i >= 0; i--) {
    if ((items[i] as ZodSchema | undefined)?._zod?.optin !== "optional") break;
    start--;
  }
  return start;
}

export function extractTuple(def: ZodDef, ctx: ExtractorContext): SchemaIR {
  const items = def.items.map((item, i) => ctx.visit(item, `._zod.def.items[${i}]`));
  const rest = def.rest ? ctx.visit(def.rest, "._zod.def.rest") : null;
  return { type: "tuple", items, rest, optStart: computeOptStart(def.items) };
}
