import type { CodeGenResult, CodegenMode, GeneratedSetConstant } from "./codegen/context.js";
import { createSharedSchemaPlan, SHARED_BLOCK_MARKER } from "./codegen/dedupe.js";
import { generateValidator } from "./codegen/index.js";
import type { RefEntry } from "./extract/index.js";
import { extractSchema } from "./extract/index.js";
import type { DiscoveredSchema, SchemaIR } from "./types.js";

/** Result of compiling a single discovered schema through extract → generate pipeline. */
export interface CompiledSchemaInfo {
  exportName: string;
  codegenResult: CodeGenResult;
  refEntries: RefEntry[];
}

/** Module-scope declarations produced by file-level schema and constant dedup. */
export interface SharedSchemaBlock {
  /** Shared constants and `__zcSw_N` functions. Empty string when nothing repeats. */
  code: string;
  /** Runtime helper names referenced by the shared block (lean mode imports). */
  usedHelpers: Set<string>;
}

/** Output of {@link compileSchemas}: per-schema validators plus the file's shared block. */
export interface CompileSchemasResult {
  schemas: CompiledSchemaInfo[];
  shared: SharedSchemaBlock;
}

export interface CompileSchemasOptions {
  /** "inline" for CLI .compiled.ts; "lean" for unplugin (imports from virtual:zod-compiler/runtime). */
  mode: CodegenMode;
  /**
   * Compact output (`output: "compact"`). Drop the compiled slow walk for
   * mutation-free, total-fast-path schemas and delegate their cold error path
   * to the retained Zod schema. Disables slow-walk sharing (delegated schemas
   * never emit a walk to share) and appends a root self-RefEntry per delegated
   * schema so `__rf[N]` resolves to the original Zod schema.
   */
  compact?: boolean | undefined;
  /** When provided, per-schema failures call this and continue. Otherwise the first error throws. */
  onError?: (exportName: string, error: Error) => void;
}

/** Plan exact Set initializers used by at least two validators in this file. */
function planSharedSetConstants(
  results: readonly CompiledSchemaInfo[],
  constantsByResult: ReadonlyMap<CodeGenResult, readonly GeneratedSetConstant[]>,
): ReadonlyMap<string, string> {
  const byInitializer = new Map<string, Set<CodeGenResult>>();
  for (const { codegenResult } of results) {
    for (const constant of constantsByResult.get(codegenResult) ?? []) {
      const declaration = `var ${constant.name}=${constant.initializer};`;
      // Fast-path generation can emit a Set before a later node aborts. Its
      // preamble is rolled back, so only collect declarations that survived.
      if (!codegenResult.code.includes(declaration)) continue;
      const users = byInitializer.get(constant.initializer);
      if (users === undefined) byInitializer.set(constant.initializer, new Set([codegenResult]));
      else users.add(codegenResult);
    }
  }

  const repeated = [...byInitializer.entries()]
    .filter(([, users]) => users.size >= 2)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new Map(repeated.map(([initializer], index) => [initializer, `__zcSet_${index}`]));
}

function emitSharedSetConstants(sharedSetNames: ReadonlyMap<string, string>): string {
  return [...sharedSetNames]
    .map(([initializer, name]) => `var ${name}=/* @__PURE__ */${initializer};`)
    .join("\n");
}

/**
 * Run the extract → generate pipeline for each discovered schema.
 * Shared by CLI generate and unplugin transform.
 *
 * Pass 1 extracts every schema's IR and plans repeated slow walks. Pass 2
 * generates each validator, calling shared `__zcSw_N` functions instead of
 * re-inlining them. Exact Set initializers reported during generation are then
 * pooled when at least two validators use them. Files with no repetition keep
 * their original local declarations.
 */
