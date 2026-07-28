/**
 * `.superRefine()` — the issue-collecting refinement protocol.
 *
 * A `.refine()` predicate returns a verdict, so compiled code can call it and
 * read the boolean. A `superRefine` callback instead receives zod's PAYLOAD
 * (`{ value, issues }`) and pushes onto it, so there is no verdict to read — and
 * because zod stores it on the check instance (`_zod.check`) rather than
 * `def.fn`, it used to cost the schema its compiled path entirely.
 *
 * It is now called through an `__rf[N]` reference to zod's own wrapper with a
 * synthesized payload. The wrapper installs `addIssue` and normalizes what the
 * user adds, so issue shapes are zod's by construction; the generated helpers
 * only reproject paths and drop the bookkeeping zod deletes (`inst`/`continue`).
 *
 * Two semantics constrain when this is legal, both covered below: an issue that
 * ABORTS truncates zod's remaining check chain (so only a LAST check compiles),
 * and `payload.value` is writable public API (so the value is written back, and
 * the fast path refuses when it moved).
 */
import { describe, expect, it } from "vite-plus/test";
import { core, z } from "zod";
import { extractSchema, type RefEntry } from "#src/core/extract/index.js";
import type { ArrayIR, ObjectIR, SchemaIR, StringIR } from "#src/core/types.js";
import { compileLikeProduction, expectParity } from "./parity-harness.js";

const irOf = (schema: unknown): { ir: SchemaIR; refs: RefEntry[] } => {
  const refs: RefEntry[] = [];
  return { ir: extractSchema(schema, refs), refs };
};

const LIMIT = 10;

