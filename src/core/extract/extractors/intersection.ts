import { hasMutation } from "../../codegen/context.js";
import type { ObjectIR, SchemaIR } from "../../types.js";
import type { Extractor } from "../types.js";

export const extractIntersection: Extractor = (def, ctx) => {
  const left = ctx.visit(def.left, "._zod.def.left");
  const right = ctx.visit(def.right, "._zod.def.right");

  // The everyday `.and()` case: two default z.object() shapes with disjoint
  // keys. Zod parses each against the original input, strips each side to its
  // own keys, then merges the two outputs. A single object over the union of
  // those keys has identical acceptance and output semantics. The pristine
  // intersection remains the source of truth for cold-path issues (notably, a
  // non-object input produces one issue per side).
  const merged = mergeDisjointStripObjects(left, right);
  if (merged !== null && ctx.refs) {
    const refIndex = ctx.refs.length;
    ctx.refs.push({ schema: ctx.schema, accessPath: ctx.path });
    return { type: "zodDelegate", inner: merged, refIndex };
  }

  // Zod validates both sides on the ORIGINAL input and MERGES the results,
  // throwing on unmergable conflicts. The compiled generator runs the sides
  // sequentially on the same value — equivalent only when neither side
  // rewrites it. Mutating sides (coerce, trim, defaults, ...) delegate to Zod.
  if (hasMutation(left) || hasMutation(right)) {
    return ctx.fallback("unsupported");
  }
  return { type: "intersection", left, right };
};

/** Merge only the object-intersection shape whose equivalence is statically obvious. */
function mergeDisjointStripObjects(left: SchemaIR, right: SchemaIR): ObjectIR | null {
  if (left.type !== "object" || right.type !== "object") return null;
  if (left.stripUnknownKeys !== true || right.stripUnknownKeys !== true) return null;
  if (
    left.strict === true ||
    right.strict === true ||
    left.catchall !== undefined ||
    right.catchall !== undefined ||
    left.checks !== undefined ||
    right.checks !== undefined ||
    left.suppressAbsentKeys !== undefined ||
    right.suppressAbsentKeys !== undefined
  ) {
    return null;
  }

  const leftKeys = Object.keys(left.properties);
  if (leftKeys.some((key) => Object.hasOwn(right.properties, key))) return null;

  const properties: Record<string, SchemaIR> = Object.create(null) as Record<string, SchemaIR>;
  for (const key of leftKeys) properties[key] = left.properties[key] as SchemaIR;
  const rightKeys = Object.keys(right.properties);
  for (const key of rightKeys) {
    properties[key] = right.properties[key] as SchemaIR;
  }
  // Integer-like keys are enumerated before other strings regardless of
  // insertion order. If that changes left-then-right traversal, a successful
  // parse could observe transform/refine callbacks in a different order.
  const expectedOrder = [...leftKeys, ...rightKeys];
  if (!Object.keys(properties).every((key, index) => key === expectedOrder[index])) return null;
  return { type: "object", properties, stripUnknownKeys: true };
}
