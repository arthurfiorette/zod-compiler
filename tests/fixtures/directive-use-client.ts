"use client";

import { z } from "zod";

export const SignupSchema = z.object({
  handle: z.string().min(2),
  email: z.email(),
});
