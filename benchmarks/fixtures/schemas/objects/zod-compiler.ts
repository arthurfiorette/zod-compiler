import { compile } from "zod-compiler";
import { ApiResponseSchema, StrictRowSchema, UserIntersectionSchema, UserSchema } from "./zod.js";
// compile() is identity-preserving: it installs the compiled methods on the
// schema instance it receives. Clone so the plain-zod baseline rows keep
// measuring pristine zod instead of the compiled validator.

export const aotUser = compile(UserSchema.clone());
export const aotUserIntersection = compile(UserIntersectionSchema.clone());
export const aotApiResponse = compile(ApiResponseSchema.clone());
export const aotStrictRow = compile(StrictRowSchema.clone());