export function compileSchemas(
  schemas: DiscoveredSchema[],
  options: CompileSchemasOptions,
): CompileSchemasResult {
  const handle = (exportName: string, err: unknown): void => {
    if (options.onError) {
      options.onError(exportName, err instanceof Error ? err : new Error(String(err)));
    } else {
      throw err;
    }
  };

  // Pass 1: extract IR (and fallback refs) for every schema.
  const extracted: Array<{
    exportName: string;
    schema: unknown;
    ir: SchemaIR;
    refEntries: RefEntry[];
  }> = [];
  for (const s of schemas) {
    try {
      const refEntries: RefEntry[] = [];
      const ir = extractSchema(s.schema, refEntries);
      extracted.push({ exportName: s.exportName, schema: s.schema, ir, refEntries });
    } catch (err) {
      handle(s.exportName, err);
    }
  }

  // Compact mode delegates the cold error path of total-fast-path schemas to
  // zod, so they emit no slow walk to share — skip the plan (and the dead
  // shared functions it would generate for shapes that now only delegate).
  const plan = options.compact
    ? undefined
    : createSharedSchemaPlan(
        extracted.map((e) => e.ir),
        options.mode,
      );

  // Pass 2: generate each validator, sharing repeated slow walks via the plan
  // and observing which Set declarations survive codegen rollback.
  const generated: Array<{
    exportName: string;
    schema: unknown;
    ir: SchemaIR;
    refEntries: RefEntry[];
    codegenResult: CodeGenResult;
  }> = [];
  const constantsByResult = new Map<CodeGenResult, GeneratedSetConstant[]>();
  for (const e of extracted) {
    try {
      const setConstants = new Map<string, GeneratedSetConstant>();
      const codegenResult = generateValidator(e.ir, e.exportName, {
        refCount: e.refEntries.length,
        mode: options.mode,
        sharedSchemas: plan,
        compact: options.compact,
        onSetConstant(constant) {
          setConstants.set(constant.name, constant);
        },
      });
      constantsByResult.set(codegenResult, [...setConstants.values()]);
      generated.push({
        exportName: e.exportName,
        schema: e.schema,
        ir: e.ir,
        refEntries: e.refEntries,
        codegenResult,
      });
    } catch (err) {
      handle(e.exportName, err);
    }
  }

  const initialResults = generated.map(
    ({ exportName, codegenResult, refEntries }): CompiledSchemaInfo => ({
      exportName,
      codegenResult,
      refEntries,
    }),
  );
  const sharedSetNames = planSharedSetConstants(initialResults, constantsByResult);

  // Regenerate only when sharing is profitable. Selecting shared names before
  // emission avoids textual rewriting of generated JavaScript, where a user
  // enum string can legally contain text resembling a generated identifier.
  if (sharedSetNames.size > 0) {
    for (const entry of generated) {
      entry.codegenResult = generateValidator(entry.ir, entry.exportName, {
        refCount: entry.refEntries.length,
        mode: options.mode,
        sharedSchemas: plan,
        compact: options.compact,
        sharedSetNames,
      });
    }
  }

  const results: CompiledSchemaInfo[] = generated.map((entry) => {
    // Compact delegation appends the schema itself as a fresh root RefEntry
    // after the optional regeneration pass, keeping the reserved index stable.
    if (entry.codegenResult.rootDelegateRefIndex !== undefined) {
      entry.refEntries.push({ schema: entry.schema, accessPath: "" });
    }
    return {
      exportName: entry.exportName,
      codegenResult: entry.codegenResult,
      refEntries: entry.refEntries,
    };
  });

  const sharedSetCode = emitSharedSetConstants(sharedSetNames);
  const slowWalkCode = plan?.code ?? "";
  const sharedCode =
    sharedSetCode === ""
      ? slowWalkCode
      : slowWalkCode === ""
        ? `${SHARED_BLOCK_MARKER}\n${sharedSetCode}`
        : `${slowWalkCode}\n${sharedSetCode}`;

  return {
    schemas: results,
    shared: { code: sharedCode, usedHelpers: plan?.usedHelpers ?? new Set() },
  };
}

/**
 * Aggregate `usedHelpers` across multiple compiled schemas (typically all schemas in one file).
 * Used by the unplugin transform to construct a single import statement per file.
 */
export function aggregateUsedHelpers(schemas: CompiledSchemaInfo[]): Set<string> {
  const all = new Set<string>();
  for (const s of schemas) {
    for (const h of s.codegenResult.usedHelpers) all.add(h);
  }
  return all;
}
