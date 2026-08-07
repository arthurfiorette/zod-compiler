import type { MapIR, SchemaIR } from "../../types.js";
import type { FastGen, SlowGen } from "../context.js";
import { declareFastTemps, emitRuntimeHelper, hasMutation } from "../context.js";
import { emit } from "../emit.js";
import { invalidType } from "../emit-issue.js";
import { propertyKeyTest, ZC_FZ_DECL, ZC_PFX_DECL } from "../issue-decls.js";

/**
 * Map entries report through zod's `handleMapResult`, which branches on the
 * RUNTIME type of the key rather than on the key schema:
 *
 * - a property-key type (string | number | symbol) addresses the entry, so key
 *   AND value issues are prefixed with the key itself → `[...mapPath, key, …]`.
 *   This holds even when the key is the wrong type for the schema — a `number`
 *   key under `z.map(z.string(), …)` still reports at `[5]`.
 * - anything else (boolean, bigint, object, …) cannot be a path segment, so the
 *   issues are WRAPPED: key issues into one `invalid_key`, value issues into one
 *   `invalid_element` carrying the offending `key`, both at the map's own path
 *   with the originals nested and finalized.
 *
 * The key is snapshotted before validation because zod passes the ORIGINAL key
 * to both the type test and the prefix, and a mutating key schema (`.trim()`)
 * would otherwise have rewritten it by then.
 */
export function slowMap(ir: SchemaIR & { type: "map" }, g: SlowGen): string {
  const entryVar = g.temp("map_e");
  const keyVar = g.temp("map_k");
  const pkVar = g.temp("map_pk");
  const keyIssues = g.temp("map_ki");
  const valIssues = g.temp("map_vi");
  // Mutating key/value schemas (coerce, .trim(), url) rewrite the entry tuple,
  // which a Map cannot reflect — rebuild into a fresh Map (mirrors Zod).
  const mutates = hasMutation(ir.keyType) || hasMutation(ir.valueType);
  const rebuiltVar = mutates ? g.temp("map_n") : "";
  const msgProp = g.typeMsg === undefined ? "" : `,message:${JSON.stringify(g.typeMsg)}`;
  const fz = emitRuntimeHelper(g.ctx, "__zcFz", ZC_FZ_DECL);
  const pfx = emitRuntimeHelper(g.ctx, "__zcPfx", ZC_PFX_DECL);

  // Key and value are validated into scratch arrays at a path RELATIVE to the
  // entry, exactly as zod runs them on a fresh payload — whichever branch the
  // key's type selects then decides where those paths get rooted.
  const keyCode = g.visit(ir.keyType, {
    input: `${entryVar}[0]`,
    output: `${entryVar}[0]`,
    path: "[]",
    issues: keyIssues,
  });
  const valCode = g.visit(ir.valueType, {
    input: `${entryVar}[1]`,
    output: `${entryVar}[1]`,
    path: "[]",
    issues: valIssues,
  });

  return `${emit`
    if(!(${g.input} instanceof Map)){
      ${invalidType(g, "map")}
    }else{
      ${mutates ? `var ${rebuiltVar}=new Map();` : ""}
      for(var ${entryVar} of ${g.input}){
        var ${keyVar}=${entryVar}[0];
        var ${pkVar}=${propertyKeyTest(keyVar)};
        var ${keyIssues}=[];
        ${keyCode}
        if(${keyIssues}.length>0){
          if(${pkVar}){
            ${pfx}(${g.issues},${keyIssues},${g.path},${keyVar});
          }else{
            ${g.issues}.push({code:"invalid_key",origin:"map",issues:${fz}(${keyIssues}),input:${g.input},path:${g.path}${msgProp}});
          }
        }
        var ${valIssues}=[];
        ${valCode}
        if(${valIssues}.length>0){
          if(${pkVar}){
            ${pfx}(${g.issues},${valIssues},${g.path},${keyVar});
          }else{
            ${g.issues}.push({origin:"map",code:"invalid_element",key:${keyVar},issues:${fz}(${valIssues}),input:${g.input},path:${g.path}${msgProp}});
          }
        }
        ${mutates ? `${rebuiltVar}.set(${entryVar}[0],${entryVar}[1]);` : ""}
      }
      ${mutates ? `${g.output}=${rebuiltVar};` : ""}
    }
  `}\n`;
}

export function fastMap(ir: MapIR, g: FastGen): string | null {
  const x = g.input;
  const parts: string[] = [`${x} instanceof Map`];

  // Key/value validation via preamble helper (Map has no .every()).
  // Key + value share one fresh scope — same emitted helper, size-gated
  // independently of the caller.
  const entryVar = g.temp("me");
  const body = g.scoped(`${entryVar}[0]`);
  const keyCheck = body.visit(ir.keyType, { input: `${entryVar}[0]` });
  if (keyCheck === null) return null;
  const valCheck = body.visit(ir.valueType, { input: `${entryVar}[1]` });
  if (valCheck === null) return null;

  if (keyCheck !== "true" || valCheck !== "true") {
    const combined = [keyCheck, valCheck].filter((c) => c !== "true").join("&&");
    const helperName = g.temp("mh");
    g.ctx.preamble.push(
      `function ${helperName}(m){${declareFastTemps(body.scope)}for(var ${entryVar} of m){if(!(${combined})){return false;}}return true;}`,
    );
    parts.push(`${helperName}(${x})`);
  }

  return parts.join("&&");
}
