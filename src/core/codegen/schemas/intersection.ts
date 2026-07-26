import type { IntersectionIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { orderByRuntimeCost } from "../fast-size.js";

export function slowIntersection(ir: SchemaIR & { type: "intersection" }, g: SlowGen): string {
  return `${g.visit(ir.left)}${g.visit(ir.right, { input: g.output, output: g.output })}`;
}

export function fastIntersection(ir: IntersectionIR, g: FastGen): string | null {
  // Both sides must hold, so the conjunction is order-independent — emit the
  // cheaper side first so a reject decides on it (see estimateRuntimeCost).
  const [first, second] = orderByRuntimeCost([ir.left, ir.right], (side) => side, g.ctx) as [
    SchemaIR,
    SchemaIR,
  ];
  const left = g.visit(first);
  if (left === null) return null;
  const right = g.visit(second);
  if (right === null) return null;
  return left === "true" ? right : right === "true" ? left : `${left}&&${right}`;
}
