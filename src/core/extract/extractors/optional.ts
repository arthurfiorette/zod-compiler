import { hasMutation } from "../../codegen/context.js";
import { innerAppliesDefaultOnUndefined } from "../../codegen/schemas/optional.js";
import type { SchemaIR } from "../../types.js";
import type { Extractor, ZodSchema } from "../types.js";

/**
 * Running `ir` on `undefined` provably leaves the value `undefined` — whether it
 * accepts (yielding undefined) or rejects (leaving the payload untouched).
 *
 * This is the condition under which the compiled optional's `if (input !==
 * undefined)` short-circuit is EQUIVALENT to zod's optin branch, which runs the
 * inner and then nullifies a failure whose value is still undefined
 * (`handleOptionalResult`). Both end at "success, undefined".
 *
 * `!hasMutation` is exactly the property needed at the bottom of the chain: a
 * node that cannot rewrite values cannot turn `undefined` into one. The three
 * named wrappers recurse because they pass `undefined` straight through
 * (`$ZodNullable` only intercepts `null`, `$ZodReadonly` freezes the result, and
 * a nested `$ZodOptional` short-circuits or forwards). Everything else —
 * `default`, `catch`, an effect, and above all a `fallback` leaf standing in for
 * `z.prefault()` / a pipe / a union — reports mutating and is handled by the
 * caller instead.
 */
function passesUndefinedThrough(ir: SchemaIR): boolean {
  switch (ir.type) {
    case "optional":
    case "nullable":
    case "readonly":
      return passesUndefinedThrough(ir.inner);
    default:
      return !hasMutation(ir);
  }
}

export const extractOptional: Extractor = (def, ctx) => {
  // z.exactOptional() shares def.type "optional" but rejects explicit
  // `undefined` (only a missing key is allowed) — compiled optionals accept
  // undefined, so delegate to Zod. Detectable only via constructor traits.
  const traits = (ctx.schema as ZodSchema | undefined)?._zod?.traits;
  if (traits?.has("$ZodExactOptional")) {
    return ctx.fallback("unsupported");
  }
  const inner = ctx.visit(def.innerType, "._zod.def.innerType");

  // `$ZodOptional.parse` has TWO branches, chosen by the inner schema's `optin`:
  //
  //   if (innerType._zod.optin === "optional")   // inner consumes `undefined` itself
  //     return handleOptionalResult(innerType._zod.run(payload, ctx), payload.value);
  //   if (payload.value === undefined) return payload;   // short-circuit
  //   return innerType._zod.run(payload, ctx);
  //
  // Compiled output models the short-circuit, plus the one first-branch case
  // that matters in practice: a `.default()` beneath, which must SEE the
  // undefined so the default fires (`z.string().default("d").optional()` is
  // "d", not undefined).
  //
  // Every other optional-in inner — `z.prefault()`, `z.exactOptional()`,
  // `.nonoptional()`, a pipe, a union with an optional-in option, all of which
  // extract to an opaque `fallback` — can substitute a value for `undefined`
  // where the short-circuit would answer `undefined`, and the compiler cannot
  // see through the delegate to tell which. Worse, zod reads `payload.value`
  // AFTER the inner has run, so a prefault that fails its own checks keeps the
  // failure (the value is no longer undefined) — behaviour with no counterpart
  // here. Delegate the whole optional to zod rather than guess.
  const innerOptin = (def.innerType as ZodSchema | undefined)?._zod?.optin === "optional";
  if (innerOptin && !innerAppliesDefaultOnUndefined(inner) && !passesUndefinedThrough(inner)) {
    return ctx.fallback("unsupported");
  }

  return { type: "optional", inner };
};
