/**
 * Issue factory function bodies (statement form).
 *
 * These functions produce the same `{code, ...}` shapes that lean-mode
 * generated code would otherwise inline at every check site.
 * Hosted in "virtual:zod-compiler/runtime" and called as `__zcTS(...)` etc.
 *
 * Argument convention (positional, kept short to minimize call-site bytes):
 *   __zcTS(minimum, origin, inclusive, input, path, msg?)  — too_small
 *   __zcTSn(minimum, origin, input, path, msg?)            — too_small with NO `inclusive` key
 *   __zcTB(maximum, origin, inclusive, input, path, msg?)  — too_big
 *   __zcIT(expected, input, path, msg?)                    — invalid_type
 *   __zcIF(format, input, path, extra?, msg?)              — invalid_format (extra merged into result)
 *   __zcIV(values, input, path, extra?, msg?)              — invalid_value (extra merged into result)
 *   __zcUK(keys, input, path, msg?)                        — unrecognized_keys
 *
 * The trailing msg argument carries a static custom error message; when
 * absent, the __zcFin finalizer applies the configured locale default.
 */

const ZC_TS_DECL =
  'function __zcTS(m,o,i,inp,p,msg){var r={code:"too_small",minimum:m,origin:o,inclusive:i,input:inp,path:p};if(msg!==undefined)r.message=msg;return r;}';

/**
 * too_small with the `inclusive` key ABSENT, not false. $ZodTuple's under-length
 * branch pushes `{ code: "too_small", minimum: items.length }` and nothing else
 * — the over-length branch of the same ternary is the one that spells out
 * `inclusive: true` — so the tuple's issue must not carry the key at all.
 * Separate from __zcTS because the value cannot express absence.
 */
const ZC_TS_NO_INCLUSIVE_DECL =
  'function __zcTSn(m,o,inp,p,msg){var r={code:"too_small",minimum:m,origin:o,input:inp,path:p};if(msg!==undefined)r.message=msg;return r;}';

const ZC_TS_EXACT_DECL =
  'function __zcTSx(m,o,inp,p,msg){var r={code:"too_small",minimum:m,origin:o,inclusive:true,exact:true,input:inp,path:p};if(msg!==undefined)r.message=msg;return r;}';

const ZC_TB_DECL =
  'function __zcTB(m,o,i,inp,p,msg){var r={code:"too_big",maximum:m,origin:o,inclusive:i,input:inp,path:p};if(msg!==undefined)r.message=msg;return r;}';

const ZC_TB_EXACT_DECL =
  'function __zcTBx(m,o,inp,p,msg){var r={code:"too_big",maximum:m,origin:o,inclusive:true,exact:true,input:inp,path:p};if(msg!==undefined)r.message=msg;return r;}';

const ZC_IT_DECL =
  'function __zcIT(e,inp,p,msg){var r={code:"invalid_type",expected:e,input:inp,path:p};if(msg!==undefined)r.message=msg;return r;}';

const ZC_IF_DECL =
  'function __zcIF(f,inp,p,extra,msg){var r={code:"invalid_format",format:f,input:inp,path:p};if(extra)Object.assign(r,extra);if(msg!==undefined)r.message=msg;return r;}';

/**
 * `extra` carries the per-producer fields: enum and literal push `values` only,
 * while z.stringbool()'s codec transform also pushes `expected: "stringbool"`.
 * Merged the same way __zcIF merges its own.
 */
const ZC_IV_DECL =
  'function __zcIV(values,inp,p,extra,msg){var r={code:"invalid_value",values:values,input:inp,path:p};if(extra)Object.assign(r,extra);if(msg!==undefined)r.message=msg;return r;}';

const ZC_UK_DECL =
  'function __zcUK(k,inp,p,msg){var r={code:"unrecognized_keys",keys:k,input:inp,path:p};if(msg!==undefined)r.message=msg;return r;}';

/** All issue factory declarations indexed by helper name. */
export const ISSUE_DECLS: Readonly<Record<string, string>> = {
  __zcTS: ZC_TS_DECL,
  __zcTSn: ZC_TS_NO_INCLUSIVE_DECL,
  __zcTSx: ZC_TS_EXACT_DECL,
  __zcTB: ZC_TB_DECL,
  __zcTBx: ZC_TB_EXACT_DECL,
  __zcIT: ZC_IT_DECL,
  __zcIF: ZC_IF_DECL,
  __zcIV: ZC_IV_DECL,
  __zcUK: ZC_UK_DECL,
};

/**
 * Float-safe remainder — byte-for-byte port of zod's util.floatSafeRemainder.
 * Raw `%` mis-rejects valid multiples of decimal steps (0.3 % 0.1 !== 0);
 * zod scales both operands to integers by their decimal-place count first.
 */
