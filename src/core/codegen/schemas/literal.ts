import type { LiteralIR, LiteralValue } from "../../types.js";
import type { CodeGenContext, FastGen, SlowGen } from "../context.js";
import { emitConstant, hasSourceForm, literalToJs } from "../context.js";
import { emit } from "../emit.js";
import { invalidValue } from "../emit-issue.js";

/**
 * The literal schema's OWN `def.values` array, aliased into a preamble binding.
 *
 * Used when at least one value has no JS source form (a symbol, an object): the
 * accepted set cannot be written into the generated source, so it is READ from
 * the retained schema instead — the same `__rf[N]` route `.default()` uses for
 * its default value.
 *
 * `Array.prototype.includes` compares with SameValueZero, which is precisely
 * what zod's `new Set(def.values).has(input)` does — NaN matches NaN, `-0`
 * matches `+0` — so the verdict is identical without materializing a Set. The
 * same binding also feeds the issue's `values` field, where zod likewise
 * reports `def.values` itself.
 */
function runtimeValues(ctx: CodeGenContext, refIndex: number): string {
  return emitConstant(ctx, "lv", `__rf[${refIndex}]._zod.def.values`);
}

/**
 * `[v1,v2,...]` source for the invalid_value issue's `values` field. Only
 * reached on the all-spellable branch (an unspellable value routes through
 * {@link runtimeValues}), so the filter drops nothing; it is what lets
 * `literalToJs` keep its narrow parameter type. Without a guard here `join`
 * rendered an unspellable value as an ARRAY HOLE — `values:[,"b"]` — which is
 * neither what zod reports nor a well-formed value list.
 */
function valuesJs(values: readonly LiteralValue[]): string {
  return `[${values.filter(hasSourceForm).map(literalToJs).join(",")}]`;
}

/**
 * Equality test `x === value`, except for the literal NaN value: `NaN === NaN`
 * is false under `===`, but zod accepts NaN against `z.literal(NaN)` by value, so
 * a NaN literal compares via `Number.isNaN`. (Infinity/-Infinity compare fine
 * under `===` once literalToJs emits them as the right expression.)
 */
function literalEq(x: string, v: LiteralValue): string {
  if (typeof v === "number" && Number.isNaN(v)) return `Number.isNaN(${x})`;
  if (!hasSourceForm(v)) {
    // Unreachable: a node holding an unspellable value carries `refIndex`, and
    // both generators take the runtime-values branch before reaching here.
    throw new Error("literal value has no JS source form and no runtime ref");
  }
  return `${x}===${literalToJs(v)}`;
}

export function slowLiteral(ir: LiteralIR, g: SlowGen): string {
  if (ir.refIndex !== undefined) {
    const values = runtimeValues(g.ctx, ir.refIndex);
    return emit`
      if(!${values}.includes(${g.input})){
        ${invalidValue(g, values)}
      }
    `;
  }

  if (ir.values.length === 1) {
    return emit`
      if(!(${literalEq(g.input, ir.values[0])})){
        ${invalidValue(g, valuesJs(ir.values))}
      }
    `;
  }

  const valueChecks = ir.values.map((v) => literalEq(g.input, v)).join("||");

  return emit`
    if(!(${valueChecks})){
      ${invalidValue(g, valuesJs(ir.values))}
    }
  `;
}

export function fastLiteral(ir: LiteralIR, g: FastGen): string {
  const x = g.input;
  // A call expression binds tighter than any operator it gets spliced into, so
  // this needs no parens of its own.
  if (ir.refIndex !== undefined) return `${runtimeValues(g.ctx, ir.refIndex)}.includes(${x})`;
  if (ir.values.length === 1) {
    return literalEq(x, ir.values[0]);
  }
  // Wrap in parens — || has lower precedence than && in parent expressions
  return `(${ir.values.map((v) => literalEq(x, v)).join("||")})`;
}
