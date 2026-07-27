/**
 * Standard Schema (`~standard`) routes through the COMPILED validator.
 *
 * This is the integration surface — tRPC, Hono, TanStack and anything else that
 * speaks https://standardschema.dev reach a schema through `~standard.validate`,
 * never through `.safeParse`. Zod builds that property lazily as
 * `validate: (v) => safeParse(inst, v)`, calling the core FUNCTION, which goes
 * straight to `inst._zod.run`. Installing a compiled `safeParse` as an own
 * property therefore does nothing for it: the route stayed entirely uncompiled
 * (measured 271.7 ns against the compiled 26.6 ns on one object schema) while
 * the README promised it was covered, and no test looked.
 *
 * `__zcMkv` now replaces `~standard` outright, keeping Zod's own validate as the
 * throw path so async refinements and throwing checks behave exactly as before.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MK_VALIDATOR_DECL } from "#src/core/iife.js";
import { compileLikeProduction } from "./parity-harness.js";

interface StandardV1 {
  version: number;
  vendor: string;
  validate: (
    value: unknown,
  ) =>
    | { issues?: { message: string }[]; value?: unknown }
    | Promise<{ issues?: { message: string }[]; value?: unknown }>;
}

/** The real `__zcMkv`, compiled strict exactly as the emitted module runs it. */
const mkv = new Function(`"use strict";${MK_VALIDATOR_DECL}return __zcMkv;`)() as (
  fn: unknown,
  schema: unknown,
  fc: unknown,
  is: unknown,
) => Record<string, unknown>;

/** Install a production-equivalent compiled validator onto a real Zod schema. */
function compileOnto(schema: z.ZodType): StandardV1 {
  const safeParse = compileLikeProduction(schema, "std");
  mkv(safeParse, schema, null, null);
  return (schema as unknown as Record<string, StandardV1>)["~standard"];
}

/** Normalize a Standard Schema result (sync or async) for comparison. */
async function settle(std: StandardV1, input: unknown): Promise<string> {
  try {
    const result = await std.validate(input);
    return JSON.stringify({
      ok: result.issues === undefined,
      value: result.value,
      issues: result.issues?.map((issue) => issue.message),
    });
  } catch (error) {
    return `THREW ${(error as Error).constructor.name}`;
  }
}

describe("Standard Schema — routes through the compiled validator", () => {
  it("does not fall back to zod's internal parse", () => {
    // The tell: zod's validate closes over the core safeParse, so a compiled
    // `~standard` must NOT be the object zod lazily built.
    const schema = z.object({ a: z.string().min(1) });
    const zodBuilt = (schema as unknown as Record<string, StandardV1>)["~standard"];
    const compiled = compileOnto(schema);
    expect(compiled).not.toBe(zodBuilt);
    expect(compiled.validate({ a: "x" })).toStrictEqual({ value: { a: "x" } });
  });

  it("keeps the v1 contract fields", () => {
    const compiled = compileOnto(z.object({ a: z.string() }));
    expect(compiled.version).toBe(1);
    expect(compiled.vendor).toBe("zod");
  });

  it("stays non-enumerable, as zod's own is", () => {
    const schema = z.object({ a: z.string() });
    expect(Object.keys(schema)).not.toContain("~standard");
    compileOnto(schema);
    expect(Object.keys(schema)).not.toContain("~standard");
    expect(Object.getOwnPropertyDescriptor(schema, "~standard")?.enumerable).toBe(false);
  });

  it("survives a second install on the same schema object", () => {
    // Two exports aliasing one schema run __zcMkv twice. Zod's lazy setter
    // leaves the slot non-writable, so a plain assignment would throw under the
    // ESM strict mode the emitted module runs in.
    const schema = z.object({ a: z.string() });
    expect(() => {
      compileOnto(schema);
      compileOnto(schema);
    }).not.toThrow();
    const std = (schema as unknown as Record<string, StandardV1>)["~standard"];
    expect(std.validate({ a: "x" })).toStrictEqual({ value: { a: "x" } });
  });

  it('works without a schema to wrap (output: "bag")', () => {
    // schema === null: there is no zod `~standard` to capture, so the throw path
    // must rethrow rather than reach for a fallback that does not exist.
    const bag = mkv((input: unknown) => ({ data: input, success: true }), null, null, null);
    const std = bag["~standard"] as StandardV1;
    expect(std.version).toBe(1);
    expect(std.validate(1)).toStrictEqual({ value: 1 });

    const throwing = mkv(
      () => {
        throw new Error("boom");
      },
      null,
      null,
      null,
    );
    expect(() => (throwing["~standard"] as StandardV1).validate(1)).toThrow("boom");
  });

  it("returns the input by reference when the fast check accepts", () => {
    const input = { a: "x" };
    const schema = z.object({ a: z.string() });
    mkv(compileLikeProduction(schema, "ref"), schema, (v: unknown) => v === input, null);
    const std = (schema as unknown as Record<string, StandardV1>)["~standard"];
    expect((std.validate(input) as { value: unknown }).value).toBe(input);
  });
});

describe("Standard Schema — parity with zod's own validate", () => {
  it.each<[string, () => z.ZodType, unknown[]]>([
    [
      "object",
      () => z.object({ a: z.string().min(1), b: z.number().int() }),
      [{ a: "x", b: 1 }, { a: "", b: 1 }, { a: "x", b: 1.5 }, { a: 1, b: "y" }, null],
    ],
    ["strips unknown keys", () => z.object({ a: z.string() }), [{ a: "x", extra: 1 }]],
    [
      "nested array with a size check",
      () => z.object({ items: z.array(z.object({ id: z.string().min(1) })).min(1) }),
      [{ items: [{ id: "a" }] }, { items: [] }, { items: [{ id: "" }] }],
    ],
    [
      "default + overwrite",
      () => z.object({ q: z.string().trim(), n: z.number().default(3) }),
      [{ q: "  x  " }, { q: 5 }],
    ],
    ["coerce (eager walk)", () => z.object({ n: z.coerce.number() }), [{ n: "5" }, { n: "x" }]],
    [
      "cross-field refine",
      () => z.object({ a: z.number(), b: z.number() }).refine((v) => v.a < v.b, "a<b"),
      [
        { a: 1, b: 2 },
        { a: 3, b: 2 },
      ],
    ],
    [
      "transform",
      () => z.object({ a: z.string().transform((s) => s.length) }),
      [{ a: "abc" }, { a: 1 }],
    ],
    ["primitive root", () => z.string().min(3), ["abc", "a", 5]],
    ["union", () => z.union([z.string(), z.number()]), ["x", 1, true]],
    [
      "throwing check surfaces as zod surfaces it",
      () =>
        z.object({ a: z.string() }).refine(() => {
          throw new Error("boom");
        }),
      [{ a: "x" }],
    ],
    [
      "async refinement delegates to zod",
      () => z.object({ a: z.string() }).refine(async () => true),
      [{ a: "x" }],
    ],
  ])("%s", async (_label, make, inputs) => {
    // Two independent instances: one left plain, one compiled in place.
    const plain = make();
    const compiled = compileOnto(make());
    const zodStd = (plain as unknown as Record<string, StandardV1>)["~standard"];
    for (const input of inputs) {
      expect(await settle(compiled, input), `input ${JSON.stringify(input)}`).toBe(
        await settle(zodStd, input),
      );
    }
  });
});
