import type { ReadonlyIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";

export function slowReadonly(ir: SchemaIR & { type: "readonly" }, g: SlowGen): string {
  // Pass-through wrapper: forward the union abort flag (see slowOptional).
  const inner = g.visit(ir.inner, { aborted: g.aborted });
  if (ir.freeze !== true) return inner;
  // Guarded because the walk only reassigns `output` to its rebuilt object once
  // the type check passed — a failed one leaves the CALLER's input sitting
  // there, and freezing that is the side effect zod avoids.
  //
  // The mark is RELATIVE to the issues already collected, never against zero: a
  // `.catch()` above lets the parse succeed with a sibling's issues still in the
  // array, and an absolute test would silently skip the freeze there while zod
  // still applied it. Same relative-mark discipline as slowObject's refineMark,
  // slowPipe's lenVar and slowEffect's beforeVar.
  const mark = g.temp("rf");
  return `var ${mark}=${g.issues}.length;\n${inner}if(${g.issues}.length===${mark}){${g.output}=Object.freeze(${g.output});}\n`;
}

export function fastReadonly(ir: ReadonlyIR, g: FastGen): string | null {
  return g.visit(ir.inner);
}
