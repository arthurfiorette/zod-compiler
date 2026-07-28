import { describe, expect, it } from "vite-plus/test";
import { KEY_MEMBERSHIP_INLINE_THRESHOLD } from "#src/core/codegen/context.js";
import { generateValidator } from "#src/core/codegen/index.js";
import type { ObjectIR } from "#src/core/types.js";
import { compileFastCheck, compileIR } from "../helpers.js";

describe("slow-path — object", () => {
  it("accepts valid object", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        name: { type: "string", checks: [] },
        age: { type: "number", checks: [] },
      },
    };
    const safeParse = compileIR(ir);
    expect(safeParse({ name: "Alice", age: 30 })).toEqual({
      success: true,
      data: { name: "Alice", age: 30 },
    });
  });

  it("rejects non-object input", () => {
    const ir: ObjectIR = { type: "object", properties: { x: { type: "string", checks: [] } } };
    const safeParse = compileIR(ir);
    expect(safeParse("not an object").success).toBe(false);
    expect(safeParse(42).success).toBe(false);
    expect(safeParse(null).success).toBe(false);
    expect(safeParse(undefined).success).toBe(false);
  });

  it("rejects array as object", () => {
    const ir: ObjectIR = { type: "object", properties: { x: { type: "string", checks: [] } } };
    const safeParse = compileIR(ir);
    expect(safeParse([]).success).toBe(false);
  });

  it("rejects when required property is missing", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        name: { type: "string", checks: [] },
        age: { type: "number", checks: [] },
      },
    };
    const safeParse = compileIR(ir);
    const result = safeParse({ name: "Alice" });
    expect(result.success).toBe(false);
  });

  it("rejects when property type is wrong", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        name: { type: "string", checks: [] },
        age: { type: "number", checks: [] },
      },
    };
    const safeParse = compileIR(ir);
    const result = safeParse({ name: "Alice", age: "thirty" });
    expect(result.success).toBe(false);
  });

  it("validates property checks", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        name: { type: "string", checks: [{ kind: "min_length", minimum: 3 }] },
      },
    };
    const safeParse = compileIR(ir);
    expect(safeParse({ name: "Alice" }).success).toBe(true);
    expect(safeParse({ name: "Al" }).success).toBe(false);
  });

  it("validates nested objects", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            name: { type: "string", checks: [] },
            age: { type: "number", checks: [] },
          },
        },
      },
    };
    const safeParse = compileIR(ir);
    expect(safeParse({ user: { name: "Alice", age: 30 } }).success).toBe(true);
    expect(safeParse({ user: { name: "Alice" } }).success).toBe(false);
    expect(safeParse({ user: "not an object" }).success).toBe(false);
  });

  it("provides correct path in nested errors", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            name: { type: "string", checks: [{ kind: "min_length", minimum: 3 }] },
          },
        },
      },
    };
    const safeParse = compileIR(ir);
    const result = safeParse({ user: { name: "Al" } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ["user", "name"],
    });
  });

  it("accepts empty object for empty schema", () => {
    const ir: ObjectIR = { type: "object", properties: {} };
    const safeParse = compileIR(ir);
    expect(safeParse({}).success).toBe(true);
  });

  it("collects multiple issues", () => {
    const ir: ObjectIR = {
      type: "object",
      properties: {
        a: { type: "string", checks: [] },
        b: { type: "number", checks: [] },
        c: { type: "boolean" },
      },
    };
    const safeParse = compileIR(ir);
    const result = safeParse({ a: 1, b: "two", c: "three" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.length).toBe(3);
  });
});

