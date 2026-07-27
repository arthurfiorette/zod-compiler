/**
 * `.catchall(schema)` — unknown keys validated against a value schema.
 *
 * `.catchall(z.never())` is how zod spells `strict`, and `unknown`/`any`
 * catchalls are `looseObject`; both already compiled. A catchall that actually
 * VALIDATES used to delegate the whole object to zod.
 *
 * It now compiles to the same bare `for-in` over the input that the strict pass
 * uses — matching zod's handleCatchall, inherited enumerable keys included — with
 * each unrecognized key checked against the catchall and reported at that key.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractSchema } from "#src/core/extract/index.js";
import type { ObjectIR } from "#src/core/types.js";
import { compileLikeProduction, expectParity } from "./parity-harness.js";

describe("catchall — unknown keys validated instead of delegating", () => {
  it("extracts the value schema as ObjectIR.catchall", () => {
    const ir = extractSchema(z.object({ a: z.string() }).catchall(z.number())) as ObjectIR;
    expect(ir.type).toBe("object");
    expect(ir.catchall).toEqual({ type: "number", checks: [] });
    // strict IS catchall(never), so the two never coexist.
    expect(ir.strict).toBeUndefined();
  });

  it.each([
    [
      "number values",
      z.object({ a: z.string() }).catchall(z.number()),
      [{ a: "x" }, { a: "x", b: 1 }, { a: "x", b: "no" }, { a: "x", b: 1, c: 2 }, {}, "nope", null],
    ],
    [
      "checked string values",
      z.object({ a: z.number() }).catchall(z.string().min(3)),
      [{ a: 1, e: "abc" }, { a: 1, e: "ab" }, { a: 1 }],
    ],
    [
      "optional values",
      z.object({ a: z.number() }).catchall(z.string().optional()),
      [
        { a: 1, e: "s" },
        { a: 1, e: undefined },
        { a: 1, e: 5 },
      ],
    ],
    [
      "object values",
      z.object({ a: z.number() }).catchall(z.object({ n: z.number() })),
      [
        { a: 1, e: { n: 2 } },
        { a: 1, e: { n: "x" } },
        { a: 1, e: 5 },
      ],
    ],
    [
      "array values",
      z.object({ a: z.number() }).catchall(z.array(z.number())),
      [
        { a: 1, e: [1, 2] },
        { a: 1, e: [1, "x"] },
      ],
    ],
    [
      "enum values",
      z.object({ a: z.number() }).catchall(z.enum(["x", "y"])),
      [
        { a: 1, e: "x" },
        { a: 1, e: "z" },
      ],
    ],
    ["an empty shape", z.object({}).catchall(z.number()), [{}, { x: 1 }, { x: "s" }]],
    [
      "a nested object",
      z.object({ o: z.object({ a: z.number() }).catchall(z.string()) }),
      [{ o: { a: 1, e: "s" } }, { o: { a: 1, e: 5 } }],
    ],
    [
      "elements of an array",
      z.array(z.object({ a: z.number() }).catchall(z.string())),
      [[{ a: 1, e: "s" }], [{ a: 1, e: 5 }], []],
    ],
    [
      "an object-level refine",
      z
        .object({ a: z.number() })
        .catchall(z.number())
        .refine((v) => v.a > 0, "pos"),
      [
        { a: 1, e: 2 },
        { a: -1, e: 2 },
        { a: 1, e: "x" },
      ],
    ],
    [
      "an optional declared property",
      z.object({ a: z.number().optional() }).catchall(z.string()),
      [{}, { a: 1 }, { e: "s" }, { a: 1, e: 5 }],
    ],
  ])("matches zod (verdict, issues AND output) for %s", (_label, schema, inputs) => {
    expectParity(schema as never, inputs as unknown[]);
  });

  describe("value-rewriting catchalls write through the key's own slot", () => {
    it.each([
      [
        "trim",
        z.object({ a: z.number() }).catchall(z.string().trim()),
        [{ a: 1, e: "  x  " }, { a: 1, e: 5 }, { a: 1 }],
      ],
      [
        "coerce",
        z.object({ a: z.number() }).catchall(z.coerce.number()),
        [
          { a: 1, e: "5" },
          { a: 1, e: "x" },
        ],
      ],
      [
        "default",
        z.object({ a: z.number() }).catchall(z.string().default("d")),
        [
          { a: 1, e: "s" },
          { a: 1, e: undefined },
        ],
      ],
    ])("%s", (_label, schema, inputs) => {
      expectParity(schema as never, inputs as unknown[]);
    });

    it("rewrites into a clone, leaving the caller's input untouched", () => {
      const schema = z.object({ a: z.number() }).catchall(z.string().trim());
      const input = { a: 1, e: "  x  " };
      const out = compileLikeProduction(schema, "caTrim")(input);
      expect(out).toEqual({ success: true, data: { a: 1, e: "x" } });
      expect(input.e, "the input must not be mutated").toBe("  x  ");
    });
  });

  it("validates keys reached through the prototype, as zod's for-in does", () => {
    // Only the VERDICT is asserted here: zod copies every for-in key into its
    // fresh output object, while compiled output is the input by reference, so
    // an inherited key stays on the prototype (see known-divergences).
    const schema = z.object({ a: z.number() }).catchall(z.string());
    const compiled = compileLikeProduction(schema, "caProto");
    const good = Object.assign(Object.create({ inh: "yes" }), { a: 1 });
    const bad = Object.assign(Object.create({ inh: 99 }), { a: 1 });
    expect(compiled(good).success).toBe(true);
    expect(schema.safeParse(good).success).toBe(true);
    const compiledBad = compiled(bad);
    expect(compiledBad.success).toBe(false);
    expect(compiledBad.error?.issues[0]).toMatchObject({ code: "invalid_type", path: ["inh"] });
    expect(schema.safeParse(bad).error?.issues[0]).toMatchObject({
      code: "invalid_type",
      path: ["inh"],
    });
  });

  it("still delegates when the catchall itself delegates", () => {
    // Compiling would mean a zod call per unknown key; delegating the object
    // once is cheaper (the same trade the all-properties coalescing makes).
    const schema = z.object({ a: z.string() }).catchall(z.string().transform((v, _ctx) => v));
    expect(extractSchema(schema).type).toBe("fallback");
    expectParity(schema, [{ a: "x", e: "y" }]);
  });

  it("keeps strict and loose objects on their existing paths", () => {
    const strict = extractSchema(z.object({ a: z.string() }).catchall(z.never())) as ObjectIR;
    const loose = extractSchema(z.looseObject({ a: z.string() })) as ObjectIR;
    expect(strict.strict).toBe(true);
    expect(strict.catchall).toBeUndefined();
    expect(loose.catchall).toBeUndefined();
    expect(loose.strict).toBeUndefined();
  });
});
