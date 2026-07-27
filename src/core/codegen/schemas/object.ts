import type { ObjectIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import {
  emitRefinePredicate,
  escapeString,
  extendStaticPath,
  hasMutation,
  keyMembershipTest,
  rejectsUndefined,
} from "../context.js";
import { emit } from "../emit.js";
import { invalidType, unrecognizedKeys } from "../emit-issue.js";
import { orderByRuntimeCost } from "../fast-size.js";
import { refineCheck } from "./effect.js";

export function slowObject(ir: SchemaIR & { type: "object" }, g: SlowGen): string {
  let code = emit`
    if(typeof ${g.input}!=="object"||${g.input}===null||Array.isArray(${g.input})){
      ${invalidType(g, "object")}
    }else{`;

  // Strip mode (zod's default z.object() output) rebuilds a FRESH object from
  // the declared keys, so it always writes back. Otherwise clone only when a
  // property mutates the value.
  const strip = ir.stripUnknownKeys === true;
  const needsClone = strip || Object.values(ir.properties).some(hasMutation);
  const objVar = g.temp("o");
  if (!strip) {
    // Spread, not Object.assign: V8's CloneObjectIC makes `{...x}` ~25% faster
    // on the whole safeParse call for mutation-bearing schemas.
    code += needsClone ? `var ${objVar}={...${g.input}};` : `var ${objVar}=${g.input};`;
  }

  // Object-level refines run only when the object itself parsed cleanly: zod
  // parses the properties into the payload first and skips the check chain when
  // that produced issues, so a bad property suppresses the refine entirely
  // (unlike string/number/array, where a failed check still lets later refines
  // run). Snapshot the issue count before the properties to reproduce it.
  const refineMark = ir.checks && ir.checks.length > 0 ? g.temp("rm") : "";
  if (refineMark) code += `var ${refineMark}=${g.issues}.length;`;

  const suppressAbsent = new Set(ir.suppressAbsentKeys ?? []);
  /** Strip only: per-property output slot + whether it is always in the result. */
  const slots: { always: boolean; keyStr: string; value: string }[] = [];

  for (const [key, propIR] of Object.entries(ir.properties)) {
    const keyStr = escapeString(key);
    const propPath = extendStaticPath(g.path, key);
    // Strip validates the value read from the INPUT, held in a local, and
    // assembles the result afterwards. Reading through the half-built copy (the
    // previous shape) both cost a megamorphic access per key — the copy's map
    // changes with every key added — and diverged from zod, which parses
    // `input[key]` and so accepts a value found on the prototype.
    const propExpr = strip ? g.temp("sv") : `${objVar}[${keyStr}]`;
    if (strip) {
      code += `var ${propExpr}=${g.input}[${keyStr}];`;
      slots.push({ always: rejectsUndefined(propIR), keyStr, value: propExpr });
    }
    const propCode = g.visit(propIR, { input: propExpr, output: propExpr, path: propPath });
    if (suppressAbsent.has(key)) {
      // Mirrors zod's handlePropertyResult: optional-out fallback props run,
      // but their issues are discarded when the key is absent from the input.
      const beforeVar = g.temp("ob");
      code += emit`
        var ${beforeVar}=${g.issues}.length;
        ${propCode}
        if(!(${keyStr} in ${strip ? g.input : objVar})&&${g.issues}.length>${beforeVar}){
          ${g.issues}.length=${beforeVar};
        }`;
    } else {
      code += propCode;
    }
  }

  if (strip) {
    // Assemble the result in shape order (zod's key order), taking as long a
    // LEADING run of always-present keys as possible into one object literal:
    // V8 stamps a literal out of a cached boilerplate map in a single
    // allocation, where adding keys one at a time walks a transition chain and
    // re-checks the map on every store — measured 8.1x (20 keys) / 2.8x (7
    // keys, one optional) on the whole safeParse.
    //
    // Everything after the first conditional key is appended so insertion order
    // still matches zod. The per-key test is zod's own: keep the key when the
    // parsed value is defined, or when it was present on the input at all
    // (`key in input`, prototype included — an own `k: undefined` survives).
    const literal: string[] = [];
    let appends = "";
    let leading = true;
    for (const slot of slots) {
      if (leading && slot.always) {
        literal.push(`${slot.keyStr}:${slot.value}`);
        continue;
      }
      leading = false;
      appends += slot.always
        ? `${objVar}[${slot.keyStr}]=${slot.value};`
        : `if(${slot.value}!==undefined||(${slot.keyStr} in ${g.input})){${objVar}[${slot.keyStr}]=${slot.value};}`;
    }
    code += `var ${objVar}={${literal.join(",")}};${appends}`;
  }

  // Strict unknown-key pass — zod's handleCatchall, byte-exact: for-in over
  // the ORIGINAL input (inherited enumerable keys count, no hasOwnProperty),
  // ALL unknown keys collected into one issue, pushed AFTER property issues
  // and before object-level refines.
  if (ir.strict) {
    const keys = Object.keys(ir.properties);
    const ukVar = g.temp("uk");
    const kVar = g.temp("k");
    const test = keyMembershipTest(g.ctx, keys, kVar);
    code += emit`
      var ${ukVar}=null;
      for(var ${kVar} in ${g.input}){
        if(!(${test})){(${ukVar}=${ukVar}||[]).push(${kVar});}
      }
      if(${ukVar}!==null){
        ${unrecognizedKeys(g, ukVar)}
      }`;
  }

  if (needsClone) {
    code += `${g.output}=${objVar};`;
  }

  // Object-level refine effects: z.object({...}).refine(fn), suppressed when a
  // property already failed (see refineMark).
  if (ir.checks && ir.checks.length > 0) {
    let refines = "";
    for (const check of ir.checks) refines += refineCheck(check, objVar, g);
    code += `if(${g.issues}.length===${refineMark}){${refines}}`;
  }

  code += `}\n`;
  return code;
}

/**
 * Property entries in the order their fast-checks should be `&&`-chained:
 * cheapest first, declaration order preserved among equals (Array#sort is
 * stable). Valid input runs every conjunct whatever the order, so this costs
 * nothing on the hot path; a REJECT stops at the first false conjunct, so
 * pricing a `z.email()` behind the `kind` literal that actually discriminates
 * is what makes union probing and `.is()` misses cheap (see
 * estimateRuntimeCost). The SLOW path keeps declaration order — that one's
 * output is the issue list, whose order is part of zod parity.
 */
function orderedProperties(ir: ObjectIR, g: FastGen): [string, SchemaIR][] {
  return orderByRuntimeCost(Object.entries(ir.properties), ([, propIR]) => propIR, g.ctx);
}

/**
 * Property/strict/refine fast-checks for an object, WITHOUT the leading
 * `typeof===object && !==null && !Array.isArray` type-guard. Returns the
 * conjunct parts (joinable with `&&`), or null if any child is fast-ineligible.
 *
 * `skipKey`, when given, omits that one property's check. Used by the
 * discriminated-union fast path (via `g.discSkipKey`): the enclosing `switch`
 * has already matched the discriminator's value, so re-checking it is redundant.
 */
function fastObjectBody(ir: ObjectIR, g: FastGen, skipKey?: string): string[] | null {
  const x = g.input;
  const parts: string[] = [];

  for (const [key, propIR] of orderedProperties(ir, g)) {
    if (key === skipKey) continue;
    const propExpr = `${x}[${escapeString(key)}]`;
    const propCheck = g.visit(propIR, { input: propExpr });
    if (propCheck === null) return null; // All-or-nothing
    parts.push(propCheck);
  }

  // Strict unknown-key pass: hosted boolean helper (a for-in loop cannot live
  // in the && chain). Same for-in iteration as the slow path — fast/slow
  // agreement is load-bearing under the __zcFinD deferral. The membership set is
  // the FULL key list (the discriminator is a recognized key), independent of
  // skipKey, which only suppresses re-validating the discriminator's value.
  if (ir.strict) {
    const keys = Object.keys(ir.properties);
    const fnName = g.temp("so");
    const test = keyMembershipTest(g.ctx, keys, "k");
    g.ctx.preamble.push(
      `function ${fnName}(o){for(var k in o){if(!(${test}))return false;}return true;}`,
    );
    parts.push(`${fnName}(${x})`);
  }

  // Object-level refine effects (appended last — run after property checks short-circuit)
  if (ir.checks) {
    for (const check of ir.checks) {
      if (check.kind === "refine_effect") {
        parts.push(`${emitRefinePredicate(g.ctx, check)}(${x})`);
      }
    }
  }

  return parts;
}

export function fastObject(ir: ObjectIR, g: FastGen): string | null {
  // Strip rebuilds a fresh output, so there is no by-reference fast path: fall
  // to the eager slow build (mirrors how .trim()/overwrite disables fastString).
  // Disabling it here also propagates up — any container holding a strip object
  // loses its fast path too, and `.is()` derives from safeParse(input).success.
  if (ir.stripUnknownKeys) return null;
  const x = g.input;
  const body = fastObjectBody(ir, g, g.discSkipKey);
  if (body === null) return null;
  // Discriminated-union option: the enclosing switch (and the caller's guard)
  // already established object-ness and the discriminator value, so emit only
  // the remaining checks — no leading type-guard. An option with nothing left
  // to check accepts unconditionally ("true").
  if (g.discSkipKey !== undefined) {
    return body.length > 0 ? body.join("&&") : "true";
  }
  return [`typeof ${x}==="object"`, `${x}!==null`, `!Array.isArray(${x})`, ...body].join("&&");
}