describe("fast-path — Object", () => {
  it("simple object: {name: string} accepts {name: 'a'}, rejects {name: 42}", () => {
    const fn = compileFastCheck({
      type: "object",
      properties: { name: { type: "string", checks: [] } },
    });
    expect(fn?.({ name: "a" })).toBe(true);
    expect(fn?.({ name: 42 })).toBe(false);
  });

  it("rejects null", () => {
    const fn = compileFastCheck({ type: "object", properties: {} });
    expect(fn?.(null)).toBe(false);
  });

  it("rejects array", () => {
    const fn = compileFastCheck({ type: "object", properties: {} });
    expect(fn?.([])).toBe(false);
  });

  it("rejects non-object", () => {
    const fn = compileFastCheck({ type: "object", properties: {} });
    expect(fn?.("string")).toBe(false);
  });

  it("nested object", () => {
    const fn = compileFastCheck({
      type: "object",
      properties: {
        inner: { type: "object", properties: { x: { type: "number", checks: [] } } },
      },
    });
    expect(fn?.({ inner: { x: 1 } })).toBe(true);
    expect(fn?.({ inner: { x: "a" } })).toBe(false);
  });

  it("ineligible property → returns null", () => {
    expect(
      compileFastCheck({
        type: "object",
        properties: { f: { type: "fallback", reason: "transform" } },
      }),
    ).toBeNull();
  });
});

