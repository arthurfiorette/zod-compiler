import type { EnumIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { emitSet, ENUM_INLINE_THRESHOLD, escapeString } from "../context.js";
import { emit } from "../emit.js";
import { invalidValue } from "../emit-issue.js";

/**
 * An enum can legitimately accept NOTHING, and it is reachable three ways
 * through the public API: `z.enum([])`, `z.enum({})`, and — the non-obvious one
 * — `z.enum([1, 2])`, a NUMERIC ARRAY. Zod turns that array into the entries
 * `{1: 1, 2: 2}`, which is indistinguishable from a TS numeric enum's reverse
 * mapping, so its reverse-mapping filter strips every entry back out and leaves
 * `_zod.values` empty. Zod then rejects every input with `invalid_value` and
 * `values: []`, and the compiled validator must do the same.
 *
 * Zero values must be special-cased because both code paths build their test by
 * JOINING per-value comparisons: an empty join yields an empty STRING, emitting
 * `if(){...}` and `return ();` — not a wrong validator but an unparseable one,
 * so the whole compile died with a SyntaxError.
 *
 * (`z.literal()` joins the same way but needs no such guard: zod throws
 * "Cannot create literal schema with no valid values" at construction, so an
 * empty literal never reaches codegen.)
 */
function isEmpty(ir: EnumIR): boolean {
  return ir.values.length === 0;
}

export function slowEnum(ir: EnumIR, g: SlowGen): string {
  const valuesExpr = JSON.stringify(ir.values);
  if (isEmpty(ir)) {
    // Nothing to compare against — every input is invalid, so push the issue
    // unconditionally rather than guarding it with an empty condition.
    return `${emit`
      ${invalidValue(g, valuesExpr)}
    `}\n`;
  }
  if (ir.values.length <= ENUM_INLINE_THRESHOLD) {
    // Inline equality checks for small enums (avoids Set allocation in preamble)
    const condition = ir.values.map((v) => `${g.input}!==${escapeString(v)}`).join("&&");
    return `${emit`
      if(${condition}){
        ${invalidValue(g, valuesExpr)}
      }
    `}\n`;
  }
  const setVar = g.set("enum", ir.values);
  return `${emit`
    if(!${setVar}.has(${g.input})){
      ${invalidValue(g, valuesExpr)}
    }
  `}\n`;
}

export function fastEnum(ir: EnumIR, g: FastGen): string {
  const x = g.input;
  // See isEmpty: an accepted-value set can be empty, and an empty `||` join
  // would emit `()`. Nothing is ever accepted, so the fast check is constant.
  if (isEmpty(ir)) return "false";
  if (ir.values.length <= ENUM_INLINE_THRESHOLD) {
    // Inline equality checks for small enums, wrapped in parens for precedence safety
    return `(${ir.values.map((v) => `${x}===${escapeString(v)}`).join("||")})`;
  }
  // Use Set for larger enums. Routed through emitSet so the fast check and the
  // slow walk share one declaration instead of emitting the value list twice.
  return `${emitSet(g.ctx, "enum", ir.values)}.has(${x})`;
}
