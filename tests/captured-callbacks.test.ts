/**
 * `.refine()` and `.transform()` callbacks that CAPTURE outer variables.
 *
 * A zero-capture predicate is inlined from its source text. One that captures
 * cannot be — but it can still be CALLED, through an `__rf[N]` reference to the
 * user's own function object reached from the schema
 * (`._zod.def.checks[i]._zod.def.fn`). Before that, any captured refine cost the
 * schema its compiled path: a root-level one made the ENTIRE object delegate to
 * zod (measured 246.7 ns vs 8.5 ns for the same schema compiled — a 29x cliff on
 * the most common cross-field validation there is).
 *
 * Shapes whose semantics a plain call cannot reproduce still fall back: a second
 * parameter is zod's `ctx` issue-collection protocol (superRefine), and an async
 * or generator callback returns a promise where zod's sync parse raises.
 */
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { extractSchema, type RefEntry } from "#src/core/extract/index.js";
import type { ObjectIR, SchemaIR, TransformEffectIR } from "#src/core/types.js";
import { compileLikeProduction, expectParity } from "./parity-harness.js";

const irOf = (schema: unknown): { ir: SchemaIR; refs: RefEntry[] } => {
  const refs: RefEntry[] = [];
  return { ir: extractSchema(schema, refs), refs };
};

const MIN_AGE = 18;
const ALLOWED = ["example.com", "test.com"];

describe("captured refine — compiles by reference instead of falling back", () => {
  it("keeps a root object compiled when its refine captures", () => {
    const schema = z.object({ age: z.number(), name: z.string() }).refine((d) => d.age >= MIN_AGE);
    const { ir, refs } = irOf(schema);
    expect(ir.type).toBe("object");
    expect((ir as ObjectIR).checks?.[0]).toMatchObject({ kind: "refine_effect", refIndex: 0 });
    expect(refs[0]?.accessPath).toBe("._zod.def.checks[0]._zod.def.fn");
    expect(refs[0]?.schema).toBeTypeOf("function");
  });

  // Inputs are per-case: a shared list would trip the unrelated (documented)
  // "unknown keys are not stripped" divergence on the narrower shapes.
  it.each([
    [
      "object root",
      z.object({ age: z.number() }).refine((d) => d.age >= MIN_AGE, "too young"),
      [{ age: 30 }, { age: 5 }, { age: "x" }, {}, null, undefined],
    ],
    [
      "object field",
      z.object({ age: z.number().refine((n) => n >= MIN_AGE, "too young") }),
      [{ age: 30 }, { age: 5 }, { age: "x" }, {}],
    ],
    [
      "string",
      z.string().refine((s) => ALLOWED.some((d) => s.endsWith(d)), "bad domain"),
      ["user@example.com", "user@nope.org", "", 42],
    ],
    ["number", z.number().refine((n) => n >= MIN_AGE), [30, 5, "x", null]],
    [
      "array",
      z.array(z.number()).refine((a) => a.length >= MIN_AGE / 9),
      [[1, 2], [1], [1, "x"], []],
    ],
    [
      "two captured refines",
      z
        .object({ age: z.number() })
        .refine((d) => d.age > 0, "positive")
        .refine((d) => d.age < MIN_AGE, "under age"),
      [{ age: 5 }, { age: -1 }, { age: 100 }, { age: "x" }],
    ],
    [
      "captured + zero-capture mixed",
      z
        .object({ age: z.number(), max: z.number() })
        .refine((d) => d.age >= MIN_AGE)
        .refine((d) => d.age <= d.max),
      [
        { age: 30, max: 99 },
        { age: 5, max: 99 },
        { age: 30, max: 1 },
      ],
    ],
  ])("matches zod for %s", (_label, schema, inputs) => {
    expectParity(schema as never, inputs as unknown[]);
  });

  it("compiles superRefine by calling zod's own payload wrapper", () => {
    const schema = z.object({ a: z.number() }).superRefine((d, ctx) => {
      if (d.a < MIN_AGE) ctx.addIssue({ code: "custom", message: "young" });
    });
    const { ir, refs } = irOf(schema);
    expect(ir.type).toBe("object");
    expect((ir as ObjectIR).checks?.[0]).toEqual({ kind: "super_refine_effect", refIndex: 0 });
    expect(refs[0]?.accessPath).toBe("._zod.def.checks[0]._zod.check");
    expectParity(schema, [{ a: 30 }, { a: 5 }, { a: "x" }, null]);
  });

  it("still falls back for an async refine", () => {
    const { ir } = irOf(z.string().refine(async (s) => s.length > 0));
    expect(ir.type).toBe("fallback");
  });
});

/**
 * Two issue-shape rules the inlined path got wrong before captured refines made
 * the surface wide enough to notice. Both are pinned against zod itself.
 */
