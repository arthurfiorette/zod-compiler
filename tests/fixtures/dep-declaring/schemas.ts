import { z } from "zod";
import { MIN_HANDLE } from "./limits.js";

export const AccountSchema = z.object({
  handle: z.string().min(MIN_HANDLE),
  email: z.email(),
});
