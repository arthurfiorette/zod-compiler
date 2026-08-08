import { compile } from "zod-compiler";
import {
  // compile() is identity-preserving: it installs the compiled methods on the
  // schema instance it receives. Clone so the plain-zod baseline rows keep
  // measuring pristine zod instead of the compiled validator.
  ReadonlyArraySchema,
  ReadonlyFieldSchema,
  ReadonlyRootSchema,
} from "./zod.js";

export const aotReadonlyField = compile(ReadonlyFieldSchema.clone());
export const aotReadonlyRoot = compile(ReadonlyRootSchema.clone());
export const aotReadonlyArray = compile(ReadonlyArraySchema.clone());
