import { parse, type ExportSpecifier } from "es-module-lexer";
import { hoistZodSchemasMeta, type HoistOptions } from "../unplugin/hoist.js";
import { shouldTransform } from "../unplugin/transform.js";
import type { ZodCompilerRegisterConfig } from "./config.js";

const REGISTER_CALL = 'globalThis[Symbol.for("zod-compiler:register")]';
type RegisterFormat = "commonjs" | "commonjs-typescript" | "module" | "module-typescript";
const SUPPORTED_FORMATS = new Set([
  "commonjs",
  "commonjs-typescript",
  "module",
  "module-typescript",
]);

/** Formats whose source Node can execute after a synchronous load hook returns it. */
export function isRegisterFormat(format: string | null | undefined): format is RegisterFormat {
  return format !== null && format !== undefined && SUPPORTED_FORMATS.has(format);
}

/** Decode the textual module formats accepted by Node's load hook. */
export function decodeModuleSource(source: string | ArrayBuffer | NodeJS.TypedArray): string {
  if (typeof source === "string") return source;
  if (source instanceof ArrayBuffer) return new TextDecoder().decode(source);
  return new TextDecoder().decode(
    new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
  );
}

/**
 * Add lazy JIT registration to a module without executing it during the load hook.
 * Named ESM exports are referenced by their real local binding, so aliases and
 * multiple declarations work without rewriting their initializers.
 */
export function instrumentModule(
  source: string,
  filename: string,
  format: RegisterFormat,
  config: ZodCompilerRegisterConfig,
): string | null {
  const filter = {
    ...(config.include === undefined ? {} : { include: config.include }),
    ...(config.exclude === undefined ? {} : { exclude: config.exclude }),
  };
  if (!shouldTransform(filename, filter)) return null;
  if (!/[Zz]od/.test(source)) return null;

  const hoisted = config.hoist === false ? null : hoistZodSchemasMeta(source, hoistOptions(config));
  const code = hoisted?.code ?? source;
  const names = new Set(hoisted?.schemas.map((schema) => schema.name) ?? []);

  if (format === "commonjs" || format === "commonjs-typescript") {
    return appendRegistrations(code, [...names], true);
  }

  let exports: readonly ExportSpecifier[];
  try {
    [, exports] = parse(code);
  } catch {
    return hoisted?.code ?? null;
  }

  const typeOnlyNames = collectTypeOnlyExportNames(code, exports);
  for (const exported of exports) {
    if (exported.ls < 0 || exported.le < 0) continue;
    const localName = code.slice(exported.ls, exported.le);
    if (typeOnlyNames.has(localName)) continue;
    names.add(localName);
  }

  return names.size === 0 ? (hoisted?.code ?? null) : appendRegistrations(code, [...names], false);
}

function hoistOptions(config: ZodCompilerRegisterConfig): HoistOptions | undefined {
  return typeof config.hoist === "object" ? config.hoist : undefined;
}

function appendRegistrations(code: string, names: readonly string[], commonjs: boolean): string {
  const calls = names.map((name) => `${REGISTER_CALL}(${name});`);
  if (commonjs) calls.push(`${REGISTER_CALL}(module.exports, true);`);
  return `${code}\n;${calls.join("\n")}\n`;
}

/** es-module-lexer deliberately accepts TS syntax but reports `type` list entries as values. */
function collectTypeOnlyExportNames(
  code: string,
  exports: readonly ExportSpecifier[],
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const exported of exports) {
    const statement = code.slice(exported.ss, exported.le < 0 ? exported.e : exported.le);
    if (/^export\s+type\b/.test(statement)) {
      if (exported.ln) names.add(exported.ln);
      continue;
    }
    for (const match of statement.matchAll(/(?:^|[{,])\s*type\s+([A-Za-z_$][\w$]*)/g)) {
      names.add("type");
      if (match[1]) names.add(match[1]);
    }
  }
  return names;
}
