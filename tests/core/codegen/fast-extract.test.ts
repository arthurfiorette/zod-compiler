import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import { EXTRACT_CAP } from "#src/core/codegen/fast-size.js";
import { extractSchema } from "#src/core/extract/index.js";
import type { SchemaIR } from "#src/core/types.js";
import { compileIR } from "./helpers.js";

/**
 * Size-gated fast-check extraction (fast-size.ts / generateFast): a schema whose
 * monolithic fast-check would overflow V8's TurboFan budget is split into hosted
 * `__fo_N` boolean helpers. These tests pin (1) the split fires only for large
 * schemas — small ones stay byte-for-byte inlined; (2) every emitted function
 * stays under the size cap (incl. deep nesting and many-option unions, where a
 * naive estimate under-counts); (3) a split validator is semantically identical
 * to zod; and (4) an aborted fast path leaves no dead/dangling helpers behind.
 *
 * "Byte-identical" applies to SMALL schemas only — a large aggregate (deep
 * nesting, a wide object of sub-objects, a big union) does split, and should:
 * the inlined form would be an un-optimizable function. The split is a pure
 * refactor of the boolean, so output differs but accepts/rejects identically.
 */

/** Longest single emitted line (functions are emitted one per line). */
function longestLine(generated: string): number {
  return Math.max(...generated.split("\n").map((l) => l.length));
}

/** Nest `z.object({ k0..k{width-1}: <inner> })` to `depth` levels. */
function deepObject(depth: number, width: number): z.ZodType {
  let inner: z.ZodType = z.object({ leaf: z.string().min(1).max(50), n: z.number().int() });
  for (let d = 0; d < depth; d++) {
    const shape: Record<string, z.ZodType> = {};
    for (let w = 0; w < width; w++) shape[`k${w}`] = inner;
    inner = z.object(shape);
  }
  return inner;
}

function deepValue(depth: number, width: number): unknown {
  if (depth === 0) return { leaf: "okay", n: 1 };
  const o: Record<string, unknown> = {};
  for (let w = 0; w < width; w++) o[`k${w}`] = deepValue(depth - 1, width);
  return o;
}

/** A flat object of `n` regex-string fields — big enough to force extraction. */
function wideObject(n: number): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  for (let i = 0; i < n; i++) shape[`f${i}`] = z.string().min(1).max(9).regex(/x/);
  return z.object(shape);
}

function code(ir: SchemaIR): string {
  return generateValidator(ir, "test").code;
}

/**
 * Generous ceiling on any single emitted function: comfortably under the ~60KB
 * bytecode point where TurboFan bails, with margin over the char cap for the
 * one look-ahead mis-prediction the greedy split can overshoot by.
 */
const FN_SIZE_CEILING = EXTRACT_CAP + 15_000;

