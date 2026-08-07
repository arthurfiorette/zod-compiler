import type { RecursiveRefIR } from "../types.js";
import type { RecursionState, ZodSchema } from "./types.js";

/**
 * Mint the back-edge for a detected cycle, keyed on the schema the cycle
 * RE-ENTERS.
 *
 * Two detectors reach here and they MUST agree on refIds, or a back-edge calls
 * a validator hosting a different shape: `extractLazy` sees a cycle one level
 * early — at the `z.lazy()` wrapper, keyed on the schema it resolves to — while
 * `dispatch` sees a getter-declared cycle only by re-entering the target
 * itself. Keying on the re-entered schema in both makes them mint the same id.
 *
 * A `recursiveRef` re-invokes the validator hosting its target's shape. The
 * ROOT schema's resolution is hosted by the schema's own `safeParse_<name>` /
 * fast-check, so a cycle back to it emits the implicit refId 0 (the directly
 * self-recursive case). A cycle back to a NON-root sub-schema (recursive schema
 * nested in a wrapper, multiple distinct recursive sub-schemas, or mutual
 * recursion) gets a stable refId (≥ 1) keyed by schema identity; `dispatch`
 * wraps that schema's IR in a `recursionTarget` node so codegen hosts it as a
 * standalone validator the ref can call.
 */
export function makeRecursiveRef(target: unknown, recursion: RecursionState): RecursiveRefIR {
  // A lazy root is transparent — extraction emits the resolved shape as the
  // root's own IR — so a cycle back to what it resolves to is still refId 0.
  const root = recursion.root as ZodSchema | undefined;
  const rootResolved = root?._zod?.def?.type === "lazy" ? root._zod.innerType : root;
  if (rootResolved === target) {
    return { type: "recursiveRef" };
  }
  let refId = recursion.targets.get(target);
  if (refId === undefined) {
    refId = recursion.next++;
    recursion.targets.set(target, refId);
  }
  return { type: "recursiveRef", refId };
}