export const ZC_FSR_DECL =
  'function __zcFsr(v,s){var vd=((""+v).split(".")[1]||"").length;var ss=""+s;var sd=(ss.split(".")[1]||"").length;if(sd===0&&/\\d?e-\\d?/.test(ss)){var m=ss.match(/\\d?e-(\\d?)/);if(m&&m[1]){sd=parseInt(m[1],10);}}var d=vd>sd?vd:sd;var vi=parseInt(v.toFixed(d).replace(".",""),10);var si=parseInt(s.toFixed(d).replace(".",""),10);return (vi%si)/Math.pow(10,d);}';

/**
 * Hoisted `Object.prototype.hasOwnProperty` reference. Record fast/slow paths
 * iterate keys with `for(k in o)` (no `Object.keys` array allocation) and guard
 * each key with `__zcHop.call(o,k)` to skip inherited enumerable properties —
 * yielding the exact own-enumerable string-key set `Object.keys` would, so
 * fast/slow stay in agreement and parity with zod's own-key record semantics is
 * preserved. The hoisted reference inlines in V8; reading the prototype property
 * per call would not.
 */
export const ZC_HOP_DECL = "const __zcHop=Object.prototype.hasOwnProperty;";

/**
 * Issue codes zod raises from a schema's `_zod.parse` rather than from a check,
 * and which therefore carry `continue !== true` — what `util.aborted` looks for.
 *
 * Everything a CHECK produces (`too_small`, `too_big`, `invalid_format`,
 * `not_multiple_of`, a refine's `custom`) is continuable, because `$ZodCheck`
 * sets `continue: !def.abort` and an `abort: true` check costs the schema its
 * compiled path anyway — so classifying by code alone is exact for generated
 * issues.
 *
 * Read by {@link ZC_AB_DECL} and by the union's option-pruning loop, which
 * applies the same rule inline over a per-option issue array.
 */
const ABORTING_ISSUE_CODES: readonly string[] = [
  "invalid_type",
  "invalid_value",
  "invalid_union",
  "unrecognized_keys",
  "invalid_key",
  "invalid_element",
];

/** `c==="invalid_type"||c==="invalid_value"||…` over the code held in `codeExpr`. */
export function abortingCodeTest(codeExpr: string): string {
  return ABORTING_ISSUE_CODES.map((code) => `${codeExpr}===${JSON.stringify(code)}`).join("||");
}

/**
 * Port of zod's `util.aborted(payload, startIndex)`: has anything since
 * `startIndex` produced a NON-continuable issue?
 *
 * zod gates a schema's check chain on this (`runChecks`: `else if (isAborted)
 * continue`), which is what makes a container's `.refine()` still run after a
 * property or element failed its own `min`/`max`/format check, and stop running
 * once one failed to parse at all. The `startIndex` is the issue count when the
 * node was entered, mirroring the fresh payload zod hands each sub-schema.
 *
 * Size/length checks are exempt in zod — they declare a `when` predicate, which
 * bypasses the abort gate — so generated code leaves those ungated and only
 * wraps the refine/superRefine effects.
 */
export const ZC_AB_DECL = `function __zcAb(e,i){for(;i<e.length;i++){var c=e[i].code;if(${abortingCodeTest("c")})return true;}return false;}`;

/**
 * Port of zod's `util.finalizeIssue` for issues NESTED inside an
 * `invalid_key` / `invalid_element` wrapper. Those never reach the top-level
 * finalization loop (which walks only the outer array), so zod finalizes them
 * where it builds the wrapper: locale message applied when none was baked in,
 * `input` cleared. Their `path` stays RELATIVE to the key or value schema — zod
 * ran it on a fresh payload — so nothing rewrites it.
 *
 * `input` is `delete`d rather than assigned `undefined`, matching zod's own
 * `delete full.input` and the top-level finalizer: the key's PRESENCE is
 * observable (`"input" in issue`, `Object.keys`, spread, a strict deep-equal
 * against a zod issue), so assigning left a nested issue one key wider than
 * zod's. Only reached while an error is being built — never on a successful
 * parse — so the dictionary-mode transition it costs is confined to the path
 * that then constructs a ZodError anyway.
 */
export const ZC_FZ_DECL =
  "function __zcFz(e){for(var i=0;i<e.length;i++){var s=e[i];" +
  'if(s.message===undefined&&typeof __zcMsg==="function")s.message=__zcMsg(s);' +
  "delete s.input;}return e;}";

/**
 * Port of zod's `util.prefixIssues(key, issues)` for a map entry whose key is a
 * property-key type: each issue's RELATIVE path is spliced onto the map's own
 * path plus the key, and the issue moves into the parent's array.
 *
 * `b.concat(k,x.path)` flattens `x.path` one level, giving exactly
 * `[...base, key, ...relative]`.
 */
