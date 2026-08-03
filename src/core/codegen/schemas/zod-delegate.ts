import type { SchemaIR, ZodDelegateIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { slowZodDelegate } from "./fallback.js";

/** The retained schema is irrelevant on success; compile the equivalent inner. */
export function fastZodDelegate(ir: ZodDelegateIR, g: FastGen): string | null {
  return g.visit(ir.inner);
}

/** Let the pristine Zod schema produce byte-exact issues on the cold path. */
export function slowCompiledZodDelegate(
  ir: SchemaIR & { type: "zodDelegate" },
  g: SlowGen,
): string {
  return slowZodDelegate(ir.refIndex, g);
}
