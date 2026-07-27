import type { SchemaIR } from "../../types.js";
import { isReferenceablePredicate, tryCompileEffect } from "../effects.js";
import type { ExtractorContext, ZodDef } from "../types.js";
import { extractStringBool, isStringBoolCodec } from "./string-bool.js";

export function extractPipe(def: ZodDef, ctx: ExtractorContext): SchemaIR {
  // Detect stringbool Codec (string→boolean with transform + reverseTransform)
  if (isStringBoolCodec(def)) {
    const ir = extractStringBool(def, ctx);
    if (ir) return ir;
    // Probing failed — fall back to Zod
    return ctx.fallback("transform");
  }

  // Other Codecs (z.codec): the decode transform lives on the pipe def itself.
  // Compiling in/out as a plain pipe would validate the untransformed value
  // against the output schema — delegate to Zod.
  if (def.transform !== undefined) {
    return ctx.fallback("transform");
  }

  const outDef = def.out?._zod?.def;
  if (outDef && outDef.type === "transform") {
    const source = tryCompileEffect(outDef.transform);
    if (source) {
      const inIR = ctx.visit(def.in, "._zod.def.in");
      return { type: "effect", effectKind: "transform", source, inner: inIR };
    }
    // Not inlineable (the callback captures). Call the user's own function
    // through a schema reference rather than delegating: falling back costs the
    // schema its compiled path AND adds the delegate wrapper on top, which
    // measured SLOWER than plain zod. A two-argument transform is zod's `ctx`
    // protocol and an async one returns a promise, so both still delegate.
    if (ctx.refs && isReferenceablePredicate(outDef.transform)) {
      const refIndex = ctx.refs.length;
      ctx.refs.push({
        schema: outDef.transform,
        accessPath: `${ctx.path}._zod.def.out._zod.def.transform`,
      });
      const inIR = ctx.visit(def.in, "._zod.def.in");
      return { type: "effect", effectKind: "transform", refIndex, inner: inIR };
    }
    return ctx.fallback("transform");
  }
  const inIR = ctx.visit(def.in, "._zod.def.in");
  const outIR = ctx.visit(def.out, "._zod.def.out");
  return { type: "pipe", in: inIR, out: outIR };
}