describe("size-gated fast-check extraction", () => {
  it("does NOT extract small schemas (output stays inlined)", () => {
    const user = z.object({
      username: z.string().min(3).max(20),
      email: z.email(),
      age: z.number().int().positive(),
      role: z.enum(["user", "admin"]),
      nested: z.object({ a: z.string(), b: z.number() }),
    });
    expect(code(extractSchema(user))).not.toContain("__fo_");
  });

  it("splits a deep schema and keeps every function under the cap", () => {
    const generated = code(extractSchema(deepObject(5, 3)));
    expect(generated).toContain("__fo_");
    // The estimate ignores access-path length; this asserts the path-aware
    // look-ahead still bounds the deepest (longest-path) function.
    expect(longestLine(generated)).toBeLessThan(FN_SIZE_CEILING);
  });

  it("splits an extracted helper that is itself large (recursively)", () => {
    const generated = code(extractSchema(deepObject(6, 3)));
    expect((generated.match(/function __fo_\d+/g) ?? []).length).toBeGreaterThan(3);
    expect(longestLine(generated)).toBeLessThan(FN_SIZE_CEILING);
  });

  it("bounds a discriminated union of many small options", () => {
    // Each option is below MIN_EXTRACT on its own, so bounding the switch relies
    // on the over-budget pressure relief, not per-option size. The option count
    // clears the cap even after the discriminated-union fast path strips each
    // case's redundant object-guard + discriminator re-check (which raised the
    // inline headroom): ~250 options is the floor where extraction re-engages.
    const options = Array.from({ length: 300 }, (_, i) =>
      z.object({
        t: z.literal(i),
        a: z.string().min(1),
        b: z.number().int(),
        c: z.boolean(),
        d: z.number(),
        e: z.string(),
      }),
    );
    const schema = z.discriminatedUnion(
      "t",
      options as [z.ZodObject, z.ZodObject, ...z.ZodObject[]],
    );
    const generated = code(extractSchema(schema));
    expect(generated).toContain("__fo_");
    expect(longestLine(generated)).toBeLessThan(FN_SIZE_CEILING);
  });

  it("a split validator accepts valid input and returns it unchanged", () => {
    const ir = extractSchema(deepObject(5, 3));
    const safeParse = compileIR(ir);
    const value = deepValue(5, 3);
    const result = safeParse(value);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(value);
  });

  it("stays byte-exact with zod across failures at every depth", () => {
    const schema = deepObject(5, 3);
    const ir = extractSchema(schema);
    expect(code(ir)).toContain("__fo_"); // precondition: this schema does split
    const safeParse = compileIR(ir);

    const navigate = (root: unknown, path: string[]): Record<string, unknown> => {
      let node = root as Record<string, unknown>;
      for (const key of path) node = node[key] as Record<string, unknown>;
      return node;
    };
    // Corrupt the value at a range of depths/branches and confirm the compiled
    // validator and zod reject identically (same issue code at the same path).
    const corruptions: Array<(v: unknown) => void> = [
      (v) => (navigate(v, ["k0", "k0", "k0", "k0", "k0"]).leaf = 123), // wrong type, deepest leaf
      (v) => (navigate(v, ["k1", "k2", "k0", "k1", "k0"]).n = "nope"), // wrong type, other branch
      (v) => delete navigate(v, ["k2", "k1", "k2", "k0", "k1"]).leaf, // missing required key
      (v) => (navigate(v, ["k0"]).k1 = null), // null where object expected, mid-tree
      (v) => (navigate(v, []).k2 = [1, 2, 3]), // array where object expected, near root
    ];

    const issueShape = (issues: readonly unknown[]) =>
      issues.map((i) => {
        const issue = i as { code: string; path: readonly (string | number)[] };
        return { code: issue.code, path: issue.path };
      });

    for (const corrupt of corruptions) {
      const value = deepValue(5, 3);
      corrupt(value);

      const mine = safeParse(value);
      const zod = schema.safeParse(value);
      expect(mine.success).toBe(false);
      expect(zod.success).toBe(false);
      expect(issueShape(mine.error?.issues ?? [])).toEqual(issueShape(zod.error?.issues ?? []));
    }
  });

  it("rolls back extracted helpers when a later node aborts the fast path", () => {
    // `data` is large enough to extract a __fo_ helper; the trailing transform
    // then makes the whole schema fast-path-ineligible. The pushed helper (and
    // any reserved recursive name) must be rolled back — never shipped as dead
    // code referencing a host that is no longer emitted.
    const schema = z.object({
      data: deepObject(5, 3),
      tail: z.string().transform((v) => v),
    });
    const generated = code(extractSchema(schema));
    expect(generated).not.toContain("__fo_");
    expect(generated).not.toContain("__fcr_");
  });

  it("never references a recursive __fcr_ helper it does not define", () => {
    // Self-recursive schema whose large first child holds the recursiveRef, with
    // a trailing transform that aborts the fast path after the child extracted.
    const Node: z.ZodType = z.object({
      big: z.object({
        ...(wideObject(150) as z.ZodObject).shape,
        self: z.array(z.lazy(() => Node)),
      }),
      bad: z.string().transform((v) => v),
    });
    const generated = code(extractSchema(Node));
    const referenced = /__fcr_\d+/.test(generated);
    const defined = /function __fcr_\d+/.test(generated);
    expect(referenced && !defined).toBe(false); // no dangling reference
  });
});

/**
 * Split-path parity for every HOISTABLE type, not just `object`.
 *
 * The deep-object case above proves a split OBJECT validates like zod. But the
 * other hoistable kinds (fast-size.ts HOISTABLE: discriminatedUnion, union,
 * tuple, record, intersection) each emit a structurally different boolean that
 * the extractor wraps in `__fo_`/switch helpers — the discriminated-union case
 * additionally carries `discSkipKey` THROUGH the hoist so an extracted option
 * still drops its redundant type-guard + discriminator re-check
 * (discriminated-union.ts). The pre-existing coverage for these large shapes
 * was size-only (longestLine < cap); a hoist that mis-threads the input
 * expression or drops the wrong guard would still satisfy a size assertion
 * while silently accepting/rejecting wrong. These run each split shape against
 * zod so a correctness regression in the hoist surfaces.
 */
