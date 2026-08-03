import { z } from "zod3";

// ─── Zero-capture transform (fully compiled by zod-compiler) ────────────────────

export const v3ZeroCaptureTransformStringSchema = z
  .string()
  .transform((v) => v.trim().toLowerCase());

export const v3ZeroCaptureTransformObjectSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().transform((v) => v.toLowerCase().replace(/\s+/g, "-")),
  score: z.number().transform((v) => Math.round(v * 100) / 100),
});

// ─── Zero-capture refine (inlined as check by zod-compiler) ─────────────────────

export const v3ZeroCaptureRefineStringSchema = z
  .string()
  .refine((v) => v.length > 0 && v.length < 256, {
    message: "Must be 1-255 characters",
  });

export const v3ZeroCaptureRefineObjectSchema = z.object({
  email: z.string().refine((v) => v.includes("@") && v.includes("."), {
    message: "Must contain @ and .",
  }),
  age: z.number().refine((v) => v >= 0 && v <= 150, {
    message: "Must be 0-150",
  }),
});

// ─── Coerced request/query payload ─────────────────────────────────────────

export const v3CoercedQuerySchema = z.object({
  page: z.coerce.number().int().positive(),
  pageSize: z.coerce.number().int().min(1).max(100),
  minPrice: z.coerce.number().nonnegative(),
  maxPrice: z.coerce.number().positive(),
  includeArchived: z.coerce.boolean(),
  since: z.coerce.date(),
});

// ─── Captured-variable transform (Zod fallback) ────────────────────────────

const prefix = "usr_";
export const v3CapturedTransformSchema = z.string().transform((v) => prefix + v.toLowerCase());

const multiplier = 2.5;
export const v3CapturedTransformObjectSchema = z.object({
  label: z.string().transform((v) => prefix + v),
  value: z.number().transform((v) => v * multiplier),
});

// ─── Captured-variable refine (Zod fallback) ───────────────────────────────

const allowedDomains = ["example.com", "test.com"];
export const v3CapturedRefineSchema = z
  .string()
  .refine((v) => allowedDomains.some((d) => v.endsWith(d)), {
    message: "Invalid domain",
  });

// ─── Captured-variable refine on the ROOT object (cross-field validation) ───

const minAge = 18;
export const v3CapturedRefineObjectSchema = z
  .object({
    age: z.number().int(),
    confirm: z.string().min(8),
    email: z.string().min(3),
    id: z.string(),
    name: z.string().min(1),
    password: z.string().min(8),
  })
  .refine((v) => v.age >= minAge, { message: "Too young" });

export const v3SuperRefineObjectSchema = z
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
