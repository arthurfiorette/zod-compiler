"use server";

import { z } from "zod";

export async function createTask(input: unknown) {
  const Schema = z.object({ id: z.string().min(1), done: z.boolean() });
  return Schema.safeParse(input);
}
