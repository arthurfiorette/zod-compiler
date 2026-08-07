import type { SchemaIR } from "../../types.js";
import { makeRecursiveRef } from "../recursion.js";
import type { ExtractorContext, ZodSchema } from "../types.js";

export function extractLazy(_def: unknown, ctx: ExtractorContext): SchemaIR {
  const schema = ctx.schema as ZodSchema;
  const innerSchema = schema._zod.innerType;
  if (!innerSchema) {
    return ctx.fallback("lazy");
  }
  // Cycle detected one level early: the resolved schema is already being
  // extracted, so the lazy wrapper itself becomes the back-edge and dispatch is
  // never re-entered for the target. Keyed on the RESOLVED schema so this and
  // dispatch's own getter-cycle detector mint identical refIds.
  if (ctx.visiting.has(innerSchema)) {
    return makeRecursiveRef(innerSchema, ctx.recursion);
  }
  return ctx.visit(innerSchema, "._zod.innerType");
}
