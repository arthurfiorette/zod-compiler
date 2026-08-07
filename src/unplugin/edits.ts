/**
 * Edit primitives shared by the transform pipeline stages.
 *
 * Every stage (hoist → hoisted-schema compile → rewrites → runtime inject)
 * describes its changes as non-overlapping `Edit` splices (plus at most one
 * insertion) against the STAGE INPUT. The same edit list is applied two
 * ways: `applyEdits()` produces the stage output string, and the pipeline
 * applies it to a MagicString to produce the stage's sourcemap — deriving
 * both from one list makes code/map divergence impossible.
 */

export interface Edit {
  /** Start offset in the stage-input string. */
  start: number;
  /** End offset (exclusive) in the stage-input string. */
  end: number;
  /** Replacement text. */
  text: string;
}

export interface Insertion {
  /** Offset in the stage-input string to insert at. */
  offset: number;
  text: string;
}

/**
 * Offset after the shebang and the directive prologue ("use strict",
 * "use client", "use server", ...) — where module-head insertions must go.
 *
 * A directive is only a directive while it is still part of the prologue, so
 * anything prepended at offset 0 demotes it to a plain string expression.
 * Bundlers that give directives meaning reject that outright: React Server
 * Components builds fail with `The "use client" directive must be placed
 * before other expressions`, which is how the generated runtime prologue used
 * to break every Next.js file that exported a schema.
 */
export function moduleHeadOffset(code: string): number {
  let i = 0;
  if (code.startsWith("#!")) {
    const nl = code.indexOf("\n");
    i = nl === -1 ? code.length : nl + 1;
  }
  while (true) {
    // Skip whitespace and comments between directives
    while (i < code.length) {
      const ch = code[i] as string;
      if (/\s/.test(ch)) {
        i++;
      } else if (ch === "/" && code[i + 1] === "/") {
        const nl = code.indexOf("\n", i);
        i = nl === -1 ? code.length : nl + 1;
      } else if (ch === "/" && code[i + 1] === "*") {
        const end = code.indexOf("*/", i + 2);
        i = end === -1 ? code.length : end + 2;
      } else {
        break;
      }
    }
    // The body excludes backslashes and the lookahead demands a statement
    // boundary, so the two shapes that merely START like a directive are left
    // alone: `"use \"strict\"";` (matching through the escape would land the
    // insertion mid-literal) and `"use " + mode;` (an expression statement,
    // where it would land on the `+`). Both would emit a syntax error.
    const directive = code
      .slice(i)
      .match(/^(["'])use [^"'\n\\]*\1(?=[^\S\n]*([;\n"']|$))\s*;?[^\S\n]*\n?/);
    if (!directive) return i;
    i += directive[0].length;
  }
}

/**
 * Apply non-overlapping edits (any order) and an optional insertion to a
 * string. Mirrors MagicString.overwrite + appendLeft semantics: an insertion
 * at an edit boundary lands before the edit's replacement.
 */
export function applyEdits(code: string, edits: readonly Edit[], insert?: Insertion): string {
  const ops: Array<Edit | (Insertion & { insertion: true })> = [...edits];
  if (insert) ops.push({ ...insert, insertion: true });
  ops.sort((a, b) => {
    const aStart = "insertion" in a ? a.offset : a.start;
    const bStart = "insertion" in b ? b.offset : b.start;
    if (aStart !== bStart) return bStart - aStart;
    // Same position: apply the insertion last so it ends up BEFORE the
    // replacement text in the output (appendLeft semantics).
    return "insertion" in a ? -1 : 1;
  });
  let result = code;
  for (const op of ops) {
    if ("insertion" in op) {
      result = result.slice(0, op.offset) + op.text + result.slice(op.offset);
    } else {
      result = result.slice(0, op.start) + op.text + result.slice(op.end);
    }
  }
  return result;
}
