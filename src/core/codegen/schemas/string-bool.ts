import type { StringBoolIR } from "../../types.js";
import type { CodeGenContext, SlowGen } from "../context.js";
import { ENUM_INLINE_THRESHOLD, emitConstant, escapeString } from "../context.js";
import { emit } from "../emit.js";
import { invalidType, invalidValue } from "../emit-issue.js";

export function slowStringBool(ir: StringBoolIR, g: SlowGen): string {
  let code = "";

  // Type check: input must be a string
  code += emit`
    if(typeof ${g.input}!=="string"){
      ${invalidType(g, "string")}
    }else{
  `;

  // Normalize input for case-insensitive matching
  const normalized = ir.caseSensitive ? g.input : g.temp("sbn");
  if (!ir.caseSensitive) code += `var ${normalized}=${g.input}.toLowerCase();`;
  const allValues = [...ir.truthy, ...ir.falsy];
  const valuesExpr = JSON.stringify(allValues);
  // z.stringbool() is a Codec whose transform pushes
  // `{ code: "invalid_value", expected: "stringbool", values: [...] }` — the
  // only invalid_value producer that carries an `expected` (enum and literal
  // push `values` alone), and zod's locale keys off it. Both emitted lookups
  // below share this so the two code paths cannot drift apart.
  const expectedExtra = 'expected:"stringbool"';

  // Compare per-side counts against threshold (not the combined total)
  const useInline = stringBoolUsesInline(ir);

  if (useInline) {
    const truthyCondition = ir.truthy.map((v) => `${normalized}===${escapeString(v)}`).join("||");
    const falsyCondition = ir.falsy.map((v) => `${normalized}===${escapeString(v)}`).join("||");
    code += emit`
      if(${truthyCondition}){${g.output}=true;}
      else if(${falsyCondition}){${g.output}=false;}
      else{${invalidValue(g, valuesExpr, { extra: expectedExtra })}}
    `;
  } else {
    const value = g.temp("sbv");
    const lookup = emitStringBoolMap(ir, g.ctx);
    code += emit`
      var ${value}=${lookup}.get(${normalized});
      if(${value}===undefined){${invalidValue(g, valuesExpr, { extra: expectedExtra })}}
      else{${g.output}=${value};}
    `;
  }

  code += emit`}`;
  return `${code}\n`;
}

export function stringBoolUsesInline(ir: StringBoolIR): boolean {
  return ir.truthy.length <= ENUM_INLINE_THRESHOLD && ir.falsy.length <= ENUM_INLINE_THRESHOLD;
}

/** One lookup distinguishes true, false and absent; shared by hot and issue walks. */
export function emitStringBoolMap(ir: StringBoolIR, ctx: CodeGenContext): string {
  const pairs = [
    ...ir.truthy.map((value) => [value, true]),
    ...ir.falsy.map((value) => [value, false]),
  ];
  return emitConstant(ctx, "map_sb", `new Map(${JSON.stringify(pairs)})`);
}
