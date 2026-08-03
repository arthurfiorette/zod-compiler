/**
 * The common `.and()` shape—two disjoint default objects—can be validated and
 * built as one merged object. Zod remains the cold-path issue authority because
 * intersection failures have distinct multi-side issue semantics.
 */
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import { extractSchema, type RefEntry } from "#src/core/extract/index.js";
import type { ObjectIR, ZodDelegateIR } from "#src/core/types.js";
import { compileLikeProduction, expectParity } from "./parity-harness.js";

function extractWithRefs(schema: unknown): {
  ir: ReturnType<typeof extractSchema>;
  refs: RefEntry[];
} {
  const refs: RefEntry[] = [];
  return { ir: extractSchema(schema, refs), refs };
}

function commonIntersection() {
  return z.intersection(
    z.object({ id: z.string(), name: z.string().min(1), email: z.email() }),
    z.object({ age: z.number().int(), active: z.boolean(), tags: z.array(z.string()) }),
  );
}

describe("disjoint object intersection extraction", () => {
  it("merges the two strip-object shapes behind a cold Zod delegate", () => {
    const schema = commonIntersection();
    const { ir, refs } = extractWithRefs(schema);
    expect(ir).toMatchObject({ type: "zodDelegate", refIndex: 0 });
    const merged = (ir as ZodDelegateIR).inner as ObjectIR;
    expect(merged.type).toBe("object");
    expect(merged.stripUnknownKeys).toBe(true);
    expect(Object.keys(merged.properties)).toEqual([
      "id",
      "name",
      "email",
      "age",
      "active",
      "tags",
    ]);
    expect(refs.map((ref) => ref.accessPath)).toEqual([""]);
  });

  it("emits the single-pass build path", () => {
    const { ir, refs } = extractWithRefs(commonIntersection());
    const generated = generateValidator(ir, "intersection", { refCount: refs.length });
    expect(generated.functionDef).toMatch(/=__vb_\d+\(input\)/);
    expect(generated.functionDef).toContain("__zcFinD");
  });

  it("leaves overlapping and policy-sensitive intersections on Zod", () => {
    const cases = [
      z.intersection(z.object({ value: z.string() }), z.object({ value: z.string().min(2) })),
      z.intersection(z.looseObject({ a: z.string() }), z.object({ b: z.number() })),
      z.intersection(
        z.object({ a: z.string() }).refine((value) => value.a.length > 0),
        z.object({ b: z.number() }),
      ),
    ];
    for (const schema of cases) expect(extractWithRefs(schema).ir.type).toBe("fallback");
  });

  it("leaves intersections whose integer keys would reorder callbacks on Zod", () => {
    const schema = z.intersection(z.object({ left: z.string() }), z.object({ 1: z.string() }));
    expect(extractWithRefs(schema).ir.type).toBe("fallback");
  });

  it("still falls back when runtime references are unavailable", () => {
    expect(extractSchema(commonIntersection()).type).toBe("fallback");
  });
});

describe("disjoint object intersection parity", () => {
  it("matches verdicts, merged output, stripping, and multi-side errors", () => {
    const schema = commonIntersection();
    expectParity(schema, [
      {
        id: "u1",
        name: "Ada",
        email: "ada@example.com",
        age: 42,
        active: true,
        tags: ["compiler"],
        extra: "stripped",
      },
      { id: "u1", name: "", email: "bad", age: -1, active: "yes", tags: [1] },
      { id: "u1", name: "Ada", email: "ada@example.com" },
      null,
      [],
    ]);
  });

  it("builds disjoint transforms, coercions, defaults, and optional fields", () => {
    const schema = z
      .object({
        id: z.string(),
        slug: z.string().transform((value) => value.toLowerCase()),
      })
      .and(
        z.object({
          page: z.coerce.number().int().positive(),
          enabled: z.stringbool(),
          note: z.string().optional(),
          limit: z.number().default(20),
        }),
      );
    expectParity(schema, [
      { id: "u1", slug: "HELLO", page: "2", enabled: "yes", extra: true },
      { id: "u1", slug: "HELLO", page: "bad", enabled: "yes" },
      { id: "u1", slug: 1, page: "2", enabled: "maybe" },
      null,
    ]);
  });

  it("restores the containing object's build path", () => {
    const schema = z.object({ requestId: z.string(), payload: commonIntersection() });
    expectParity(schema, [
      {
        requestId: "r1",
        payload: {
          id: "u1",
          name: "Ada",
          email: "ada@example.com",
          age: 42,
          active: true,
          tags: [],
          extra: true,
        },
        outerExtra: true,
      },
      { requestId: "r1", payload: null },
    ]);
  });

  it("preserves union option error pruning", () => {
    expectParity(z.union([commonIntersection(), z.literal("other")]), ["other", null, {}, 1]);
  });

  it("returns a fresh merged object without mutating the input", () => {
    const schema = commonIntersection();
    const compiled = compileLikeProduction(schema, "intersectionFresh");
    const input = {
      id: "u1",
      name: "Ada",
      email: "ada@example.com",
      age: 42,
      active: true,
      tags: [],
      extra: true,
    };
    const result = compiled(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).not.toBe(input);
    expect(result.data).toEqual({
      id: "u1",
      name: "Ada",
      email: "ada@example.com",
      age: 42,
      active: true,
      tags: [],
    });
    expect(input.extra).toBe(true);
  });
});
