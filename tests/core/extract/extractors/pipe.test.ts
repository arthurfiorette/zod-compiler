import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import type { RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import type {
  FallbackIR,
  PipeIR,
  PreprocessEffectIR,
  StringIR,
  TransformEffectIR,
} from "#src/core/types.js";

describe("extractSchema — pipe", () => {
  it("extracts string-to-string pipe with checks", () => {
    const schema = z.string().pipe(z.string().min(3));
    const ir = extractSchema(schema) as PipeIR;
    expect(ir.type).toBe("pipe");
    expect(ir.in.type).toBe("string");
    expect(ir.out.type).toBe("string");
    expect((ir.out as StringIR).checks).toContainEqual({ kind: "min_length", minimum: 3 });
  });

  it("extracts number-to-number pipe with range checks", () => {
    const schema = z.number().pipe(z.number().min(0).max(100));
    const ir = extractSchema(schema) as PipeIR;
    expect(ir.type).toBe("pipe");
    expect(ir.in.type).toBe("number");
    expect(ir.out.type).toBe("number");
  });

  it("extracts pipe with checked input schema", () => {
    const schema = z.string().min(1).pipe(z.string().max(50));
    const ir = extractSchema(schema) as PipeIR;
    expect(ir.type).toBe("pipe");
    expect(ir.in.type).toBe("string");
    expect(ir.out.type).toBe("string");
    expect((ir.in as StringIR).checks).toContainEqual({ kind: "min_length", minimum: 1 });
    expect((ir.out as StringIR).checks).toContainEqual({ kind: "max_length", maximum: 50 });
  });

  it("compiles zero-capture transform in pipe output as EffectIR", () => {
    const schema = z.string().pipe(z.string().transform((v) => v.toUpperCase()));
    // Outer pipe wraps inner transform (which becomes EffectIR)
    const ir = extractSchema(schema) as PipeIR;
    expect(ir.type).toBe("pipe");
    expect(ir.in.type).toBe("string");
    const effectIR = ir.out as TransformEffectIR;
    expect(effectIR.type).toBe("effect");
    expect(effectIR.effectKind).toBe("transform");
    expect(effectIR.source).toContain("toUpperCase");
  });

  it("falls back when pipe output has captured-variable transform", () => {
    const suffix = "_suffix";
    const schema = z.string().pipe(z.string().transform((v) => v + suffix));
    // Outer pipe wraps inner transform (which falls back due to capture)
    const ir = extractSchema(schema) as PipeIR;
    expect(ir.type).toBe("pipe");
    expect(ir.out.type).toBe("fallback");
    expect((ir.out as FallbackIR).reason).toBe("transform");
  });

  it("does not produce fallback entries for non-transform pipe", () => {
    const refs: RefEntry[] = [];
    const schema = z.string().pipe(z.string().min(3));
    extractSchema(schema, refs);
    expect(refs).toHaveLength(0);
  });

  it("does not produce fallback entries for zero-capture transform in pipe", () => {
    const refs: RefEntry[] = [];
    const schema = z.string().pipe(z.string().transform((v) => v.toUpperCase()));
    extractSchema(schema, refs);
    expect(refs).toHaveLength(0);
  });

  it("produces fallback entry for captured-variable transform in pipe", () => {
    const refs: RefEntry[] = [];
    const suffix = "_suffix";
    const schema = z.string().pipe(z.string().transform((v) => v + suffix));
    extractSchema(schema, refs);
    expect(refs).toHaveLength(1);
  });

  it("extracts a zero-capture preprocessor before its output schema", () => {
    const ir = extractSchema(
      z.preprocess((value) => Number(value), z.number().int().positive()),
    ) as PreprocessEffectIR;
    expect(ir.type).toBe("effect");
    expect(ir.effectKind).toBe("preprocess");
    expect(ir.source).toContain("Number");
    expect(ir.inner.type).toBe("number");
  });

  it("retains a capturing preprocessor by reference", () => {
    const radix = 16;
    const refs: RefEntry[] = [];
    const ir = extractSchema(
      z.preprocess((value) => parseInt(String(value), radix), z.number()),
      refs,
    ) as PreprocessEffectIR;
    expect(ir.type).toBe("effect");
    expect(ir.effectKind).toBe("preprocess");
    expect(ir.refIndex).toBe(0);
    expect(refs).toHaveLength(1);
  });

  it("keeps context-observing preprocessors on Zod", () => {
    const callbackWithDefaultContext = (value: unknown, ctx: unknown = null) =>
      ctx ? value : "missing";
    const withDefaultContext = z.preprocess(callbackWithDefaultContext, z.string());
    const withRest = z.preprocess(
      (value, ...context) => (context.length ? value : "missing"),
      z.string(),
    );
    for (const schema of [withDefaultContext, withRest]) {
      const refs: RefEntry[] = [];
      const ir = extractSchema(schema, refs) as PipeIR;
      expect(ir.type).toBe("pipe");
      expect(ir.in.type).toBe("fallback");
      expect(refs).toHaveLength(1);
    }
  });
});
