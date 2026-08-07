/**
 * Differential parity for Zod API surface the rest of the suite never reached.
 *
 * Everything here is a schema form Zod itself documents and parses fine, but
 * that no existing test exercised — so a divergence could ship green. Each case
 * pins both halves: `expectParity` compares accept/reject, output data and the
 * whole issue list against Zod, and `expectCompiled` proves the schema really
 * compiled (no `fallback` IR, no Zod-delegated refs) rather than silently
 * handing the work back to Zod, which would hide a divergence by construction.
 */
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import type { RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import { compileLikeProduction, expectParity } from "./parity-harness.js";

/** Extraction produced a real compiled validator, not a delegation to Zod. */
function expectCompiled(schema: unknown): void {
  const refs: RefEntry[] = [];
  const ir = extractSchema(schema, refs);
  expect(ir.type, "root IR should not be a Zod fallback").not.toBe("fallback");
  expect(refs, "schema should compile with no Zod-delegated fallbacks").toHaveLength(0);
}

// ─── Getter-declared recursion ──────────────────────────────────────────────
// Zod v4 documents shape getters — `get subcategories() { return z.array(Cat) }`
// — as the way to declare a recursive schema, and unlike `z.lazy()` the cycle
// carries no marker node: the back-edge is an ordinary shape entry. Detection
// therefore has to come from `dispatch` re-entering a schema still on the
// `visiting` stack; before that existed, extraction walked the same shape until
// the process died with "Maximum call stack size exceeded".

describe("getter-declared recursion", () => {
  it("self-referencing object (root cycle)", () => {
    const Category = z.object({
      name: z.string(),
      get subcategories() {
        return z.array(Category);
      },
    });
    expectCompiled(Category);
    expectParity(
      Category,
      [
        { name: "root", subcategories: [] },
        { name: "root", subcategories: [{ name: "kid", subcategories: [] }] },
        {
          name: "root",
          subcategories: [
            { name: "kid", subcategories: [{ name: "grandkid", subcategories: [] }] },
          ],
        },
        { name: "root", subcategories: [{ name: 7, subcategories: [] }] },
        { name: "root", subcategories: [{ name: "kid", subcategories: [{ name: "gk" }] }] },
        { name: "root" },
        { name: "root", subcategories: "nope" },
        { name: 1, subcategories: [] },
        "nope",
        null,
      ],
      "getterCategory",
    );
  });

  it("direct self-reference through .optional()", () => {
    const Employee = z.object({
      name: z.string(),
      get manager() {
        return Employee.optional();
      },
    });
    expectCompiled(Employee);
    expectParity(
      Employee,
      [
        { name: "a" },
        { name: "a", manager: { name: "b" } },
        { name: "a", manager: { name: "b", manager: { name: "c" } } },
        { name: "a", manager: { name: 2 } },
        { name: "a", manager: { name: "b", manager: { name: null } } },
        { name: "a", manager: null },
        { name: "a", manager: {} },
      ],
      "getterEmployee",
    );
  });

  it("non-root recursion target (cycle back to a sub-schema)", () => {
    const Comment = z.object({
      body: z.string(),
      get replies() {
        return z.array(Comment);
      },
    });
    const Post = z.object({ title: z.string(), thread: Comment });
    expectCompiled(Post);

    // The cycle returns to `thread`, not to the compiled root, so it must take
    // the same route a nested `z.lazy()` cycle does: a `recursionTarget` hosting
    // the sub-schema as its own validator, with the back-edge naming that id
    // rather than re-invoking the (wrong-shaped) root.
    const ir = extractSchema(Post) as {
      properties: Record<string, unknown>;
    };
    const thread = ir.properties["thread"] as {
      type: string;
      refId: number;
      inner: { properties: Record<string, { element: unknown }> };
    };
    expect(thread.type).toBe("recursionTarget");
    expect(thread.refId).toBe(1);
    expect(thread.inner.properties["replies"]?.element).toEqual({
      type: "recursiveRef",
      refId: 1,
    });

    expectParity(
      Post,
      [
        { title: "t", thread: { body: "b", replies: [] } },
        { title: "t", thread: { body: "b", replies: [{ body: "r", replies: [] }] } },
        {
          title: "t",
          thread: { body: "b", replies: [{ body: "r", replies: [{ body: "rr", replies: [] }] }] },
        },
        { title: "t", thread: { body: "b", replies: [{ body: 1, replies: [] }] } },
        { title: 1, thread: { body: "b", replies: [] } },
        { title: "t", thread: "nope" },
        { title: "t" },
      ],
      "getterPost",
    );
  });

  it("two back-edges to the same recursion target", () => {
    const Tree = z.object({
      value: z.number(),
      get left() {
        return Tree.nullable();
      },
      get right() {
        return Tree.nullable();
      },
    });
    const Doc = z.object({ tree: Tree });
    expectCompiled(Doc);

    // Both back-edges name the SAME hosted validator: the second one must reuse
    // the refId minted by the first, and detecting it at all depends on `Tree`
    // still being on the `visiting` stack after the first back-edge returned.
    const ir = extractSchema(Doc) as {
      properties: Record<string, { inner: { properties: Record<string, { inner: unknown }> } }>;
    };
    const node = ir.properties["tree"]?.inner.properties;
    expect(node?.["left"]?.inner).toEqual({ type: "recursiveRef", refId: 1 });
    expect(node?.["right"]?.inner).toEqual({ type: "recursiveRef", refId: 1 });

    expectParity(
      Doc,
      [
        { tree: { value: 1, left: null, right: null } },
        { tree: { value: 1, left: { value: 2, left: null, right: null }, right: null } },
        {
          tree: {
            value: 1,
            left: null,
            right: { value: 3, left: { value: 4, left: null, right: null }, right: null },
          },
        },
        { tree: { value: 1, left: { value: "x", left: null, right: null }, right: null } },
        { tree: { value: 1, left: null } },
        { tree: { value: 1, left: null, right: 5 } },
      ],
      "getterTree",
    );
  });

  it("getter cycle reached through a union", () => {
    const Shape = z.object({
      id: z.string(),
      get child() {
        return z.union([z.null(), Shape]);
      },
    });
    expectCompiled(Shape);
    expectParity(
      Shape,
      [
        { id: "a", child: null },
        { id: "a", child: { id: "b", child: null } },
        { id: "a", child: { id: "b", child: { id: "c", child: null } } },
        { id: "a", child: { id: 1, child: null } },
        { id: "a", child: 5 },
        { id: "a" },
      ],
      "getterUnion",
    );
  });

  it("getter cycle reached through a record", () => {
    const Dir = z.object({
      name: z.string(),
      get children() {
        return z.record(z.string(), Dir);
      },
    });
    expectCompiled(Dir);
    expectParity(
      Dir,
      [
        { name: "root", children: {} },
        { name: "root", children: { a: { name: "a", children: {} } } },
        {
          name: "root",
          children: { a: { name: "a", children: { b: { name: "b", children: {} } } } },
        },
        { name: "root", children: { a: { name: 1, children: {} } } },
        { name: "root", children: { a: "nope" } },
        { name: "root", children: null },
        { name: "root" },
      ],
      "getterDir",
    );
  });
});

// ─── Recursion back-edge refIds ─────────────────────────────────────────────
// A back-edge is keyed on the schema the cycle RE-ENTERS, and the id it carries
// decides which validator runs: refId 0 — encoded as an ABSENT `refId` — means
// "re-invoke the root's own safeParse_<name>", while any id ≥ 1 makes codegen
// host a separate validator for the target and call that instead. So an id that
// drifts from 0 to 1 costs a hosted helper and an extra call per recursion step
// while leaving every result identical, which no parity assertion can see —
// only the IR shape can. These pin it, because two detectors in different
// frames now mint those ids (`extractLazy` keyed on what a `z.lazy()` resolves
// to, `dispatch` keyed on a re-entered schema) and they must not disagree.

describe("recursion back-edge refIds", () => {
  it("root z.lazy() self-recursion keeps the implicit refId 0", () => {
    // The back-edge lands on the ROOT LAZY NODE itself (not on some inner
    // schema), so dispatch re-enters a lazy — the one case where the generic
    // getter-cycle guard must stand down and let extractLazy key the ref on the
    // schema the lazy RESOLVES to, which is what refId 0 identifies.
    const Lazy: z.ZodType = z.lazy(() => z.object({ n: z.number(), next: Lazy.optional() }));
    const ir = extractSchema(Lazy) as {
      type: string;
      properties: Record<string, { inner: unknown }>;
    };
    expect(ir.type).toBe("object");
    expect(ir.properties["next"]?.inner).toEqual({ type: "recursiveRef" });

    expectCompiled(Lazy);
    expectParity(
      Lazy,
      [
        { n: 1 },
        { n: 1, next: { n: 2 } },
        { n: 1, next: { n: 2, next: { n: 3 } } },
        { n: 1, next: { n: "x" } },
        { n: 1, next: null },
      ],
      "rootLazySelf",
    );
  });

  it("getter-declared root self-recursion keeps the implicit refId 0", () => {
    const Category = z.object({
      name: z.string(),
      get subs() {
        return z.array(Category);
      },
    });
    const ir = extractSchema(Category) as {
      type: string;
      properties: Record<string, { element: unknown }>;
    };
    expect(ir.type).toBe("object");
    expect(ir.properties["subs"]?.element).toEqual({ type: "recursiveRef" });
  });

  it("non-root target hosts one validator, lazy and getter alike", () => {
    const LazyInner: z.ZodType = z.object({
      v: z.string(),
      self: z.array(z.lazy(() => LazyInner)),
    });
    const GetterInner = z.object({
      v: z.string(),
      get self() {
        return z.array(GetterInner);
      },
    });
    const expected = {
      type: "recursionTarget",
      refId: 1,
      inner: {
        type: "object",
        properties: {
          v: { type: "string", checks: [] },
          self: { type: "array", element: { type: "recursiveRef", refId: 1 }, checks: [] },
        },
        stripUnknownKeys: true,
      },
    };
    for (const [label, Inner] of [
      ["lazy", LazyInner],
      ["getter", GetterInner],
    ] as const) {
      const ir = extractSchema(z.object({ node: Inner })) as {
        properties: Record<string, unknown>;
      };
      // Both declaration forms of one cycle must extract to the same hosted
      // target and the same back-edge id — the ref calls `__rsp_1`/`__fcr_1`,
      // and a mismatch would call a validator built for a different shape.
      expect(ir.properties["node"], `${label} non-root target`).toEqual(expected);
    }
  });

  it("mutual recursion still resolves back through the root", () => {
    const A: z.ZodType = z.object({ b: z.lazy(() => B).optional() });
    const B: z.ZodType = z.object({ a: z.lazy(() => A).optional() });
    const ir = extractSchema(A) as {
      properties: Record<string, { inner: { properties: Record<string, { inner: unknown }> } }>;
    };
    // A → B is inlined (B is not itself a cycle target); B → A closes the cycle
    // on the root, so it stays the implicit refId 0 rather than hosting B.
    expect(ir.properties["b"]?.inner.properties["a"]?.inner).toEqual({ type: "recursiveRef" });

    expectCompiled(A);
    expectParity(
      A,
      [{}, { b: {} }, { b: { a: {} } }, { b: { a: { b: {} } } }, { b: { a: 5 } }, { b: 5 }],
      "mutualRec",
    );
  });
});

// ─── Empty-valued enums ─────────────────────────────────────────────────────
// An enum whose accepted-value set is EMPTY is legal in Zod and rejects every
// input with `invalid_value` / `values: []`. Three public spellings reach it,
// and the third is the one nobody expects: `z.enum([1, 2])` — a NUMERIC ARRAY —
// becomes the entries `{1: 1, 2: 2}`, which Zod cannot tell apart from a TS
// numeric enum's reverse mapping, so its reverse-mapping filter strips the lot
// and leaves `_zod.values` empty.
//
// Codegen built both the slow walk's `&&` chain and the fast check's `||` chain
// by JOINING per-value comparisons, and an empty join is an empty STRING: the
// emitted source was `if(){...}` and `return ();`. That is not a divergence but
// a SyntaxError at Function-construction time, i.e. the whole compile died.

describe("empty-valued enums", () => {
  const spellings: [string, z.ZodType][] = [
    ["array", z.enum([])],
    ["object", z.enum({})],
    // Numeric array: entries {1:1, 2:2} → reverse-mapping filter empties values.
    ["numericArray", z.enum([1, 2] as never)],
  ];

  const inputs = ["a", "", "1", 1, 2, 0, -1, null, undefined, true, NaN, {}, [], Symbol("s")];

  for (const [label, schema] of spellings) {
    it(`z.enum (${label}) rejects everything, exactly as zod does`, () => {
      expectCompiled(schema);
      expectParity(schema, inputs, `emptyEnum_${label}`);
    });

    it(`z.enum (${label}) reports invalid_value with an empty values array`, () => {
      // expectParity compares issue code+path and the first message; the
      // `values` field itself is what zod fills from its (empty) value set, so
      // pin it here rather than trusting the code alone.
      const compiled = compileLikeProduction(schema, `emptyEnumValues_${label}`);
      const result = compiled("anything");
      expect(result.success).toBe(false);
      if (result.success) return;
      const issue = result.error.issues[0] as { code?: string; values?: unknown[] };
      expect(issue.code).toBe("invalid_value");
      expect(issue.values).toStrictEqual([]);
      // …and zod agrees.
      const zodResult = schema.safeParse("anything");
      expect(zodResult.success).toBe(false);
      if (zodResult.success) return;
      expect((zodResult.error.issues[0] as { values?: unknown[] }).values).toStrictEqual([]);
    });

    it(`z.enum (${label}) nested in containers keeps the fast check well-formed`, () => {
      // Nesting is what exercises the FAST path: the empty check is spliced
      // into a larger boolean expression, where an empty join would also have
      // wrecked the surrounding operator precedence.
      const obj = z.object({ ok: z.string(), bad: schema });
      expectCompiled(obj);
      expectParity(
        obj,
        [{ ok: "x", bad: "y" }, { ok: "x", bad: 1 }, { ok: 1, bad: "y" }, { ok: "x" }, {}, null],
        `emptyEnumObject_${label}`,
      );

      const arr = z.array(schema);
      expectCompiled(arr);
      expectParity(arr, [[], ["a"], [1], ["a", "b"], null, "nope"], `emptyEnumArray_${label}`);

      const opt = z.object({ v: schema.optional() });
      expectCompiled(opt);
      expectParity(opt, [{}, { v: undefined }, { v: "a" }, { v: 1 }], `emptyEnumOpt_${label}`);
    });
  }
});

// ─── Literal values with no JS source form ──────────────────────────────────
// `z.literal()` is TYPED as `util.Literal` (string | number | bigint | boolean |
// null | undefined), but its runtime is `new Set(def.values).has(input)` — so a
// SYMBOL is accepted at construction AND matched at parse time. Zod users do
// pass one (branded keys, registry symbols), and the schema genuinely works.
//
// Codegen rendered every literal through `literalToJs`, whose tail was
// `JSON.stringify` — and `JSON.stringify(aSymbol)` returns the VALUE `undefined`,
// not a string. So `z.literal(sym)` compiled to `input===undefined`: it REJECTED
// the very symbol it was built from and ACCEPTED `undefined`, a hole in both
// directions. `z.literal([sym, "b"])` compiled to `x===undefined||x==="b"` and
// reported `values:[,"b"]` — an array HOLE, since `join` renders `undefined` as
// the empty string. An OBJECT value broke the same way in one direction:
// `x==={}` is never true, so the object the schema was built from was rejected.
//
// The fix keeps the schema in `__rf[]` and tests `values.includes(input)`
// against its own `_zod.def.values`. `Array.prototype.includes` is SameValueZero
// — exactly what `Set.prototype.has` does — so the verdict matches zod's, and
// emitting that same array as the issue's `values` matches what zod reports.
//
// Delegating the literal to `__rf[N].safeParse` instead would have been WRONG,
// and the tests below pin why: zod's locale renders `invalid_value` through
// `stringifyPrimitive`, i.e. `` `${value}` ``, which is a TypeError on a symbol.
// A union DISCARDS a losing option's issues without ever formatting them, so
// `z.union([z.literal(sym), z.string()]).safeParse("a")` succeeds in zod — while
// a delegating arm would run a full safeParse and THROW on that same valid input.

describe("literal values with no JS source form", () => {
  const SYM = Symbol.for("zod-compiler.literal.k");
  const OTHER = Symbol.for("zod-compiler.literal.other");
  const OBJ = { tag: "identity" };

  /** The literal really compiled, retaining exactly one schema for its value list. */
  function expectRuntimeValuesCompiled(schema: unknown): void {
    const refs: RefEntry[] = [];
    const ir = extractSchema(schema, refs) as { type: string; refIndex?: number };
    expect(ir.type, "must compile, not delegate to zod").toBe("literal");
    expect(ir.refIndex, "must retain the schema to read def.values from").toBe(0);
    expect(refs, "exactly one retained schema").toHaveLength(1);
  }

  /**
   * Zod cannot even REPORT a symbol-literal mismatch — it throws while
   * formatting, from inside `safeParse`. The compiler defers every message to
   * the `.error` accessor, so `safeParse` returns a plain rejection and the
   * identical TypeError surfaces on the first `.error` read.
   */
  function expectDeferredFormatThrow(
    compiled: (input: unknown) => { success: boolean },
    schema: { safeParse: (input: unknown) => unknown },
    input: unknown,
  ): void {
    expect(() => schema.safeParse(input), "zod throws eagerly").toThrow(TypeError);
    const result = compiled(input) as
      | { success: true }
      | { success: false; readonly error: unknown };
    expect(result.success, "compiled rejects without throwing").toBe(false);
    if (result.success) return;
    expect(() => result.error, "compiled throws the same error, deferred").toThrow(TypeError);
  }

  it("accepts the symbol it was built from and rejects undefined", () => {
    const schema = z.literal(SYM as never);
    expectRuntimeValuesCompiled(schema);
    const compiled = compileLikeProduction(schema, "symLiteral");

    // The accept direction: zod accepts this, and so must the compiled form.
    expect(schema.safeParse(SYM).success).toBe(true);
    expect(compiled(SYM).success).toBe(true);

    // The reject direction: `undefined` was the value the broken comparison had
    // baked in, so it is the one input that must not sneak through.
    for (const input of [undefined, null, "k", 0, false, OTHER, Symbol("k")]) {
      expect(compiled(input).success, `rejects ${String(input)}`).toBe(false);
    }
  });

  it("reports the schema's own values array in the issue", () => {
    // Zod's invalid_value issue carries `def.values` — the array object itself,
    // not a copy — so the compiled issue must carry that same array. Pinned on
    // an OBJECT literal because a symbol one cannot be formatted at all: reading
    // `.error` is what throws (see the deferred-throw test).
    const schema = z.literal(OBJ as never);
    const defValues = (schema as unknown as { _zod: { def: { values: unknown[] } } })._zod.def
      .values;
    const compiled = compileLikeProduction(schema, "objLiteralIssue");

    const result = compiled("nope");
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues[0] as { code?: string; values?: unknown[] };
    expect(issue.code).toBe("invalid_value");
    expect(issue.values, "the schema's own array, by reference").toBe(defValues);

    // …and zod reports exactly that.
    const zodResult = schema.safeParse("nope");
    expect(zodResult.success).toBe(false);
    if (zodResult.success) return;
    expect((zodResult.error.issues[0] as { values?: unknown[] }).values).toBe(defValues);
  });

  it("mixed symbol + string literal keeps both values live", () => {
    const schema = z.literal([SYM, "b"] as never);
    expectRuntimeValuesCompiled(schema);
    const compiled = compileLikeProduction(schema, "symMixedLiteral");

    for (const input of [SYM, "b"]) {
      expect(schema.safeParse(input).success, `zod accepts ${String(input)}`).toBe(true);
      expect(compiled(input).success, `compiled accepts ${String(input)}`).toBe(true);
    }
    // `undefined` used to be accepted here too — the symbol collapsed into it
    // and left `x===undefined||x==="b"`.
    for (const input of [undefined, null, "a", "", 0]) {
      expect(compiled(input).success, `rejects ${String(input)}`).toBe(false);
    }
  });

  it("nested in containers", () => {
    const object = z.object({ kind: z.literal(SYM as never), n: z.number() });
    const compiledObject = compileLikeProduction(object, "symLiteralObject");
    expect(object.safeParse({ kind: SYM, n: 1 }).success).toBe(true);
    expect(compiledObject({ kind: SYM, n: 1 }).success).toBe(true);
    // A MISSING key reads as `undefined`, which the broken comparison accepted —
    // so a required symbol-tagged field was satisfied by omitting it entirely.
    expect(compiledObject({ n: 1 }).success).toBe(false);
    expect(compiledObject({ kind: undefined, n: 1 }).success).toBe(false);
    expect(compiledObject({ kind: OTHER, n: 1 }).success).toBe(false);

    const array = z.array(z.literal(SYM as never));
    const compiledArray = compileLikeProduction(array, "symLiteralArray");
    expect(compiledArray([]).success).toBe(true);
    expect(compiledArray([SYM, SYM]).success).toBe(true);
    expect(compiledArray([SYM, undefined]).success).toBe(false);

    const optional = z.object({ v: z.literal(SYM as never).optional() });
    const compiledOptional = compileLikeProduction(optional, "symLiteralOptional");
    expect(compiledOptional({}).success).toBe(true);
    expect(compiledOptional({ v: SYM }).success).toBe(true);
    expect(compiledOptional({ v: OTHER }).success).toBe(false);
  });

  it("a union arm with a symbol literal does not throw on input another arm accepts", () => {
    const union = z.union([z.literal(SYM as never), z.string()]);

    // The reason a zod FALLBACK is not an option: the literal alone throws on
    // exactly the input the union accepts, because a top-level safeParse
    // formats its issues while a union discards a losing option's unformatted.
    expect(() => z.literal(SYM as never).safeParse("a")).toThrow(TypeError);
    expect(union.safeParse("a").success).toBe(true);

    // Compiled must behave like the union, not like the bare literal.
    expectParity(union, [SYM, "a", ""], "symLiteralUnion");
    const compiled = compileLikeProduction(union, "symLiteralUnionThrow");
    expect(compiled("a").success).toBe(true);
    expect(compiled(SYM).success).toBe(true);
    // …and when the union really does fail, the throw is merely deferred.
    expectDeferredFormatThrow(compiled, union, 1);
  });

  it("defers zod's formatter TypeError to the .error accessor", () => {
    for (const [label, schema, bad] of [
      ["single", z.literal(SYM as never), "nope"],
      ["mixed", z.literal([SYM, "b"] as never), "nope"],
      ["object", z.object({ kind: z.literal(SYM as never) }), { kind: "nope" }],
    ] as [string, z.ZodType, unknown][]) {
      const compiled = compileLikeProduction(schema, `symLiteralDeferred_${label}`);
      expectDeferredFormatThrow(compiled, schema, bad);
    }
  });

  it("an object-valued literal takes the same path, with full issue parity", () => {
    // The guard is on "has a JS source form", not on "is a symbol": an object
    // stringifies to `"{}"`, so the old codegen emitted `x==={}` — never true,
    // so the schema rejected its own value. Zod's formatter handles objects, so
    // this case can be held to FULL parity, issues and messages included.
    const schema = z.literal(OBJ as never);
    expectRuntimeValuesCompiled(schema);
    expectParity(schema, [OBJ, { tag: "identity" }, {}, "nope", undefined, null], "objLiteral");

    const mixed = z.literal([OBJ, "b"] as never);
    expectParity(mixed, [OBJ, "b", { tag: "identity" }, "a", undefined], "objMixedLiteral");
  });

  it("a symbol discriminant never becomes switch dispatch", () => {
    // Auto-discrimination turns a large plain union into an O(1) switch over the
    // shared key's literal values — which needs a `case` LABEL per value, and a
    // symbol has none. `isSwitchableDiscriminant` must keep refusing it so the
    // union falls back to the `||`-chain, where each option's own literal check
    // reads the value list off the retained schema.
    const union = z.union([
      z.object({ k: z.literal(SYM as never), a: z.string() }),
      z.object({ k: z.literal("b"), a: z.string() }),
      z.object({ k: z.literal("c"), a: z.string() }),
      z.object({ k: z.literal("d"), a: z.string() }),
      z.object({ k: z.literal("e"), a: z.string() }),
    ]);
    expectParity(
      union,
      [
        { k: SYM, a: "x" },
        { k: "b", a: "x" },
        { k: "e", a: "x" },
      ],
      "symDiscriminant",
    );
  });

  it("a symbol-keyed record still delegates to zod", () => {
    // Compiled records walk their input with `for-in`, which yields string keys
    // only, so a symbol-valued key literal could never match — while zod's own
    // record enumerates differently. `isStringShapedKey` must keep refusing it.
    const refs: RefEntry[] = [];
    const ir = extractSchema(z.partialRecord(z.literal(SYM as never), z.string()), refs);
    expect(ir.type, "symbol-keyed record must not compile").toBe("fallback");
  });
});
