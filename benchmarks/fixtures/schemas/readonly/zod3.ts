import { z } from "zod3";

// zod v3 mirrors of ./zod.ts. v3's `.readonly()` matches v4's observable
// behaviour — it strips, freezes its rebuilt output, and leaves the caller's
// input alone — so the rows compare like for like.
export const v3ReadonlyFieldSchema = z.object({
  foo: z.string().readonly(),
  bar: z.array(z.number().int()),
});

export const v3ReadonlyRootSchema = z
  .object({
    foo: z.string(),
    bar: z.array(z.number().int()),
  })
  .readonly();

export const v3ReadonlyArraySchema = z.array(z.number().int()).readonly();
