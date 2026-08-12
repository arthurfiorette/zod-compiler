import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { init } from "es-module-lexer";
import type { ZodType } from "zod";
import { isCompiledSchema } from "../core/compile.js";
import { jit, jitAll, type JitOptions } from "../jit.js";
import type { ZodCompilerRegisterConfig } from "./config.js";
import { decodeModuleSource, instrumentModule, isRegisterFormat } from "./transform.js";

const CONFIG_FILE = "zod-compiler.json";
const REGISTER_SYMBOL = Symbol.for("zod-compiler:register");

await init;

const config = loadConfig();
const jitOptions: JitOptions = {
  eager: config.eager,
  output: config.output,
};

Object.defineProperty(globalThis, REGISTER_SYMBOL, {
  configurable: true,
  value(value: unknown, flatten = false): unknown {
    registerValue(value);
    if (flatten && typeof value === "object" && value !== null) {
      for (const exported of Object.values(value)) registerValue(exported);
    }
    return value;
  },
});

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.startsWith("file:") || !isRegisterFormat(loaded.format) || loaded.source == null) {
      return loaded;
    }

    const filename = fileURLToPath(url);
    const source = decodeModuleSource(loaded.source);
    const transformed = instrumentModule(source, filename, loaded.format, config);
    return transformed === null ? loaded : { ...loaded, source: transformed };
  },
});

function registerValue(value: unknown): void {
  if (config.schemas === "explicit") {
    if (isCompiledSchema(value)) jit(value as unknown as ZodType, jitOptions);
  } else {
    jitAll({ value }, jitOptions);
  }
}

function loadConfig(): ZodCompilerRegisterConfig {
  const filename = path.resolve(CONFIG_FILE);
  let source: string;
  try {
    source = fs.readFileSync(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new SyntaxError(`Cannot parse ${filename}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${filename} must contain a JSON object`);
  }
  return value as ZodCompilerRegisterConfig;
}
