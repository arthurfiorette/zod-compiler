import { bench, describe } from "vite-plus/test";
import {
  aotCapturedRefine,
  aotCapturedRefineObject,
  aotCapturedTransform,
  aotCapturedTransformObject,
  aotCoercedQuery,
  aotStringBoolConfig,
  aotSuperRefineObject,
  aotZeroCaptureRefineObject,
  aotZeroCaptureRefineString,
  aotZeroCaptureTransformObject,
  aotZeroCaptureTransformString,
  CapturedRefineObjectSchema,
  CapturedRefineSchema,
  CapturedTransformObjectSchema,
  CapturedTransformSchema,
  CoercedQuerySchema,
  StringBoolConfigSchema,
  SuperRefineObjectSchema,
  ZeroCaptureRefineObjectSchema,
  ZeroCaptureRefineStringSchema,
  ZeroCaptureTransformObjectSchema,
  ZeroCaptureTransformStringSchema,
  v3CapturedRefineObjectSchema,
  v3CapturedRefineSchema,
  v3CapturedTransformObjectSchema,
  v3CapturedTransformSchema,
  v3CoercedQuerySchema,
  v3SuperRefineObjectSchema,
  v3ZeroCaptureRefineObjectSchema,
  v3ZeroCaptureRefineStringSchema,
  v3ZeroCaptureTransformObjectSchema,
  v3ZeroCaptureTransformStringSchema,
  invalidCoercedQuery,
  invalidStringBoolConfig,
  validCapturedRefineObject,
  validCapturedRefineString,
  validCapturedTransformObject,
  validCapturedTransformString,
  validCoercedQuery,
  validStringBoolConfig,
  validRefineObject,
  validRefineString,
  validSuperRefineObject,
  validTransformObject,
  validTransformString,
} from "../../fixtures/schemas/index.js";

// ─── Native coercions (single-pass build path) ─────────────────────────────
// ajv/typia excluded: coercion is a Zod-specific feature.

describe("safeParse: coerced query object — valid", () => {
  bench("zod", () => {
    CoercedQuerySchema.safeParse(validCoercedQuery);
  });
  bench("zod v3", () => {
    v3CoercedQuerySchema.safeParse(validCoercedQuery);
  });
  bench("zod-compiler", () => {
    aotCoercedQuery.safeParse(validCoercedQuery);
  });
});

describe("safeParse: coerced query object — invalid", () => {
  bench("zod", () => {
    CoercedQuerySchema.safeParse(invalidCoercedQuery);
  });
  bench("zod v3", () => {
    v3CoercedQuerySchema.safeParse(invalidCoercedQuery);
  });
  bench("zod-compiler", () => {
    aotCoercedQuery.safeParse(invalidCoercedQuery);
  });
});

// ─── Environment/query boolean flags (single-pass build path) ─────────────
// Zod v3 / ajv / typia excluded: stringbool is a Zod v4 codec.

describe("safeParse: stringbool config object — valid", () => {
  bench("zod", () => {
    StringBoolConfigSchema.safeParse(validStringBoolConfig);
  });
  bench("zod-compiler", () => {
    aotStringBoolConfig.safeParse(validStringBoolConfig);
  });
});

describe("safeParse: stringbool config object — invalid", () => {
  bench("zod", () => {
    StringBoolConfigSchema.safeParse(invalidStringBoolConfig);
  });
  bench("zod-compiler", () => {
    aotStringBoolConfig.safeParse(invalidStringBoolConfig);
  });
});

// ─── Zero-capture transforms (fully optimized at build time) ────────────────
// ajv/typia excluded: transform() is a Zod-specific feature.

describe("safeParse: zero-capture transform — string", () => {
  bench("zod", () => {
    ZeroCaptureTransformStringSchema.safeParse(validTransformString);
  });
  bench("zod v3", () => {
    v3ZeroCaptureTransformStringSchema.safeParse(validTransformString);
  });
  bench("zod-compiler", () => {
    aotZeroCaptureTransformString.safeParse(validTransformString);
  });
});

