import type { CustomIR, SchemaIR } from "../../types.js";
import { isReferenceablePredicate, tryCompileEffect } from "../effects.js";
import type { ExtractorContext, ZodDef } from "../types.js";

/**
 * Compile z.custom() and z.instanceof() as pure predicates. The predicate is
 * enough for the total hot-path verdict; the original schema is retained so a
 * failed parse can delegate issue construction to Zod on the cold path.
 */
export function extractCustom(def: ZodDef, ctx: ExtractorContext): SchemaIR {
  const refs = ctx.refs;
  if (!refs || !isReferenceablePredicate(def.fn)) return ctx.fallback("custom");

  const source = tryCompileEffect(def.fn);
  let refIndex: number | undefined;
  if (source === undefined) {
    refIndex = refs.length;
    refs.push({ schema: def.fn, accessPath: `${ctx.path}._zod.def.fn` });
  }

  const schemaRefIndex = refs.length;
  refs.push({ schema: ctx.schema, accessPath: ctx.path });

  return {
    type: "custom",
    ...(source === undefined ? { refIndex: refIndex as number } : { source }),
    schemaRefIndex,
    abort: def.abort !== false,
  } satisfies CustomIR;
}
