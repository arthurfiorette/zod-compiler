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
import { expectParity } from "./parity-harness.js";

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