describe("safeParse: zero-capture transform — object", () => {
  bench("zod", () => {
    ZeroCaptureTransformObjectSchema.safeParse(validTransformObject);
  });
  bench("zod v3", () => {
    v3ZeroCaptureTransformObjectSchema.safeParse(validTransformObject);
  });
  bench("zod-compiler", () => {
    aotZeroCaptureTransformObject.safeParse(validTransformObject);
  });
});

// ─── Zero-capture refines (inlined at build time) ──────────────────────────

describe("safeParse: zero-capture refine — string", () => {
  bench("zod", () => {
    ZeroCaptureRefineStringSchema.safeParse(validRefineString);
  });
  bench("zod v3", () => {
    v3ZeroCaptureRefineStringSchema.safeParse(validRefineString);
  });
  bench("zod-compiler", () => {
    aotZeroCaptureRefineString.safeParse(validRefineString);
  });
});

describe("safeParse: zero-capture refine — object", () => {
  bench("zod", () => {
    ZeroCaptureRefineObjectSchema.safeParse(validRefineObject);
  });
  bench("zod v3", () => {
    v3ZeroCaptureRefineObjectSchema.safeParse(validRefineObject);
  });
  bench("zod-compiler", () => {
    aotZeroCaptureRefineObject.safeParse(validRefineObject);
  });
});

// ─── Captured-variable effects (Zod fallback) ──────────────────────────────

describe("safeParse: captured transform — string", () => {
  bench("zod", () => {
    CapturedTransformSchema.safeParse(validCapturedTransformString);
  });
  bench("zod v3", () => {
    v3CapturedTransformSchema.safeParse(validCapturedTransformString);
  });
  bench("zod-compiler", () => {
    aotCapturedTransform.safeParse(validCapturedTransformString);
  });
});

describe("safeParse: captured transform — object", () => {
  bench("zod", () => {
    CapturedTransformObjectSchema.safeParse(validCapturedTransformObject);
  });
  bench("zod v3", () => {
    v3CapturedTransformObjectSchema.safeParse(validCapturedTransformObject);
  });
  bench("zod-compiler", () => {
    aotCapturedTransformObject.safeParse(validCapturedTransformObject);
  });
});

describe("safeParse: captured refine — string", () => {
  bench("zod", () => {
    CapturedRefineSchema.safeParse(validCapturedRefineString);
  });
  bench("zod v3", () => {
    v3CapturedRefineSchema.safeParse(validCapturedRefineString);
  });
  bench("zod-compiler", () => {
    aotCapturedRefine.safeParse(validCapturedRefineString);
  });
});

// Cross-field validation: a captured predicate on the ROOT object. Until the
// predicate could be called by reference this cost the WHOLE object its
// compiled path — the schema, not the callback, is what this row measures.
describe("safeParse: captured refine — object (cross-field)", () => {
  bench("zod", () => {
    CapturedRefineObjectSchema.safeParse(validCapturedRefineObject);
  });
  bench("zod v3", () => {
    v3CapturedRefineObjectSchema.safeParse(validCapturedRefineObject);
  });
  bench("zod-compiler", () => {
    aotCapturedRefineObject.safeParse(validCapturedRefineObject);
  });
});

// The same cross-field validation as the row above, written with superRefine.
// Its callback takes zod's payload rather than returning a verdict, so before
// it could be called by reference the whole object delegated to zod.
describe("safeParse: superRefine — object (cross-field)", () => {
  bench("zod", () => {
    SuperRefineObjectSchema.safeParse(validSuperRefineObject);
  });
  bench("zod v3", () => {
    v3SuperRefineObjectSchema.safeParse(validSuperRefineObject);
  });
  bench("zod-compiler", () => {
    aotSuperRefineObject.safeParse(validSuperRefineObject);
  });
});
