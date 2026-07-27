import { z } from "zod";

// ─── Zero-capture transform (fully compiled by zod-compiler) ────────────────────

export const ZeroCaptureTransformStringSchema = z.string().transform((v) => v.trim().toLowerCase());

export const ZeroCaptureTransformObjectSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().transform((v) => v.toLowerCase().replace(/\s+/g, "-")),
  score: z.number().transform((v) => Math.round(v * 100) / 100),
});

// ─── Zero-capture refine (inlined as check by zod-compiler) ─────────────────────

export const ZeroCaptureRefineStringSchema = z
  .string()
  .refine((v) => v.length > 0 && v.length < 256, {
    message: "Must be 1-255 characters",
  });

export const ZeroCaptureRefineObjectSchema = z.object({
  email: z.string().refine((v) => v.includes("@") && v.includes("."), {
    message: "Must contain @ and .",
  }),
  age: z.number().refine((v) => v >= 0 && v <= 150, {
    message: "Must be 0-150",
  }),
});

// ─── Captured-variable transform (Zod fallback) ────────────────────────────

const prefix = "usr_";
export const CapturedTransformSchema = z.string().transform((v) => prefix + v.toLowerCase());

const multiplier = 2.5;
export const CapturedTransformObjectSchema = z.object({
  label: z.string().transform((v) => prefix + v),
  value: z.number().transform((v) => v * multiplier),
});

// ─── Captured-variable refine (Zod fallback) ───────────────────────────────

const allowedDomains = ["example.com", "test.com"];
export const CapturedRefineSchema = z
  .string()
  .refine((v) => allowedDomains.some((d) => v.endsWith(d)), {
    message: "Invalid domain",
  });

// ─── Captured-variable refine on the ROOT object (cross-field validation) ───
// The classic password-confirmation / range check. The predicate is deliberately
// cheap so the row measures the SCHEMA's cost, not the callback's: a captured
// refine used to cost the whole object its compiled path.

const minAge = 18;
export const CapturedRefineObjectSchema = z
  .object({
    age: z.number().int(),
    confirm: z.string().min(8),
    email: z.string().min(3),
    id: z.string(),
    name: z.string().min(1),
    password: z.string().min(8),
  })
  .refine((v) => v.age >= minAge, { message: "Too young" });

// Cross-field validation written with superRefine — the same shape and work as
// CapturedRefineObjectSchema, but through zod's issue-collection protocol,
// which used to cost the whole object its compiled path.
export const SuperRefineObjectSchema = z
  .object({
    age: z.number().int(),
    confirm: z.string().min(8),
    email: z.string().min(3),
    id: z.string(),
    name: z.string().min(1),
    password: z.string().min(8),
  })
  .superRefine((v, ctx) => {
    if (v.password !== v.confirm) {
      ctx.addIssue({ code: "custom", message: "Passwords must match", path: ["confirm"] });
    }
    if (v.age < minAge) ctx.addIssue({ code: "custom", message: "Too young", path: ["age"] });
  });
