import { describe, expect, it } from "vite-plus/test";
import type { UnionIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

describe("slow-path — union", () => {
  it("accepts first option", () => {
    const ir: UnionIR = {
      type: "union",
      options: [
        { type: "string", checks: [] },
        { type: "number", checks: [] },
      ],
    };
    const safeParse = compileIR(ir);
    expect(safeParse("hello")).toEqual({ success: true, data: "hello" });
  });

  it("accepts second option", () => {
    const ir: UnionIR = {
      type: "union",
      options: [
        { type: "string", checks: [] },
        { type: "number", checks: [] },
      ],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(42)).toEqual({ success: true, data: 42 });
  });

  it("rejects value matching no option", () => {
    const ir: UnionIR = {
      type: "union",
      options: [
        { type: "string", checks: [] },
        { type: "number", checks: [] },
      ],
    };
    const safeParse = compileIR(ir);
    expect(safeParse(true).success).toBe(false);
    expect(safeParse(null).success).toBe(false);
    expect(safeParse([]).success).toBe(false);
  });

  it("validates checks within union options", () => {
    const ir: UnionIR = {
      type: "union",
      options: [
        { type: "string", checks: [{ kind: "min_length", minimum: 3 }] },
        { type: "number", checks: [{ kind: "greater_than", value: 0, inclusive: false }] },
      ],
    };
    const safeParse = compileIR(ir);
    expect(safeParse("abc").success).toBe(true);
    expect(safeParse(1).success).toBe(true);
    expect(safeParse("ab").success).toBe(false);
    expect(safeParse(0).success).toBe(false);
  });

  it("handles union with three options", () => {
    const ir: UnionIR = {
      type: "union",
      options: [
        { type: "string", checks: [] },
        { type: "number", checks: [] },
        { type: "boolean" },
      ],
    };
    const safeParse = compileIR(ir);
    expect(safeParse("hello").success).toBe(true);
    expect(safeParse(42).success).toBe(true);
    expect(safeParse(true).success).toBe(true);
    expect(safeParse(null).success).toBe(false);
  });

  it("a branch default fires on undefined without validating the substituted value", () => {
    // z.union([z.string().min(5).default("x"), z.undefined()]) with input undefined.
    // Zod's $ZodDefault short-circuits: the declared value replaces undefined and
    // the inner type never runs, so min(5) is NOT applied to "x" — branch 1
    // succeeds and the union takes it. Verified against zod itself, which returns
    // { success: true, data: "x" }.
    const ir: UnionIR = {
      type: "union",
      options: [
        {
          type: "default",
          inner: { type: "string", checks: [{ kind: "min_length", minimum: 5 }] },
          refIndex: 0,
        },
        { type: "undefined" },
      ],
    };
    const safeParse = compileIR(ir, "test", [{ _zod: { def: { defaultValue: "x" } } }]);
    const result = safeParse(undefined);
    expect(result.success).toBe(true);
    expect(result.data).toBe("x");
  });

  it("a failed branch's output mutation does not leak into the next branch", () => {
    // z.union([z.string().min(5), z.number().default(7)]) with input "ab".
    // Branch 1 fails min(5). Branch 2 is reached with the ORIGINAL input, not
    // branch 1's scratch output, so it rejects "ab" as a non-number rather than
    // succeeding on a value branch 1 left behind.
    const ir: UnionIR = {
      type: "union",
      options: [
        { type: "string", checks: [{ kind: "min_length", minimum: 5 }] },
        { type: "default", inner: { type: "number", checks: [] }, refIndex: 0 },
      ],
    };
    const safeParse = compileIR(ir, "test", [{ _zod: { def: { defaultValue: 7 } } }]);
    expect(safeParse("ab").success).toBe(false);
    expect(safeParse(undefined)).toEqual({ success: true, data: 7 });
    expect(safeParse("abcdef")).toEqual({ success: true, data: "abcdef" });
  });

  // M1: unionErrors should contain per-branch error details
  it("union error includes per-branch errors in unionErrors", () => {
    const ir: UnionIR = {
      type: "union",
      options: [
        { type: "string", checks: [] },
        { type: "number", checks: [] },
      ],
    };
    const safeParse = compileIR(ir);
    const result = safeParse(true);
    expect(result.success).toBe(false);
    const issue = result.error?.issues[0] as Record<string, unknown>;
    expect(issue["code"]).toBe("invalid_union");
    // errors should contain one flat array per failed branch
    const errors = issue["errors"] as Record<string, unknown>[][];
    expect(errors).toHaveLength(2);
    expect(errors[0]?.length).toBeGreaterThanOrEqual(1);
    expect(errors[1]?.length).toBeGreaterThanOrEqual(1);
  });
});

describe("fast-path — Union", () => {
  it("string | number: accepts 'a', accepts 42, rejects true", () => {
    const fn = compileFastCheck({
      type: "union",
      options: [
        { type: "string", checks: [] },
        { type: "number", checks: [] },
      ],
    });
    expect(fn?.("a")).toBe(true);
    expect(fn?.(42)).toBe(true);
    expect(fn?.(true)).toBe(false);
  });

  it("any ineligible option → returns null", () => {
    expect(
      compileFastCheck({
        type: "union",
        options: [
          { type: "string", checks: [] },
          { type: "fallback", reason: "transform" },
        ],
      }),
    ).toBeNull();
  });
});