describe("strict objects (unknown-key rejection)", () => {
  const strictIR: ObjectIR = {
    type: "object",
    strict: true,
    properties: {
      name: { type: "string", checks: [] },
      age: { type: "number", checks: [] },
    },
  };

  it("slow path: accepts exact keys, passes input through", () => {
    const safeParse = compileIR(strictIR);
    const input = { name: "Alice", age: 30 };
    const result = safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data).toBe(input); // pass-through, no clone
  });

  it("slow path: one unrecognized_keys issue carrying ALL unknown keys, after property issues", () => {
    const safeParse = compileIR(strictIR);
    const result = safeParse({ name: 1, age: 30, e1: true, e2: true });
    expect(result.success).toBe(false);
    const issues = result.error?.issues as { code: string; keys?: string[] }[];
    expect(issues.map((i) => i.code)).toEqual(["invalid_type", "unrecognized_keys"]);
    expect(issues[1]?.keys).toEqual(["e1", "e2"]);
  });

  it("slow path: inherited enumerable keys count (zod for-in parity)", () => {
    const safeParse = compileIR(strictIR);
    const input = Object.create({ inherited: 1 }) as Record<string, unknown>;
    input["name"] = "Alice";
    input["age"] = 30;
    const result = safeParse(input);
    expect(result.success).toBe(false);
    expect((result.error?.issues[0] as { keys?: string[] } | undefined)?.keys).toEqual([
      "inherited",
    ]);
  });

  it("slow path: a wide shape accepts its exact keys and rejects an extra", () => {
    const wide: ObjectIR = {
      type: "object",
      strict: true,
      properties: Object.fromEntries(
        Array.from("abcdefg", (k) => [k, { type: "string", checks: [] }]),
      ),
    };
    const safeParse = compileIR(wide);
    const ok = Object.fromEntries(Array.from("abcdefg", (k) => [k, "v"]));
    expect(safeParse(ok).success).toBe(true);
    expect(safeParse({ ...ok, zz: "v" }).success).toBe(false);
  });

  /**
   * The unknown-key pass compares each for-in key against the shape's keys with
   * an inline `===` chain (a Set past KEY_MEMBERSHIP_INLINE_THRESHOLD). Both
   * forms test string identity, so `Object.prototype`'s own names — `toString`,
   * `constructor`, `valueOf` — are unrecognized exactly like any other undeclared
   * key, and a DECLARED key of the same name is recognized.
   */
  describe("unknown-key membership", () => {
    const wideIR = (keys: readonly string[]): ObjectIR => ({
      type: "object",
      strict: true,
      properties: Object.fromEntries(keys.map((k) => [k, { type: "string", checks: [] }])),
    });
    const valueFor = (keys: readonly string[]): Record<string, string> =>
      Object.fromEntries(keys.map((k) => [k, "v"]));
    const plain = ["a", "b", "c", "d", "e", "f"];

    it.each(["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"])(
      "treats an undeclared %s key as unrecognized",
      (inherited) => {
        const input = { ...valueFor(plain), [inherited]: "v" };
        expect(compileFastCheck(wideIR(plain))?.(input)).toBe(false);
        const result = compileIR(wideIR(plain))(input);
        expect(result.success).toBe(false);
        expect((result.error?.issues[0] as { keys?: string[] } | undefined)?.keys).toEqual([
          inherited,
        ]);
      },
    );

    it("recognizes a DECLARED key that shadows an Object.prototype name", () => {
      const keys = ["toString", "valueOf", "c", "d", "e", "f"];
      expect(compileFastCheck(wideIR(keys))?.(valueFor(keys))).toBe(true);
      expect(compileIR(wideIR(keys))(valueFor(keys)).success).toBe(true);
    });

    // The unknown-key pass switches from an inline `===` chain to a Set past
    // KEY_MEMBERSHIP_INLINE_THRESHOLD. Both forms must recognize exactly the
    // same key set, so the shapes either side of the boundary are pinned here —
    // a threshold change can move which form is emitted, never the verdict.
    describe.each([
      ["below the threshold", KEY_MEMBERSHIP_INLINE_THRESHOLD - 1, false],
      ["at the threshold", KEY_MEMBERSHIP_INLINE_THRESHOLD, false],
      ["above the threshold", KEY_MEMBERSHIP_INLINE_THRESHOLD + 1, true],
    ])("strict shape %s (%i keys)", (_label, count, expectSet) => {
      const keys = Array.from({ length: count }, (_, i) => `f${i}`);

      it(`emits the ${expectSet ? "Set" : "inline chain"} form`, () => {
        const code = generateValidator(wideIR(keys), "boundary").code;
        expect(code.includes("new Set(")).toBe(expectSet);
      });

      it("accepts the exact shape and rejects one extra key", () => {
        const fast = compileFastCheck(wideIR(keys));
        const exact = valueFor(keys);
        expect(fast?.(exact)).toBe(true);
        expect(compileIR(wideIR(keys))(exact).success).toBe(true);

        const extra = { ...exact, surprise: "v" };
        expect(fast?.(extra)).toBe(false);
        expect(compileIR(wideIR(keys))(extra).success).toBe(false);
      });

      it("rejects an inherited enumerable key", () => {
        const child = Object.create({ inherited: "v" }) as Record<string, string>;
        for (const k of keys) child[k] = "v";
        expect(compileFastCheck(wideIR(keys))?.(child)).toBe(false);
        expect(compileIR(wideIR(keys))(child).success).toBe(false);
      });
    });

    it("recognizes a DECLARED __proto__ key", () => {
      const keys = ["__proto__", "b", "c", "d", "e", "f"];
      // `k==="__proto__"` is an ordinary string compare, so the inline chain
      // handles this shape directly — where a `{key:1}` lookup table could not
      // hold the key at all (an object literal's `__proto__` sets the prototype
      // instead of defining a property) and had to fall back to a Set.
      const generated = generateValidator(wideIR(keys), "protoKey");
      expect(generated.code).toContain('==="__proto__"');
      const input = JSON.parse(
        `{"__proto__":"v","b":"v","c":"v","d":"v","e":"v","f":"v"}`,
      ) as Record<string, string>;
      expect(compileFastCheck(wideIR(keys))?.(input)).toBe(true);
      expect(compileIR(wideIR(keys))(input).success).toBe(true);
    });
  });

  it("fast path: strict stays eligible and rejects extras", () => {
    const fn = compileFastCheck(strictIR);
    expect(fn).not.toBeNull();
    expect(fn?.({ name: "Alice", age: 30 })).toBe(true);
    expect(fn?.({ name: "Alice", age: 30, extra: 1 })).toBe(false);
  });

  it("fast path: empty strict shape rejects any key", () => {
    const fn = compileFastCheck({ type: "object", strict: true, properties: {} });
    expect(fn?.({})).toBe(true);
    expect(fn?.({ any: 1 })).toBe(false);
  });
});
