import type { TemplateLiteralIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { emitRegexSourceString } from "../context.js";
import { emit } from "../emit.js";
import { invalidFormat, invalidType } from "../emit-issue.js";
import { fastTestSource } from "../well-known-regex.js";

export function slowTemplateLiteral(ir: TemplateLiteralIR, g: SlowGen): string {
  const regexVar = g.regex("tl", ir.pattern);
  // Same rule as slowString: when emitRegex swapped in a faster equivalent
  // pattern, the runtime regex's toString() would leak the rewrite into the
  // issue, so the ORIGINAL source string is referenced instead.
  const patternExpr =
    fastTestSource(ir.pattern) === null
      ? `${regexVar}.toString()`
      : emitRegexSourceString(g.ctx, ir.pattern);
  return `${emit`
    if(typeof ${g.input}!=="string"){
      ${invalidType(g, "string")}
    }else if(!${regexVar}.test(${g.input})){
      ${invalidFormat(g, "template_literal", { extra: `pattern:${patternExpr}` })}
    }`}\n`;
}

export function fastTemplateLiteral(ir: TemplateLiteralIR, g: FastGen): string | null {
  const regexVar = g.regex("tl", ir.pattern);
  return `typeof ${g.input}==="string"&&${regexVar}.test(${g.input})`;
}
