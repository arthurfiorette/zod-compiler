import { z } from "zod";

// The env-validation-guard pattern: a hard exit when secrets are absent. What
// discovery can compile here is a function of the ENVIRONMENT, not of this
// file's content, so the result must never be cached against that content.
process.exit(1);

export const GuardedSchema = z.object({ token: z.string().min(1) });