export const ZC_PFX_DECL =
  "function __zcPfx(d,s,b,k){for(var i=0;i<s.length;i++){var x=s[i];x.path=b.concat(k,x.path);d.push(x);}}";

/** Does `keyExpr` hold one of zod's `util.propertyKeyTypes` (string|number|symbol)? */
export function propertyKeyTest(keyExpr: string): string {
  return `typeof ${keyExpr}==="string"||typeof ${keyExpr}==="number"||typeof ${keyExpr}==="symbol"`;
}

/**
 * superRefine fast-check: run the payload callback on a throwaway payload and
 * report whether it both added nothing AND left the value alone. zod's own
 * wrapper (the referenced function) installs `addIssue` and normalizes what the
 * user adds, so the verdict is zod's; the issues themselves are re-collected by
 * the slow walk.
 *
 * The `p.value===v` half is what lets a superRefine node keep a fast path at
 * all. `value` is writable public API ($RefinementCtx extends ParsePayload), so
 * a callback may rewrite it, and the fast path's caller returns the ORIGINAL
 * input on success — which would then be stale. Reporting false when the value
 * moved routes those parses into the slow walk, which propagates the new value
 * (see ZC_SR_DECL). Callbacks that only validate — effectively all of them —
 * still take the fast exit.
 */
export const ZC_SR_OK_DECL =
  "function __zcSrOk(f,v){var p={value:v,issues:[]};__zcSrRun(f,p);" +
  "return p.issues.length===0&&p.value===v;}";

/**
 * Module-local (never imported by generated code) — __zcSr/__zcSrOk call it.
 * Lean mode declares it in the runtime module beside them; inline mode pushes it
 * into the preamble alongside whichever of the two is used.
 *
 * Invoke the referenced wrapper, reproducing zod's synchronous-parse contract:
 * a callback that returns a promise makes zod raise $ZodAsyncError rather than
 * silently accepting. Because the ref points at zod's superRefine WRAPPER, not
 * the user's function, an async callback cannot be detected while extracting —
 * the returned thenable is the only evidence, so the test lives here. Sync
 * callbacks return undefined, so the guard short-circuits on the first operand.
 */
export const ZC_SR_RUN_DECL =
  "function __zcSrRun(f,p){var r=f(p);" +
  'if(r&&typeof r.then==="function"){throw new __zcCore.$ZodAsyncError();}}';

/**
 * z.custom()/z.instanceof() fast verdict. Zod treats truthy predicate returns
 * as success and raises $ZodAsyncError when a synchronous parse encounters a
 * thenable, including a non-async function that happens to return a Promise.
 */
export const ZC_CUSTOM_OK_DECL =
  "function __zcCu(f,v){var r=f(v);" +
  'if(r&&typeof r.then==="function"){throw new __zcCore.$ZodAsyncError();}return !!r;}';

/**
 * superRefine slow-path merge: run the callback, then move its issues onto the
 * validator's list the way zod's finalizeIssue does — the node's path prefixed
 * onto any path the user supplied, and the internal `inst`/`continue` fields
 * dropped (they are zod bookkeeping, deleted before the issue is user-visible).
 *
 * Returns the payload, so the caller can write `.value` back (the callback may
 * have rewritten it) and read `.aborted`. Aborted is set when any issue aborts
 * in zod's sense (`continue !== true`, which covers `fatal: true` and the string
 * shorthand, whose issue carries no `continue` at all) — or when the callback
 * set it directly, also public payload API. A union option uses it to mark
 * itself aborted, matching how zod prunes option errors; without it an option
 * failing only through superRefine would be surfaced directly instead of inside
 * `invalid_union`.
 */
export const ZC_SR_DECL =
  "function __zcSr(f,v,p,e){var q={value:v,issues:[]};__zcSrRun(f,q);" +
  "for(var i=0;i<q.issues.length;i++){var s=q.issues[i],t={};" +
  'for(var k in s){if(k!=="inst"&&k!=="continue")t[k]=s[k];}' +
  "if(s.continue!==true)q.aborted=true;" +
  "t.path=s.path&&s.path.length?p.concat(s.path):p;e.push(t);}return q;}";

/** Non-issue runtime helper declarations hosted in the virtual module. */
export const RUNTIME_HELPER_DECLS: Readonly<Record<string, string>> = {
  __zcAb: ZC_AB_DECL,
  __zcFsr: ZC_FSR_DECL,
  __zcFz: ZC_FZ_DECL,
  __zcHop: ZC_HOP_DECL,
  __zcPfx: ZC_PFX_DECL,
  __zcCu: ZC_CUSTOM_OK_DECL,
  __zcSr: ZC_SR_DECL,
  __zcSrOk: ZC_SR_OK_DECL,
};
