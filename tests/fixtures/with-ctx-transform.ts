import { z } from "zod";
import { compile } from "zod-compiler";

// A transform taking zod's ctx genuinely delegates: it collects issues through
// the parse payload rather than returning a value, so there is no call the
// generated code can make. Captured (single-argument) transforms compile by
// reference, so they no longer serve as a "has a fallback" fixture.
const CtxTransformSchema = z.object({
  name: z.string(),
  value: z.string().transform((v, ctx) => {
    if (v === "") ctx.addIssue({ code: "custom", message: "empty" });
    return v.length;
  }),
});

export const validateCtxTransform = compile(CtxTransformSchema);
