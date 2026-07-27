/**
 * Unknown-key stripping — the compiler's default, matching zod's.
 *
 * A genuine `z.object()` rebuilds a fresh object from only the declared keys;
 * `z.looseObject()` keeps extras and `z.strictObject()` rejects them, both
 * unchanged. The rebuild happens in the single validate-and-build pass of
 * build-path.ts, so these cases also exercise that generator: every position
 * below (nested, array element, record value, tuple slot, union option) is a
 * container it has to reshape correctly, and each is compared against zod for
 * the full result — verdict, issues, and output data including key order.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { SafeParseSuccess } from "#src/core/types.js";
import { compileLikeProduction, expectParity } from "./parity-harness.js";

const dataOf = (r: { success: boolean }): Record<string, unknown> =>
  (r as SafeParseSuccess<Record<string, unknown>>).data;

describe("unknown-key stripping — parity with zod's default strip", () => {
  it("top-level object strips extra keys", () => {
    expectParity(
      z.object({ a: z.string(), n: z.number() }),
      [{ a: "x", n: 1, b: 2, c: "extra" }],
      "stripTop",
    );
  });

  it("nested object strips extra keys at depth", () => {
    expectParity(
      z.object({ outer: z.object({ a: z.string() }) }),
      [{ outer: { a: "x", b: 2 }, extra: 9 }],
      "stripNested",
    );
  });

  it("object inside an array element strips extra keys", () => {
    expectParity(
      z.array(z.object({ a: z.string() })),
      [
        [
          { a: "x", b: 1 },
          { a: "y", z: 9 },
        ],
      ],
      "stripArrayEl",
    );
  });

  it(".pick() result strips extra keys", () => {
    expectParity(
      z.object({ a: z.string(), b: z.number() }).pick({ a: true }),
      [{ a: "x", b: 1, c: 9 }],
      "stripPick",
    );
  });

  it(".partial() result strips extra keys", () => {
    expectParity(
      z.object({ a: z.string(), b: z.number() }).partial(),
      [{ a: "x", z: 9 }, {}, { b: 2, extra: true }],
      "stripPartial",
    );
  });

  it(".omit() / .extend() results strip extra keys", () => {
    expectParity(
      z.object({ a: z.string(), b: z.number() }).omit({ b: true }),
      [{ a: "x", b: 1 }],
      "stripOmit",
    );
    expectParity(
      z.object({ a: z.string() }).extend({ b: z.number() }),
      [{ a: "x", b: 1, c: 9 }],
      "stripExtend",
    );
  });

  it("discriminated-union option strips extra keys", () => {
    expectParity(
      z.discriminatedUnion("t", [
        z.object({ t: z.literal("a"), x: z.string() }),
        z.object({ t: z.literal("b"), y: z.number() }),
      ]),
      [
        { t: "a", x: "s", extra: 9 },
        { t: "b", y: 4, junk: "drop" },
      ],
      "stripDU",
    );
  });

  it("plain union of objects strips extra keys per matched option", () => {
    expectParity(
      z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
      [
        { a: "x", junk: 1 },
        { b: 2, junk: 3 },
      ],
      "stripUnion",
    );
  });

  it("preserves presence semantics: optional, default, nullable", () => {
    expectParity(
      z.object({ a: z.string().optional() }),
      [{}, { a: "x", extra: 1 }, { a: undefined }],
      "stripOptional",
    );
    expectParity(
      z.object({ a: z.string().default("d") }),
      [{ extra: 1 }, { a: "v", extra: 1 }],
      "stripDefault",
    );
    expectParity(z.object({ a: z.string().nullable() }), [{ a: null, extra: 1 }], "stripNullable");
  });

  it("strips value-mutating fields after rewriting them", () => {
    expectParity(z.object({ a: z.string().trim() }), [{ a: "  hi  ", extra: 1 }], "stripTrim");
    expectParity(z.object({ n: z.coerce.number() }), [{ n: "42", extra: 1 }], "stripCoerce");
  });

  it("empty z.object({}) strips everything", () => {
    expectParity(z.object({}), [{ a: 1, b: 2 }, {}], "stripEmpty");
  });

  it("rejection parity is unchanged by stripping", () => {
    expectParity(
      z.object({ a: z.string(), n: z.number() }),
      [{ a: 1, n: "no", extra: true }, "not an object", null, []],
      "stripReject",
    );
  });
});

describe("unknown-key stripping — looseObject / strictObject unaffected", () => {
  it("looseObject still keeps unknown keys", () => {
    expectParity(z.looseObject({ a: z.string() }), [{ a: "x", b: 1, c: 2 }], "stripLoose");
  });

  it("strictObject still rejects unknown keys", () => {
    expectParity(z.strictObject({ a: z.string() }), [{ a: "x", b: 1 }, { a: "x" }], "stripStrict");
  });
});

describe("unknown-key stripping — intersection delegates to zod (merge+strip)", () => {
  it("intersection of objects strips keys outside both shapes", () => {
    expectParity(
      z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })),
      [{ a: "x", b: 1, c: 9 }],
      "stripIntersection",
    );
  });
});

describe("unknown-key stripping — mechanism", () => {
  it("returns a FRESH object (not the input by reference)", () => {
    const schema = z.object({ a: z.string() });
    const input = { a: "x", b: 1 };
    const compiled = compileLikeProduction(schema, "stripFresh");
    const r = compiled(input);
    expect(r.success).toBe(true);
    expect(dataOf(r)).not.toBe(input);
    expect(dataOf(r)).toEqual({ a: "x" });
    expect(Object.keys(dataOf(r))).toEqual(["a"]);
    // input itself is never mutated
    expect(input).toEqual({ a: "x", b: 1 });
  });

  it("drops symbol-keyed extras", () => {
    const sym = Symbol("s");
    const schema = z.object({ a: z.string() });
    const compiled = compileLikeProduction(schema, "stripSym");
    const r = compiled({ a: "x", [sym]: 9 });
    expect(r.success).toBe(true);
    expect(sym in dataOf(r)).toBe(false);
    expect(Object.keys(dataOf(r))).toEqual(["a"]);
  });

  it("strips a JSON-style own-enumerable __proto__ key without polluting", () => {
    const schema = z.object({ a: z.string() });
    const input = JSON.parse('{"a":"x","__proto__":{"polluted":true}}') as Record<string, unknown>;
    const compiled = compileLikeProduction(schema, "stripProto");
    const r = compiled(input);
    expect(r.success).toBe(true);
    expect(Object.keys(dataOf(r))).toEqual(["a"]);
    expect(Object.getPrototypeOf(dataOf(r))).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  /**
   * The rebuild reads `input[key]` and keeps the key when the parsed value is
   * defined, or when `key in input` — zod's own rule (see its object fast-path
   * codegen), which is prototype-inclusive. An earlier rebuild copied own keys
   * first and validated the copy, so an inherited value was invisible: a
   * required key read as `undefined` and REJECTED, and an inherited optional
   * was silently dropped from the output. Both now match zod.
   */
  describe("inherited (prototype) values follow zod", () => {
    it("accepts and copies an inherited required key", () => {
      const schema = z.object({ a: z.string() });
      const input = Object.create({ a: "fromProto" }) as Record<string, unknown>;
      expect(schema.safeParse(input).success).toBe(true); // zod accepts it
      const r = compileLikeProduction(schema, "stripInheritedReq")(input);
      expect(r.success).toBe(true);
      expect(dataOf(r)).toEqual({ a: "fromProto" });
      expect(Object.keys(dataOf(r))).toEqual(["a"]);
    });

    it("copies an inherited optional key", () => {
      const schema = z.object({ a: z.string(), b: z.string().optional() });
      const input = Object.create({ b: "protoB" }) as Record<string, unknown>;
      input["a"] = "own";
      expectParity(schema, [input], "stripInheritedOpt");
      const r = compileLikeProduction(schema, "stripInheritedOpt2")(input);
      expect(Object.keys(dataOf(r))).toEqual(["a", "b"]);
    });

    it("keeps an own present-but-undefined optional, omits an absent one", () => {
      const schema = z.object({ a: z.string(), b: z.string().optional() });
      const compiled = compileLikeProduction(schema, "stripUndef");
      expect(Object.keys(dataOf(compiled({ a: "x", b: undefined })))).toEqual(["a", "b"]);
      expect(Object.keys(dataOf(compiled({ a: "x" })))).toEqual(["a"]);
    });
  });

  it("rebuilds keys in shape order, not input order", () => {
    const schema = z.object({ a: z.string(), b: z.string().optional(), c: z.string() });
    const compiled = compileLikeProduction(schema, "stripOrder");
    const reversed = { c: "C", b: "B", a: "A" };
    expect(Object.keys(dataOf(compiled(reversed)))).toEqual(["a", "b", "c"]);
    expect(Object.keys(schema.safeParse(reversed).data as object)).toEqual(["a", "b", "c"]);
    // …and an absent middle optional leaves the surrounding order intact.
    expect(Object.keys(dataOf(compiled({ a: "A", c: "C" })))).toEqual(["a", "c"]);
  });

  it("returns a fresh object, never the input", () => {
    const schema = z.object({ a: z.string() });
    const input = { a: "x", b: 1 };
    const compiled = compileLikeProduction(schema, "stripFresh");
    const r = compiled(input);
    expect(r.success).toBe(true);
    expect(dataOf(r)).not.toBe(input); // rebuilt, so the extras cannot ride along
    expect(dataOf(r)).toEqual({ a: "x" });
    expect(input).toEqual({ a: "x", b: 1 }); // and the caller's object is untouched
  });
});

