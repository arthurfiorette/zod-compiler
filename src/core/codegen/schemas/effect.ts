import type {
  PreprocessEffectIR,
  RefineEffectCheckIR,
  SuperRefineEffectCheckIR,
  TransformEffectIR,
} from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import {
  emitEffectCallable,
  emitRuntimeHelper,
  extendStaticPath,
  extendStaticPathIndex,
} from "../context.js";
import { emit } from "../emit.js";
import { ZC_SR_DECL, ZC_SR_OK_DECL, ZC_SR_RUN_DECL } from "../issue-decls.js";

/**
 * Generate code for a TransformEffectIR node.
 * Validates the inner schema, then applies the transform function and writes back the result.
 */
export function slowEffect(ir: TransformEffectIR | PreprocessEffectIR, g: SlowGen): string {
  if (ir.effectKind === "preprocess") {
    const valueVar = g.temp("pv");
    return `${emit`
      var ${valueVar}=${emitEffectCallable(g.ctx, ir)}(${g.input});
      ${g.output}=${valueVar};
      ${g.visit(ir.inner, { input: valueVar, output: g.output, aborted: g.aborted })}
    `}\n`;
  }

  const beforeVar = g.temp("ib");
  const innerCode = g.visit(ir.inner);
  // A transform is `inner.transform(fn)` = a pipe(inner, transform): zod's
  // handlePipeResult aborts when `inner` produces any issue. Inside a union the
  // option must therefore count as aborted even if `inner`'s only issue is a
  // non-aborting `custom`/check-level code (mirrors slowPipe's abort branch).
  const abortBranch = g.aborted ? `else{${g.aborted}=true;}` : "";

  return `${emit`
    var ${beforeVar}=${g.issues}.length;
    ${innerCode}
    if(${g.issues}.length===${beforeVar}){
      ${g.output}=${emitEffectCallable(g.ctx, ir)}(${g.output});
    }${abortBranch}
  `}\n`;
}

/**
 * Generate code for a RefineEffectCheckIR (inline refine function call).
 * Called from string/number/object check loops when a refine_effect is encountered.
 *
 * @param check - The refine effect check IR
 * @param expr - The expression to validate (may differ from g.input, e.g. objVar in object generators)
 * @param g - SlowGen context (provides path, issues)
 */
export function refineCheck(check: RefineEffectCheckIR, expr: string, g: SlowGen): string {
  // Custom issues are created by the refine check instance, so only the
  // refine's own message applies (never the schema-level error). With no
  // message baked in, __zcFin applies the locale default ("Invalid input").
  const messageProp =
    check.message === undefined ? "" : `,message:${JSON.stringify(check.message)}`;
  // `.refine(fn, { path })` reports against a member of the refined value, so
  // the configured segments extend this node's path.
  const path = (check.path ?? []).reduce<string>(
    (acc, segment) =>
      typeof segment === "number"
        ? extendStaticPathIndex(acc, segment)
        : extendStaticPath(acc, segment),
    g.path,
  );
  return emit`
    if(!${emitEffectCallable(g.ctx, check)}(${expr})){
      ${g.issues}.push({code:"custom",path:${path}${messageProp},input:${expr}});
    }`;
}

/**
 * Declare the shared invoker both superRefine helpers call. It is module-local
 * rather than an imported helper (lean mode declares it in the runtime module
 * beside them), so inline mode must place it in the preamble itself.
 */
function emitSuperRefineRunner(ctx: SlowGen["ctx"]): void {
  if (ctx.mode !== "lean" && !ctx.preamble.includes(ZC_SR_RUN_DECL)) {
    ctx.preamble.push(ZC_SR_RUN_DECL);
  }
}

/**
 * Fast-path test for a SuperRefineEffectCheckIR: a boolean term reporting that
 * the callback added no issue and left the value alone (see ZC_SR_OK_DECL).
 */
export function superRefineFastTest(
  check: SuperRefineEffectCheckIR,
  expr: string,
  g: FastGen,
): string {
  emitSuperRefineRunner(g.ctx);
  const ok = emitRuntimeHelper(g.ctx, "__zcSrOk", ZC_SR_OK_DECL);
  return `${ok}(${emitEffectCallable(g.ctx, check)},${expr})`;
}

/**
 * Generate code for a SuperRefineEffectCheckIR: call the payload-taking
 * callback with a synthesized `{ value, issues }` and merge what it collected.
 * zod's own wrapper installs `addIssue` and normalizes the result, so the
 * issues are zod's — the helper only reprojects them onto this node's path and
 * strips the internal bookkeeping zod deletes before they become visible.
 *
 * The payload's `value` is writable public API, so it is written back to the
 * output slot the way an overwrite effect is. This walk is always the eager one
 * (the node reports as mutating, see hasMutation), so the write-back lands on
 * every parse that reaches it — not only on failures.
 */
export function superRefineCheck(
  check: SuperRefineEffectCheckIR,
  expr: string,
  g: SlowGen,
): string {
  emitSuperRefineRunner(g.ctx);
  const helper = emitRuntimeHelper(g.ctx, "__zcSr", ZC_SR_DECL);
  const fn = emitEffectCallable(g.ctx, check);
  const p = g.temp("sp");
  let code = `var ${p}=${helper}(${fn},${expr},${g.path},${g.issues});${g.output}=${p}.value;`;
  // Inside a union option, an aborting issue must mark the option aborted so
  // pruning matches zod (see ZC_SR_DECL); elsewhere the flag is unobserved.
  if (g.aborted) code += `if(${p}.aborted){${g.aborted}=true;}`;
  return code;
}
