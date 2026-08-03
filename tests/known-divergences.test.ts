/**
 * Known divergences from Zod — intentional tradeoffs the compiler does NOT
 * close, all rooted in its zero-allocation design: a schema that reshapes
 * nothing returns the validated input BY REFERENCE on success (see
 * generateValidator's `return{success:true,data:input}` path) and iterates
 * objects/records with an allocation-free `for-in`. Matching Zod here would
 * mean allocating a fresh output on every successful parse — the exact cost the
 * compiler exists to avoid.
 *
 * `z.object()` is NOT among these: it strips unknown keys like Zod, rebuilding
 * its output in one validate-and-build pass (see build-path.ts). What remains
 * below are containers Zod rebuilds and the compiler still passes through.
 *
 * Each gap is pinned with an explicit dual assertion (Zod's behavior AND the
 * compiler's) so the suite stays green and documents reality. If a future
 * change closes a gap, the compiler-side assertion breaks — a prompt to delete
 * the pin and promote it to a parity regression in edge-cases.test.ts.
 *
 * NOTE: these are distinct from bugs that were found and fixed (collection
 * element-vs-size issue ordering, duplicate discriminator throw) — those now
 * live as parity regressions in edge-cases.test.ts.
 */
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { compileLikeProduction } from "./parity-harness.js";

/**
 * 1. ARRAY OUTPUT IDENTITY.
 *
 * Zod builds a fresh array from the validated elements (dense, no extra own
 * properties). The compiler returns the input array by reference when the
 * element type doesn't mutate (src/core/codegen/schemas/array.ts), so a sparse
 * array keeps its holes and any non-index own properties survive.
 */
describe("known divergence — array output keeps sparseness / extra properties", () => {
  it("compiled array output is the input by reference", () => {
    const schema = z.array(z.string());
    const input = ["a", "b"] as string[] & { meta?: number };
    input.meta = 7;
    const compiled = compileLikeProduction(schema, "arrId");
    const r = compiled(input) as { success: true; data: string[] & { meta?: number } };
    const zr = schema.safeParse(input) as { success: true; data: string[] & { meta?: number } };
    expect(zr.data.meta).toBeUndefined(); // Zod drops the non-index property
    expect(r.data.meta).toBe(7); // compiler retains it (same reference)
    expect(r.data).toBe(input);
  });
});

/**
 * 2. RECORD KEY ITERATION — for-in vs Reflect.ownKeys.
 *
 * The compiler iterates records with an allocation-free `for-in` (own
 * ENUMERABLE STRING keys), while Zod walks `Reflect.ownKeys` — every own key,
 * including non-enumerable string keys AND symbol keys. So the compiler ignores
 * keys Zod validates (and, for string-shaped key schemas, rejects): symbol keys
 * are silently accepted, and a non-enumerable string key is skipped entirely.
 * Closing this means replacing for-in with a Reflect.ownKeys keys-array
 * allocation on every record parse — the cost for-in deliberately avoids (the
 * code notes for-in is 2.9–5.8x faster than the Object.keys form).
 */
describe("known divergence — record iterates own enumerable string keys only", () => {
  it("symbol key is rejected by Zod but ignored by the compiler", () => {
    const schema = z.record(z.string(), z.number());
    const sym = Symbol("s");
    const input = { a: 1, [sym]: 2 } as Record<string | symbol, unknown>;
    const compiled = compileLikeProduction(schema, "symKey");
    expect(schema.safeParse(input).success).toBe(false); // Zod validates the symbol key
    expect((compiled(input) as { success: boolean }).success).toBe(true); // compiler ignores it
  });
  it("non-enumerable string key is validated by Zod but ignored by the compiler", () => {
    const schema = z.record(z.string(), z.number());
    const input = { a: 1 } as Record<string, unknown>;
    Object.defineProperty(input, "hidden", { value: "not-a-number", enumerable: false });
    const compiled = compileLikeProduction(schema, "nonEnum");
    expect(schema.safeParse(input).success).toBe(false); // Zod sees `hidden` and rejects its value
    expect((compiled(input) as { success: boolean }).success).toBe(true); // for-in never visits it
  });
});

describe("known divergence — a catchall validates inherited keys but cannot re-home them", () => {
  // zod's handleCatchall iterates the input with a BARE for-in, so a key found
  // on the prototype is validated — the compiler matches that exactly. What it
  // cannot match is the output: zod parses into a fresh `{}` and writes every
  // for-in key onto it, turning an inherited key into an OWN key, while
  // compiled output is the input by reference and leaves it on the prototype.
  const schema = z.object({ a: z.number() }).catchall(z.string());
  const withInherited = () => Object.assign(Object.create({ inh: "yes" }), { a: 1 });

  it("agrees on the verdict, including rejecting a bad inherited value", () => {
    const compiled = compileLikeProduction(schema, "caInhVerdict");
    const bad = Object.assign(Object.create({ inh: 99 }), { a: 1 });
    expect(schema.safeParse(withInherited()).success).toBe(true);
    expect((compiled(withInherited()) as { success: boolean }).success).toBe(true);
    expect(schema.safeParse(bad).success).toBe(false);
    expect((compiled(bad) as { success: boolean }).success).toBe(false);
  });

  it("zod promotes the inherited key to an own key; the compiler does not", () => {
    const compiled = compileLikeProduction(schema, "caInhOutput");
    const zodData = schema.safeParse(withInherited()).data as Record<string, unknown>;
    const ourData = (compiled(withInherited()) as { data: Record<string, unknown> }).data;
    expect(Object.hasOwn(zodData, "inh")).toBe(true);
    expect(Object.hasOwn(ourData, "inh")).toBe(false);
    // Still readable through the chain, so property access agrees.
    expect(ourData["inh"]).toBe("yes");
  });
});