describe("superRefine — compiles by calling zod's payload wrapper", () => {
  it("references the wrapper on the check instance, not def.fn", () => {
    const schema = z.object({ a: z.number() }).superRefine((v, ctx) => {
      if (v.a > LIMIT) ctx.addIssue("too big");
    });
    const { ir, refs } = irOf(schema);
    expect(ir.type).toBe("object");
    expect((ir as ObjectIR).checks?.[0]).toEqual({ kind: "super_refine_effect", refIndex: 0 });
    expect(refs[0]?.accessPath).toBe("._zod.def.checks[0]._zod.check");
    expect(refs[0]?.schema).toBeTypeOf("function");
  });

  it.each([
    [
      "cross-field issue with a path",
      z.object({ a: z.number(), b: z.number() }).superRefine((v, ctx) => {
        if (v.a > v.b) ctx.addIssue({ code: "custom", message: "a>b", path: ["a"] });
      }),
      [{ a: 5, b: 1 }, { a: 1, b: 5 }, { a: "x", b: 1 }, null],
    ],
    [
      "string shorthand issue",
      z.object({ a: z.number() }).superRefine((v, ctx) => {
        if (v.a < 0) ctx.addIssue("negative");
      }),
      [{ a: -1 }, { a: 1 }],
    ],
    [
      "several issues from one callback",
      z.object({ a: z.number() }).superRefine((v, ctx) => {
        if (v.a < LIMIT) ctx.addIssue("small");
        if (v.a % 2) ctx.addIssue({ message: "odd", path: ["a"] });
      }),
      [{ a: 3 }, { a: 12 }, { a: 11 }],
    ],
    [
      "issue with no message (locale default)",
      z.object({ a: z.number() }).superRefine((v, ctx) => {
        if (v.a < LIMIT) ctx.addIssue({});
      }),
      [{ a: 1 }, { a: 50 }],
    ],
    [
      "non-custom issue code",
      z.object({ a: z.number() }).superRefine((v, ctx) => {
        if (v.a > 100) {
          ctx.addIssue({
            code: "too_big",
            maximum: 100,
            origin: "number",
            inclusive: true,
          } as never);
        }
      }),
      [{ a: 500 }, { a: 5 }],
    ],
    [
      "on a string",
      z
        .string()
        .min(2)
        .superRefine((v, ctx) => {
          if (!v.startsWith("z")) ctx.addIssue("must start with z");
        }),
      ["zed", "abc", "z", 1, null],
    ],
    [
      "on a number",
      z.number().superRefine((v, ctx) => {
        if (v > LIMIT) ctx.addIssue("too big");
      }),
      [5, 50, "x"],
    ],
    [
      "on an array",
      z.array(z.number()).superRefine((v, ctx) => {
        if (v.length < 2) ctx.addIssue("short");
      }),
      [[1, 2], [1], [1, "x"], "nope"],
    ],
    [
      "on a nested object field",
      z.object({
        inner: z.object({ a: z.number() }).superRefine((v, ctx) => {
          if (v.a < 0) ctx.addIssue({ message: "neg", path: ["a"] });
        }),
      }),
      [{ inner: { a: 1 } }, { inner: { a: -1 } }, { inner: { a: "x" } }],
    ],
    [
      "on each element of an array",
      z.array(
        z.object({ a: z.number() }).superRefine((v, ctx) => {
          if (v.a < 0) ctx.addIssue("neg");
        }),
      ),
      [[{ a: 1 }, { a: -1 }], []],
    ],
    [
      "after a refine on the same node",
      z
        .object({ a: z.number() })
        .refine((v) => v.a !== 42, "not 42")
        .superRefine((v, ctx) => {
          if (v.a < 0) ctx.addIssue("neg");
        }),
      [{ a: -1 }, { a: 42 }, { a: 1 }],
    ],
    [
      "on a strict object",
      z
        .object({ a: z.number() })
        .strict()
        .superRefine((v, ctx) => {
          if (v.a < 0) ctx.addIssue("neg");
        }),
      [{ a: 1 }, { a: -1 }, { a: 1, extra: true }],
    ],
  ])("matches zod (verdict, issues AND output) for %s", (_label, schema, inputs) => {
    expectParity(schema as never, inputs as unknown[]);
  });

  it("prunes a failing union option the way zod does", () => {
    // An issue with no `continue` aborts, which is how zod decides an option
    // failed — without that the option's issue surfaces outside invalid_union.
    const schema = z.union([
      z.object({ t: z.literal("a"), n: z.number() }).superRefine((v, ctx) => {
        if (v.n < 0) ctx.addIssue("neg");
      }),
      z.object({ t: z.literal("b") }),
    ]);
    expectParity(schema, [{ t: "a", n: 1 }, { t: "a", n: -1 }, { t: "b" }, { t: "c" }]);
  });

  it("propagates a value the callback rewrites through ctx.value", () => {
    // $RefinementCtx extends ParsePayload, so `value` is writable public API.
    const schema = z.string().superRefine((v, ctx) => {
      ctx.value = v.trim();
    });
    expect(compileLikeProduction(schema, "srMutate")("  hi  ")).toEqual({
      success: true,
      data: "hi",
    });
    expectParity(schema, ["  hi  ", "ok", 1]);
  });

  it("propagates a rewritten value together with an issue", () => {
    const schema = z.string().superRefine((v, ctx) => {
      ctx.value = v.trim();
      if (v.trim() === "") ctx.addIssue("empty");
    });
    expectParity(schema, ["  hi  ", "   ", ""]);
  });

  it("honors a callback that sets ctx.aborted or pushes issues directly", () => {
    const aborts = z.string().superRefine((v, ctx) => {
      if (v === "") {
        ctx.aborted = true;
        ctx.addIssue("empty");
      }
    });
    const pushes = z.string().superRefine((v, ctx) => {
      if (v === "") ctx.issues.push({ code: "custom", message: "raw", input: v } as never);
    });
    expectParity(aborts, ["", "ok"]);
    expectParity(pushes, ["", "ok"]);
  });

  it("keeps the node compiled on string, number and array too", () => {
    const s = irOf(z.string().superRefine(() => {})).ir as StringIR;
    const n = irOf(z.number().superRefine(() => {})).ir;
    const a = irOf(z.array(z.number()).superRefine(() => {})).ir as ArrayIR;
    expect(s.type).toBe("string");
    expect(n.type).toBe("number");
    expect(a.type).toBe("array");
    expect(s.checks).toContainEqual({ kind: "super_refine_effect", refIndex: 0 });
    expect(a.checks).toContainEqual({ kind: "super_refine_effect", refIndex: 0 });
  });

  describe("delegates the shapes a plain call cannot reproduce", () => {
    it("falls back when another check follows (an abort would truncate it)", () => {
      const schema = z
        .object({ a: z.number() })
        .superRefine((v, ctx) => {
          if (v.a < 0) ctx.addIssue({ fatal: true, message: "fatal" });
        })
        .refine((v) => v.a !== 42, "not 42");
      expect(irOf(schema).ir.type).toBe("fallback");
      expectParity(schema, [{ a: -1 }, { a: 42 }, { a: 1 }]);
    });

    it("falls back for a raw .check(), whose callback is the user's own", () => {
      // Shape-identical to superRefine but NOT zod's wrapper, so `addIssue` is
      // never installed and the callback may do anything with the payload.
      const schema = z.string().check((payload) => {
        payload.value = payload.value.trim();
      });
      expect(irOf(schema).ir.type).toBe("fallback");
      expectParity(schema, ["  hi  ", "ok"]);
    });

    it("raises zod's $ZodAsyncError for an async callback, as zod does", () => {
      // The ref points at zod's WRAPPER, so the user's callback being async is
      // invisible while extracting — the promise it returns is the only
      // evidence, and a synchronous parse must raise on it rather than accept.
      const schema = z.string().superRefine(async (v, ctx) => {
        if (v === "") ctx.addIssue("empty");
      });
      expect(irOf(schema).ir.type).toBe("string");
      expect(() => compileLikeProduction(schema, "srAsync")("ok")).toThrow(core.$ZodAsyncError);
      expectParity(schema, ["", "ok"]);
    });

    it("falls back for a check with a `when` predicate, which zod may skip", () => {
      const inner = z.string().superRefine((v, ctx) => {
        if (v === "") ctx.addIssue("empty");
      });
      const [check] = (
        inner as unknown as {
          _zod: { def: { checks: { _zod: { def: Record<string, unknown> } }[] } };
        }
      )._zod.def.checks;
      if (check === undefined) throw new Error("expected a check");
      check._zod.def["when"] = () => true;
      expect(irOf(inner).ir.type).toBe("fallback");
    });

    it("falls back when refs are not being collected", () => {
      // Without a ref table there is no way to reach the callback.
      const ir = extractSchema(z.string().superRefine(() => {}));
      expect(ir.type).toBe("fallback");
    });
  });
});