describe("size-gated extraction — split validators match zod (every hoistable type)", () => {
  const issueShape = (issues: readonly unknown[]) =>
    issues.map((i) => {
      const issue = i as { code: string; path: readonly (string | number)[] };
      return { code: issue.code, path: issue.path };
    });

  const assertSplitParity = (schema: z.ZodType, name: string, inputs: unknown[]) => {
    const ir = extractSchema(schema);
    expect(code(ir), `precondition: ${name} must split`).toContain("__fo_");
    const safeParse = compileIR(ir, name);
    for (const input of inputs) {
      const mine = safeParse(input);
      const zod = schema.safeParse(input);
      expect(mine.success, `${name}: ${JSON.stringify(input)?.slice(0, 60)}`).toBe(zod.success);
      if (!mine.success && !zod.success) {
        expect(issueShape(mine.error?.issues ?? [])).toEqual(issueShape(zod.error.issues));
      }
    }
  };

  /** A leaf object heavy enough that a crowd of them overflows the fast-check cap. */
  const bigLeaf = (tag: number) =>
    z.object({
      t: z.literal(tag),
      a: z.string().min(1).max(40).regex(/x/),
      b: z.number().int().gte(0).lte(99),
      c: z.boolean(),
      d: z.string().email(),
      e: z.array(z.string().min(1)),
    });

  it("discriminated union of many options (switch dispatch, discSkipKey hoisted)", () => {
    const options = Array.from({ length: 300 }, (_, i) => bigLeaf(i));
    const schema = z.discriminatedUnion(
      "t",
      options as [z.ZodObject, z.ZodObject, ...z.ZodObject[]],
    );
    assertSplitParity(schema, "duSplit", [
      { t: 0, a: "x", b: 1, c: true, d: "a@b.com", e: ["s"] }, // first case
      { t: 299, a: "x", b: 1, c: true, d: "a@b.com", e: ["s"] }, // last case
      { t: 150, a: "x", b: 200, c: true, d: "a@b.com", e: ["s"] }, // b out of range
      { t: 42, a: "", b: 1, c: true, d: "a@b.com", e: ["s"] }, // a too short
      { t: 7, a: "x", b: 1, c: true, d: "not-email", e: ["s"] }, // bad email
      { t: 1000 }, // unknown discriminant
      "nope",
      null,
    ]);
  });

  it("non-discriminated union (||-chain) of distinct-shaped big objects", () => {
    // Distinct key names per option → no shared literal key → stays a ||-chain
    // (fastUnion's non-switch branch), the hoist path switch dispatch never exercises.
    const distinctLeaf = (i: number) =>
      z.object({
        [`k${i}`]: z.string().min(1).max(40).regex(/x/),
        [`m${i}`]: z.number().int().gte(0).lte(99),
        [`p${i}`]: z.boolean(),
        [`q${i}`]: z.string().email(),
      });
    const schema = z.union(
      Array.from({ length: 120 }, (_, i) => distinctLeaf(i)) as unknown as [
        z.ZodObject,
        z.ZodObject,
      ],
    );
    assertSplitParity(schema, "unionSplit", [
      { k0: "x", m0: 1, p0: true, q0: "a@b.com" }, // matches first arm
      { k60: "x", m60: 1, p60: false, q60: "a@b.com" }, // matches a middle arm
      { k5: "x", m5: 1, p5: true, q5: "bad-email" }, // no arm matches (bad email)
      "nope",
    ]);
  });

  it("large tuple of big objects", () => {
    const items = Array.from({ length: 120 }, () => bigLeaf(0));
    const schema = z.tuple(items as unknown as [z.ZodObject]);
    const ok = Array.from({ length: 120 }, () => ({
      t: 0,
      a: "x",
      b: 1,
      c: true,
      d: "a@b.com",
      e: ["s"],
    }));
    const badAt60 = ok.map((o, i) => (i === 60 ? { ...o, b: 999 } : o));
    // Non-object values at an EXTRACTED slot. `null` is the one that matters:
    // the hoisted helper reads properties off its parameter, so a slot reached
    // without an intact `!== null` guard raises a TypeError rather than
    // returning a verdict — and a throwing fast check surfaces as neither a
    // size nor a success/failure mismatch anywhere else in this file.
    const nonObjectAt60 = ok.map((o, i) => (i === 60 ? ("not-an-object" as unknown) : o));
    const nullAt60 = ok.map((o, i) => (i === 60 ? (null as unknown) : o));
    const arrayAt60 = ok.map((o, i) => (i === 60 ? ([] as unknown) : o));
    assertSplitParity(schema, "tupleSplit", [
      ok,
      badAt60,
      nonObjectAt60,
      nullAt60,
      arrayAt60,
      ok.slice(0, 5),
      "nope",
    ]);
  });
});
