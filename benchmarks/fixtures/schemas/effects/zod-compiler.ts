import { compile } from "zod-compiler";
import {
  // compile() is identity-preserving: it installs the compiled methods on the
  // schema instance it receives. Clone so the plain-zod baseline rows keep
  // measuring pristine zod instead of the compiled validator.
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
} from "./zod.js";

export const aotZeroCaptureTransformString = compile(ZeroCaptureTransformStringSchema.clone());
export const aotZeroCaptureTransformObject = compile(ZeroCaptureTransformObjectSchema.clone());
export const aotZeroCaptureRefineString = compile(ZeroCaptureRefineStringSchema.clone());
export const aotZeroCaptureRefineObject = compile(ZeroCaptureRefineObjectSchema.clone());
export const aotCapturedTransform = compile(CapturedTransformSchema.clone());
export const aotCapturedTransformObject = compile(CapturedTransformObjectSchema.clone());
export const aotCapturedRefine = compile(CapturedRefineSchema.clone());
export const aotCapturedRefineObject = compile(CapturedRefineObjectSchema.clone());
export const aotSuperRefineObject = compile(SuperRefineObjectSchema.clone());
export const aotCoercedQuery = compile(CoercedQuerySchema.clone());
export const aotStringBoolConfig = compile(StringBoolConfigSchema.clone());