describe("refine issue shape", () => {
  it("suppresses an object-level refine when a property already failed", () => {
    // zod parses the properties into the payload first and skips the check
    // chain when that produced issues — so the custom issue must NOT appear.
    const schema = z.object({ a: z.number(), b: z.string() }).refine((d) => d.a > 100, "big");
    expectParity(schema, [
      { a: 1, b: 1 }, // property fails → refine suppressed
      { a: 1, b: "x" }, // properties pass, refine fails → custom issue
      { a: 200, b: "x" },
      {},
    ]);
  });

  it("still runs a string/number/array refine after a failed sibling check", () => {
    // Unlike objects, the base value parsed fine here, so zod runs the whole
    // check chain: both too_small AND custom are reported.
    expectParity(
      z
        .string()
        .min(5)
        .refine((s) => s.startsWith("z")),
      ["ab", "zab", "zabcde"],
    );
    expectParity(
      z
        .number()
        .min(5)
        .refine((n) => n % 2 === 0),
      [3, 4, 6],
    );
    expectParity(
      z
        .array(z.number())
        .min(3)
        .refine((a) => a.length % 2 === 0),
      [[1], [1, 2, 3, 4]],
    );
  });

  it("reports a custom refine path against the configured member", () => {
    expectParity(
      z.object({ a: z.number(), b: z.number() }).refine((d) => d.a < d.b, {
        message: "order",
        path: ["b"],
      }),
      [
        { a: 1, b: 2 },
        { a: 3, b: 2 },
      ],
    );
  });

  it("falls back when the refine path has non-scalar segments", () => {
    const schema = z.object({ a: z.number() }).refine((d) => d.a > 0, {
      path: [Symbol("s") as unknown as string],
    });
    expect(irOf(schema).ir.type).toBe("fallback");
  });
});

/**
 * The same reference trick for `.transform()`. A captured transform on the root
 * was the worst case in the library: the schema delegated AND paid the fallback
 * wrapper on top, measuring 163.7 ns against zod's own 136.7 ns — i.e. compiling
 * made it slower than not compiling.
 */
describe("captured transform — compiles by reference", () => {
  const prefix = "id_";
  const multiplier = 3;

  it("keeps a root object compiled when its transform captures", () => {
    const schema = z.object({ id: z.string() }).transform((d) => ({ ...d, id: prefix + d.id }));
    const { ir, refs } = irOf(schema);
    expect(ir.type).toBe("effect");
    expect((ir as TransformEffectIR).refIndex).toBe(0);
    expect(refs[0]?.accessPath).toBe("._zod.def.out._zod.def.transform");
    expect(refs[0]?.schema).toBeTypeOf("function");
  });

  it.each([
    [
      "root object",
      z.object({ id: z.string(), n: z.number() }).transform((d) => ({ ...d, id: prefix + d.id })),
      [{ id: "x", n: 1 }, { id: 1, n: 1 }, { id: "x" }, null],
    ],
    [
      "field",
      z.object({ id: z.string().transform((s) => prefix + s), n: z.number() }),
      [
        { id: "x", n: 1 },
        { id: 1, n: 1 },
      ],
    ],
    ["string", z.string().transform((s) => prefix + s), ["x", 1]],
    ["number", z.number().transform((n) => n * multiplier), [2, "x"]],
    [
      "transform piped into a schema",
      z
        .string()
        .transform((s) => prefix + s)
        .pipe(z.string().min(5)),
      ["abcdef", "a"],
    ],
    ["array element", z.array(z.string().transform((s) => prefix + s)), [["a", "b"], [1]]],
    [
      "optional field",
      z.object({
        id: z
          .string()
          .transform((s) => prefix + s)
          .optional(),
      }),
      [{ id: "x" }, {}],
    ],
  ])("matches zod (verdict AND output) for %s", (_label, schema, inputs) => {
    expectParity(schema as never, inputs as unknown[]);
  });

  it("still delegates a transform that takes zod's ctx", () => {
    const schema = z.object({ n: z.number() }).transform((d, ctx) => {
      if (d.n < 0) ctx.addIssue({ code: "custom", message: "neg" });
      return d;
    });
    expect(irOf(schema).ir.type).toBe("fallback");
    expectParity(schema, [{ n: 1 }, { n: -1 }]);
  });

  it("does not run the transform when the inner parse failed", () => {
    let ran = 0;
    const schema = z.object({ n: z.number() }).transform((d) => {
      ran++;
      return { ...d, tag: prefix };
    });
    const compiled = compileLikeProduction(schema, "notRun");
    expect(compiled({ n: "bad" }).success).toBe(false);
    expect(ran, "transform must not run on a failed inner parse").toBe(0);
    expect(compiled({ n: 1 }).success).toBe(true);
    expect(ran).toBe(1);
  });
});