/**
 * Positions the build pass has to RESHAPE rather than pass through. Each is a
 * container whose own output is a new value only because something inside it
 * strips, so each needs its own rebuild rule — and a container the pass fails
 * to recognise degrades silently: the verdict stays right while unknown keys
 * ride through in the payload.
 *
 * Recursion is the sharp case. A back-edge has no children of its own, so a
 * subtree reached only through one looks like it reshapes nothing; treating it
 * that way rebuilt the outermost object and passed every nested one through
 * untouched. `expectParity` compares output data, so these pin the payload and
 * not just the verdict.
 */
describe("unknown-key stripping — through recursion, unions and deep nesting", () => {
  const Tree: z.ZodType = z.lazy(() => z.object({ v: z.string(), c: z.array(Tree).optional() }));

  it("strips at every level of a recursive schema", () =>
    expectParity(
      Tree,
      [
        JSON.parse('{"v":"root","X":1}'),
        JSON.parse('{"v":"root","X":1,"c":[{"v":"a","Y":2}]}'),
        JSON.parse('{"v":"r","c":[{"v":"a","Y":2,"c":[{"v":"deep","Z":3}]}]}'),
        JSON.parse('{"v":"r","c":[{"v":1}]}'),
      ],
      "stripRecursive",
    ));

  it("strips inside a mutually recursive pair", () => {
    const Node: z.ZodType = z.lazy(() => z.object({ n: z.string(), kids: z.array(Leaf) }));
    const Leaf: z.ZodType = z.lazy(() => z.object({ l: z.number(), parent: Node.optional() }));
    expectParity(
      Node,
      [
        JSON.parse('{"n":"a","EXTRA":1,"kids":[]}'),
        JSON.parse('{"n":"a","kids":[{"l":1,"E":2}]}'),
        JSON.parse('{"n":"a","kids":[{"l":1,"parent":{"n":"b","E":3,"kids":[]}}]}'),
      ],
      "stripMutual",
    );
  });

  it("strips inside each option of a union", () =>
    expectParity(
      z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
      [JSON.parse('{"a":"x","EXTRA":1}'), JSON.parse('{"b":2,"EXTRA":1}'), JSON.parse('{"c":3}')],
      "stripUnion",
    ));

  it("strips inside each option of a discriminated union", () =>
    expectParity(
      z.discriminatedUnion("t", [
        z.object({ t: z.literal("a"), x: z.string() }),
        z.object({ t: z.literal("b"), y: z.number() }),
      ]),
      [
        JSON.parse('{"t":"a","x":"s","EXTRA":1}'),
        JSON.parse('{"t":"b","y":1,"EXTRA":1}'),
        JSON.parse('{"t":"c"}'),
      ],
      "stripDiscUnion",
    ));

  it("strips through a union nested in a recursive schema", () => {
    const Content: z.ZodType = z.lazy(() =>
      z.union([
        z.object({ kind: z.literal("leaf"), v: z.string() }),
        z.object({ kind: z.literal("node"), kids: z.array(Content) }),
      ]),
    );
    expectParity(
      Content,
      [
        JSON.parse('{"kind":"leaf","v":"x","E":1}'),
        JSON.parse('{"kind":"node","E":1,"kids":[{"kind":"leaf","v":"y","E2":2}]}'),
      ],
      "stripUnionRec",
    );
  });

  it("strips at depth under optional / nullable / readonly wrappers", () =>
    expectParity(
      z.object({
        a: z.object({ b: z.object({ c: z.string() }).optional() }).nullable(),
        d: z.array(z.object({ e: z.string() })).readonly(),
      }),
      [
        JSON.parse('{"a":null,"d":[{"e":"x","E":1}]}'),
        JSON.parse('{"a":{"b":{"c":"x","E":1},"E2":2},"d":[]}'),
        JSON.parse('{"a":{"E2":2},"d":[{"e":"x"}]}'),
      ],
      "stripWrappers",
    ));

  it("strips inside a record value and a tuple slot", () => {
    expectParity(
      z.record(z.string(), z.object({ a: z.string() })),
      [JSON.parse('{"k":{"a":"x","E":1},"j":{"a":"y"}}')],
      "stripRecordValue",
    );
    expectParity(
      z.tuple([z.object({ a: z.string() }), z.object({ b: z.number() })]),
      [JSON.parse('[{"a":"x","E":1},{"b":2,"E":2}]')],
      "stripTupleSlot",
    );
  });
});
