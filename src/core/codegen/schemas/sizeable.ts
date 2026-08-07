import type { CheckOrEffectIR, FileCheckIR, SetCheckIR } from "../../types.js";
import type { SlowGen } from "../context.js";
import { emitRuntimeHelper } from "../context.js";
import { emit } from "../emit.js";
import { tooBig, tooSmall } from "../emit-issue.js";
import { ZC_LENGTH_ORIGIN_DECL, ZC_SIZE_ORIGIN_DECL } from "../issue-decls.js";

/**
 * Length/size checks re-emitted for the branch where the node's TYPE CHECK
 * ALREADY FAILED.
 *
 * zod skips a schema's checks once its parse aborted — except the ones carrying
 * a `when` predicate, which `runChecks` consults instead of the abort flag:
 *
 * ```js
 * if (ch._zod.def.when) { if (!ch._zod.def.when(payload)) continue; }
 * else if (isAborted) continue;
 * ```
 *
 * and `$ZodCheckMinLength` & co. install exactly such a predicate —
 * `!nullish(value) && value.length !== undefined` (`.size` for the size family)
 * — so they run on ANY input carrying that property, of any type. Hence
 * `z.string().min(2).safeParse([])` reports TWO issues in zod: the
 * `invalid_type`, and a `too_small` whose `origin` is `"array"`, because the
 * empty array satisfied the `when`. Compiled output kept every check inside the
 * matched-type branch and reported only the first. Same for
 * `z.array(…).min(3)` over a short string, `z.set(…).min(2)` over a `Map`, and
 * `z.file().min(2)` over a `Set`.
 *
 * Emitted as a SEPARATE copy in the failure branch rather than hoisted out of
 * both, so the success path — where the origin is statically known and the guard
 * is trivially true — stays byte-for-byte what it was. This is cold code: it
 * runs only for input the node has already rejected.
 *
 * `origin` is computed at runtime here (see ZC_LENGTH_ORIGIN_DECL), because the
 * value that reached this branch is by definition not the schema's own type.
 */
export function whenGatedSizeChecks(
  checks: readonly (CheckOrEffectIR | SetCheckIR | FileCheckIR)[],
  g: SlowGen,
  family: "length" | "size",
): string {
  const KINDS =
    family === "length"
      ? new Set(["min_length", "max_length", "length_equals"])
      : new Set(["min_size", "max_size", "size_equals"]);
  // Checked BEFORE touching the context: `emitRuntimeHelper` pushes its
  // declaration on sight, so asking for the origin helper up front left a dead
  // `__zcLo` in the preamble of every schema with a plain `z.string()` in it.
  if (!checks.some((check) => KINDS.has(check.kind))) return "";

  const property = family === "length" ? "length" : "size";
  const originHelper =
    family === "length"
      ? emitRuntimeHelper(g.ctx, "__zcLo", ZC_LENGTH_ORIGIN_DECL)
      : emitRuntimeHelper(g.ctx, "__zcSo", ZC_SIZE_ORIGIN_DECL);
  const origin = { expr: `${originHelper}(${g.input})` };
  const measure = `${g.input}.${property}`;

  let body = "";
  for (const check of checks) {
    // Kept in DECLARATION order: `runChecks` walks the check array, so two
    // failing length checks report in the order they were declared.
    switch (check.kind) {
      case "min_length":
        body += emit`
          if(${measure}<${check.minimum}){
            ${tooSmall(g, check.minimum, origin, true, { message: check.message })}
          }`;
        break;
      case "max_length":
        body += emit`
          if(${measure}>${check.maximum}){
            ${tooBig(g, check.maximum, origin, true, { message: check.message })}
          }`;
        break;
      case "length_equals":
        body += emit`
          if(${measure}<${check.length}){
            ${tooSmall(g, check.length, origin, true, { exact: true, message: check.message })}
          }else if(${measure}>${check.length}){
            ${tooBig(g, check.length, origin, true, { exact: true, message: check.message })}
          }`;
        break;
      case "min_size":
        body += emit`
          if(${measure}<${check.minimum}){
            ${tooSmall(g, check.minimum, origin, true, { message: check.message })}
          }`;
        break;
      case "max_size":
        body += emit`
          if(${measure}>${check.maximum}){
            ${tooBig(g, check.maximum, origin, true, { message: check.message })}
          }`;
        break;
      case "size_equals":
        body += emit`
          if(${measure}<${check.size}){
            ${tooSmall(g, check.size, origin, true, { exact: true, message: check.message })}
          }else if(${measure}>${check.size}){
            ${tooBig(g, check.size, origin, true, { exact: true, message: check.message })}
          }`;
        break;
      default:
        break;
    }
  }
  if (body === "") return "";
  // zod's own `when`, verbatim: `!util.nullish(value) && value.<prop> !== undefined`.
  return emit`
    if(${g.input}!==undefined&&${g.input}!==null&&${measure}!==undefined){
      ${body}
    }`;
}
