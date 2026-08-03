import type { CustomIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { emitEffectCallable, emitRuntimeHelper } from "../context.js";
import { ZC_CUSTOM_OK_DECL } from "../issue-decls.js";
import { slowZodDelegate } from "./fallback.js";

/** Total hot-path predicate for z.custom() and z.instanceof(). */
export function fastCustom(ir: CustomIR, g: FastGen): string {
  const ok = emitRuntimeHelper(g.ctx, "__zcCu", ZC_CUSTOM_OK_DECL);
  return `${ok}(${emitEffectCallable(g.ctx, ir)},${g.input})`;
}

/** Let Zod construct the exact custom/instanceof issue only after rejection. */
export function slowCustom(ir: CustomIR, g: SlowGen): string {
  const onFailure = ir.abort && g.aborted ? `${g.aborted}=true;` : "";
  return slowZodDelegate(ir.schemaRefIndex, g, onFailure);
}
