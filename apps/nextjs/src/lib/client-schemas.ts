// "use client" is a directive only while it is the FIRST statement. The
// generated runtime prologue must therefore land below it — injecting at
// offset 0 demotes it to a plain string expression and Next.js fails the build
// with `The "use client" directive must be placed before other expressions`.
// This file is the e2e guard for that (see moduleHeadOffset in unplugin/edits).
//
// Plain .ts, not .tsx: JSX files hit a jiti parse error in autoDiscover mode,
// so a schema in one is never compiled and would guard nothing.
"use client";

import { z } from "zod";

export const SignupSchema = z.object({
  handle: z.string().min(2).max(30),
  email: z.email(),
  acceptedTerms: z.boolean(),
});
