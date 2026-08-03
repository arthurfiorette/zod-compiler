/**
 * Shared differential-parity harness: compiles a schema through the real
 * extract → codegen pipeline with a production-equivalent __zcFin (Zod locale
 * wired, mirroring ZOD_MSG_DECLARATION) and compares against Zod itself.
 */
import { expect } from "vite-plus/test";
import { ZodRealError, z, core } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import type { ExtractOptions, RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import {
  FAIL_CLASS_DECL,
  FAILZ_CLASS_DECL,
  FIN_DECL,
  FIN_DEFERRED_DECL,
  FINZ_DECL,
  ZOD_MSG_DECLARATION,
} from "#src/core/iife.js";
import type { SafeParseResult } from "#src/core/types.js";

// `__zcMsg` is built from the SAME declaration production emits, not a
// stand-in: it resolves `config.customError`/`config.localeError` per call, so
// a harness that passed a snapshotted `localeError` here would silently not
// exercise either.
const localizedFin = new Function(
  "__zodCompilerConfig",
  "__zcZodError",
  `${ZOD_MSG_DECLARATION}${FAIL_CLASS_DECL}${FIN_DECL}; return __zcFin;`,
)(z.config, ZodRealError);

const finZ = new Function(`${FAILZ_CLASS_DECL}${FINZ_DECL}; return __zcFinZ;`)() as (
  rfp: (input: unknown) => SafeParseResult<unknown>,
  input: unknown,
) => SafeParseResult<unknown>;

export interface ZodLikeSchema {
  safeParse: (input: unknown) => {
    success: boolean;
    data?: unknown;
    error?: { issues: { message: string }[] };
  };
}

export function compileLikeProduction(
  schema: unknown,
  name = "parity",
  extractOptions?: ExtractOptions,
  options?: { compact?: boolean },
): (input: unknown) => SafeParseResult<unknown> {
  const refEntries: RefEntry[] = [];
  const ir = extractSchema(schema, refEntries, extractOptions);
  const generated = generateValidator(ir, name, {
    refCount: refEntries.length,
    compact: options?.compact,
  });
  // Compact delegation appends the schema itself as the root RefEntry (the
  // pipeline does this in production); mirror it so `__rf[N]` resolves to the
  // schema whose pristine safeParse the validator delegates to.
  const rf = refEntries.map((e) => e.schema);
  if (generated.rootDelegateRefIndex !== undefined) {
    rf.push(schema);
  }
  const factory = new Function(
    "__zodCompilerConfig",
    "__zcZodError",
    "__zcCore",
    "__zcFin",
    "__zcFinZ",
    "__rf",
    // Strict, like the ES module the generated code ships inside: an
    // assignment to an undeclared identifier must fail here, not in the bundle.
    `"use strict";${ZOD_MSG_DECLARATION}${FAIL_CLASS_DECL}${FIN_DEFERRED_DECL}\n${generated.code}\nreturn ${generated.functionDef};`,
  );
  return factory(z.config, ZodRealError, core, localizedFin, finZ, rf) as (
    input: unknown,
  ) => SafeParseResult<unknown>;
}

/** JSON.stringify that survives BigInt, symbols, and other non-serializable inputs. */
function describeInput(input: unknown): string {
  try {
    return (
      JSON.stringify(input, (_k, v) =>
        typeof v === "bigint" ? `${v}n` : typeof v === "symbol" ? String(v) : v,
      ) ?? String(input)
    );
  } catch {
    return String(input);
  }
}

/** `code@path` for one issue, with the segments rendered so symbols survive. */
function issueSignature(issue: { code?: string; path?: unknown[] }): string {
  const path = (issue.path ?? []).map((seg) => (typeof seg === "symbol" ? String(seg) : seg));
  return `${issue.code}@${JSON.stringify(path, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))}`;
}

/**
 * Assert compiled accept/reject, output data, and the whole ISSUE LIST match Zod
 * for every input. Schemas that throw synchronously (async refinements, function
 * schemas) must throw identically on both sides.
 *
 * The issue list is compared as `code@path` per issue, in order, plus the first
 * message. Comparing only that first message — as this harness once did — is
 * blind to a dropped issue, an extra one, and to every path segment: three
 * shipped bugs (set elements getting an invented index, map entries addressed by
 * position instead of by key, an outer refine suppressed by a field's own failed
 * check) all passed a green suite because nothing here looked at paths.
 */
export function expectParity(
  schema: ZodLikeSchema,
  inputs: unknown[],
  name?: string,
  extractOptions?: ExtractOptions,
  options?: { compact?: boolean },
): void {
  const compiled = compileLikeProduction(schema, name, extractOptions, options);
  for (const input of inputs) {
    let zodResult: ReturnType<ZodLikeSchema["safeParse"]> | undefined;
    let zodThrew: string | undefined;
    try {
      zodResult = schema.safeParse(input);
    } catch (e) {
      zodThrew = e instanceof Error ? e.constructor.name : "unknown";
    }
    // oxlint-disable-next-line typescript/no-redundant-type-constituents -- false positive: SafeParseSuccess<unknown> is not a top type
    let compiledResult: SafeParseResult<unknown> | undefined;
    let compiledThrew: string | undefined;
    try {
      compiledResult = compiled(input);
    } catch (e) {
      compiledThrew = e instanceof Error ? e.constructor.name : "unknown";
    }

    expect(compiledThrew, `throw parity for ${describeInput(input)}`).toBe(zodThrew);
    if (zodThrew !== undefined || !zodResult || !compiledResult) continue;

    expect(compiledResult.success, `accept/reject for ${describeInput(input)}`).toBe(
      zodResult.success,
    );
    if (zodResult.success && compiledResult.success) {
      if (typeof zodResult.data === "function") {
        // Function schemas return a fresh wrapper per parse — identity differs.
        expect(typeof compiledResult.data, `output kind for ${describeInput(input)}`).toBe(
          "function",
        );
      } else {
        expect(compiledResult.data, `output data for ${describeInput(input)}`).toEqual(
          zodResult.data,
        );
      }
    }
    if (!zodResult.success && !compiledResult.success) {
      const zodIssues = (zodResult.error?.issues ?? []) as { code?: string; path?: unknown[] }[];
      const compiledIssues = compiledResult.error.issues as { code?: string; path?: unknown[] }[];
      expect(
        compiledIssues.map(issueSignature),
        `issue codes+paths for ${describeInput(input)}`,
      ).toStrictEqual(zodIssues.map(issueSignature));

      const zodMessage = zodResult.error?.issues[0]?.message;
      const compiledMessage = (compiledResult.error.issues[0] as { message?: string })?.message;
      expect(compiledMessage, `message for ${describeInput(input)}`).toBe(zodMessage);
    }
  }
}
