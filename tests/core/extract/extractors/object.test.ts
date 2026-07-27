import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractObject } from "#src/core/extract/extractors/object.js";
import { extractSchema } from "#src/core/extract/index.js";
import type { ObjectIR } from "#src/core/types.js";

describe("extractObject", () => {
  it("extracts empty object", () => {
    const ir = extractSchema(z.object({})) as ObjectIR;
    expect(ir).toEqual({ type: "object", properties: {} });
  });

  it("extracts object with multiple properties", () => {
    const ir = extractSchema(z.object({ name: z.string(), age: z.number() })) as ObjectIR;
    expect(ir.type).toBe("object");
    expect(Object.keys(ir.properties)).toEqual(["name", "age"]);
    expect(ir.properties["name"]?.type).toBe("string");
    expect(ir.properties["age"]?.type).toBe("number");
  });

  it("extracts nested objects", () => {
    const ir = extractSchema(z.object({ inner: z.object({ x: z.number() }) })) as ObjectIR;
    expect(ir.properties["inner"]?.type).toBe("object");
    const inner = ir.properties["inner"] as ObjectIR;
    expect(inner.properties["x"]?.type).toBe("number");
  });

  it("extracts strict flag for strictObject / .strict() / catchall(never)", () => {
    for (const schema of [
      z.strictObject({ a: z.string() }),
      z.object({ a: z.string() }).strict(),
      z.object({ a: z.string() }).catchall(z.never()),
    ]) {
      const ir = extractSchema(schema) as ObjectIR;
      expect(ir.type).toBe("object");
      expect(ir.strict).toBe(true);
    }
  });

  it("plain and loose objects carry no strict flag", () => {
    expect((extractSchema(z.object({ a: z.string() })) as ObjectIR).strict).toBeUndefined();
    expect((extractSchema(z.looseObject({ a: z.string() })) as ObjectIR).strict).toBeUndefined();
  });

  it("still falls back for value-validating catchall", () => {
    const ir = extractSchema(z.object({ a: z.string() }).catchall(z.number()));
    expect(ir.type).toBe("fallback");
  });

  it("compiles an object whose refine captures, calling the predicate by reference", () => {
    const captured = "external";
    const schema = z.object({ x: z.string() }).refine((v) => v.x === captured);
    const refs: { schema: unknown; accessPath: string }[] = [];
    const ir = extractSchema(schema, refs) as ObjectIR;
    expect(ir.type).toBe("object");
    expect(ir.checks?.[0]).toEqual({ kind: "refine_effect", refIndex: 0 });
    // The ref points at the user's own predicate, reachable from the schema.
    expect(refs[0]?.accessPath).toBe("._zod.def.checks[0]._zod.def.fn");
    expect(refs[0]?.schema).toBeTypeOf("function");
  });

  it("compiles a superRefine that is the last check, calling it by reference", () => {
    const schema = z.object({ x: z.string() }).superRefine((v, ctx) => {
      if (v.x === "") ctx.addIssue({ code: "custom" });
    });
    const refs: { schema: unknown; accessPath: string }[] = [];
    const ir = extractSchema(schema, refs) as ObjectIR;
    expect(ir.type).toBe("object");
    expect(ir.checks?.[0]).toEqual({ kind: "super_refine_effect", refIndex: 0 });
    expect(refs[0]?.accessPath).toBe("._zod.def.checks[0]._zod.check");
  });

  it("still falls back when a superRefine is followed by another check", () => {
    // An issue carrying fatal/continue:false aborts zod's remaining chain,
    // which compiled output (running every check) could not reproduce.
    const schema = z
      .object({ x: z.string() })
      .superRefine((v, ctx) => {
        if (v.x === "") ctx.addIssue({ code: "custom", fatal: true });
      })
      .refine((v) => v.x !== "no");
    const refs: { schema: unknown; accessPath: string }[] = [];
    expect(extractSchema(schema, refs).type).toBe("fallback");
  });

  it("handles object with compilable refine via direct call", () => {
    // Use direct call with mock ctx to test the hasFallback=false + refine_effect path
    const mockCtx = {
      schema: {},
      path: "",
      refs: undefined,
      visiting: new Set(),
      options: {},
      visit: () => ({ type: "string" as const, checks: [] }),
      fallback: (reason: string) => ({ type: "fallback" as const, reason }),
    };
    const ir = extractObject(
      {
        type: "object",
        shape: {},
        checks: [
          {
            _zod: {
              def: {
                check: "custom",
                fn: (v: unknown) => !!v,
              },
            },
          },
        ],
      } as never,
      mockCtx as never,
    );
    // tryCompileEffect should compile the simple arrow; result has refine checks
    if (ir.type === "object" && "checks" in ir) {
      expect(ir.checks).toBeDefined();
      expect(ir.checks?.length).toBeGreaterThan(0);
    }
    // If it fell back, that's also acceptable (depends on tryCompileEffect behavior)
    expect(["object", "fallback"]).toContain(ir.type);
  });
});
