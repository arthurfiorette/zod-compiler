import fs, { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import MagicString from "magic-string";
import { afterAll, describe, expect, it } from "vite-plus/test";
import zodCompilerLoader, {
  type ZodCompilerLoaderContext,
  type ZodCompilerTurbopackOptions,
} from "#src/turbopack.js";

const fixturesDir = path.resolve(import.meta.dirname, "fixtures");

/** 1-based line / 0-based column of the first occurrence of `token`. */
function positionOf(code: string, token: string): { line: number; column: number } {
  const at = code.indexOf(token);
  const before = code.slice(0, at);
  return { line: before.split("\n").length, column: at - (before.lastIndexOf("\n") + 1) };
}

interface LoaderRun {
  code: string;
  map: unknown;
  dependencies: string[];
  cacheable: boolean;
}

/**
 * Drive the loader through the same contract a webpack loader host uses: a
 * `this` carrying `async()`/`getOptions()`, and a callback that ends the run.
 * No Next.js or webpack needed — the loader context is structural.
 */
async function runLoader(
  filename: string,
  options: ZodCompilerTurbopackOptions = {},
  overrides: Partial<ZodCompilerLoaderContext> & {
    source?: string;
    inputMap?: unknown;
  } = {},
): Promise<LoaderRun> {
  const { source: sourceOverride, inputMap, ...contextOverrides } = overrides;
  const source = sourceOverride ?? fs.readFileSync(filename, "utf8");
  const dependencies: string[] = [];
  let cacheable = true;

  let settle: (error: Error | null, code?: string, map?: unknown) => void = () => {};
  const finished = new Promise<LoaderRun>((resolve, reject) => {
    settle = (error, code, map) => {
      if (error) reject(error);
      else resolve({ code: code as string, map, dependencies, cacheable });
    };
  });

  const context: ZodCompilerLoaderContext = {
    resourcePath: filename,
    getOptions: () => options,
    addDependency: (file) => dependencies.push(file),
    cacheable: (flag) => {
      cacheable = flag;
    },
    async: () => settle,
    ...contextOverrides,
  };
  // Called OUTSIDE the promise executor on purpose: inside it, a synchronous
  // throw would reject `finished` and be indistinguishable from an error
  // routed properly through the callback.
  zodCompilerLoader.call(context, source, inputMap);
  return finished;
}

describe("zod-compiler/turbopack", () => {
  it("compiles exported schemas with inline helpers by default", async () => {
    const result = await runLoader(path.join(fixturesDir, "auto-discover-simple.ts"));

    expect(result.code).toContain("safeParse_UserSchema");
    // A loader has no resolveId hook, so the virtual runtime specifier would
    // reach the host unresolved.
    expect(result.code).toContain("function __zcMkv(");
    expect(result.code).not.toContain("virtual:zod-compiler/runtime");
  });

  it("returns a sourcemap alongside the transformed code", async () => {
    const result = await runLoader(path.join(fixturesDir, "auto-discover-simple.ts"));

    expect(result.map).toMatchObject({ version: 3 });
  });

  it("keeps a leading directive first, so RSC hosts accept the output", async () => {
    const result = await runLoader(path.join(fixturesDir, "directive-use-client.ts"));

    expect(result.code).toContain("safeParse_SignupSchema");
    expect(result.code.startsWith('"use client";')).toBe(true);
  });

  /**
   * The host caches on this file's own content, but discovery executed its
   * whole import graph — without these an edit to an imported constant leaves
   * a stale validator in the bundle.
   */
  it("declares every file discovery executed as a dependency", async () => {
    const entry = path.join(fixturesDir, "dep-declaring", "schemas.ts");
    const result = await runLoader(entry);

    expect(result.code).toContain("safeParse_AccountSchema");
    expect(result.dependencies).toContain(entry);
    expect(result.dependencies).toContain(path.join(fixturesDir, "dep-declaring", "limits.ts"));
    expect(result.cacheable).toBe(true);
  });

  it("refuses to cache when the import graph cannot be analyzed", async () => {
    const result = await runLoader(path.join(fixturesDir, "dep-declaring", "dynamic.ts"));

    // No dependency list is trustworthy here, so re-running every build is the
    // only sound answer.
    expect(result.cacheable).toBe(false);
  });

  it("declares nothing for a file that never ran discovery", async () => {
    const result = await runLoader(path.join(fixturesDir, "no-compile.ts"), {
      schemas: "explicit",
    });

    expect(result.dependencies).toEqual([]);
    expect(result.cacheable).toBe(true);
  });

  it("passes files rejected by exclude straight through", async () => {
    const filename = path.join(fixturesDir, "auto-discover-simple.ts");
    const result = await runLoader(filename, { exclude: ["**/auto-discover-simple.ts"] });

    expect(result.code).toBe(fs.readFileSync(filename, "utf8"));
    expect(result.dependencies).toEqual([]);
  });

  it("honors output: bag by dropping the retained Zod schema", async () => {
    const fixture = path.join(fixturesDir, "auto-discover-simple.ts");
    const schema = await runLoader(fixture);
    const bag = await runLoader(fixture, { output: "bag" });

    // Default keeps the schema object so `.shape` / instanceof survive; bag
    // passes null in its place, letting the z.object() construction tree-shake.
    expect(schema.code).toContain("__zcMkv(safeParse_UserSchema,z.object({");
    expect(bag.code).toContain("__zcMkv(safeParse_UserSchema,null,");
  });

  it("falls back to query when the host provides no getOptions", async () => {
    const filename = path.join(fixturesDir, "auto-discover-simple.ts");
    const result = await runLoader(
      filename,
      {},
      {
        getOptions: undefined,
        query: { exclude: ["**/auto-discover-simple.ts"] },
      },
    );

    expect(result.code).toBe(fs.readFileSync(filename, "utf8"));
  });

  it("survives a host that implements only the required context members", async () => {
    const filename = path.join(fixturesDir, "auto-discover-simple.ts");
    const bare = { addDependency: undefined, cacheable: undefined };
    const result = await runLoader(filename, {}, bare);

    expect(result.code).toContain("safeParse_UserSchema");
  });

  it("chains an earlier loader's sourcemap so positions trace to the true original", async () => {
    const filename = path.join(fixturesDir, "auto-discover-simple.ts");
    const original = fs.readFileSync(filename, "utf8");
    // Stand in for a preceding loader that prepended two lines.
    const shifted = `// injected\n// injected\n${original}`;
    const shiftedMap = new MagicString(original)
      .prepend("// injected\n// injected\n")
      .generateMap({ source: filename, hires: "boundary", includeContent: true });

    const traceBack = (run: LoaderRun): number | null =>
      originalPositionFor(
        new TraceMap(run.map as ConstructorParameters<typeof TraceMap>[0]),
        positionOf(run.code, "z.string().min(1)"),
      ).line;

    const plain = await runLoader(filename);
    const chained = await runLoader(filename, {}, { source: shifted, inputMap: shiftedMap });

    // Composed, the chain lands on the same original line as an unchained run.
    // Uncomposed — or composed in the wrong order — it reports the injected
    // lines' offset instead.
    expect(traceBack(chained)).toBe(traceBack(plain));
    expect(traceBack(chained)).not.toBe((traceBack(plain) as number) + 2);
  });

  it("calls back exactly once", async () => {
    const filename = path.join(fixturesDir, "auto-discover-simple.ts");
    const calls: string[] = [];
    const context: ZodCompilerLoaderContext = {
      resourcePath: filename,
      getOptions: () => ({}),
      async: () => (error) => {
        calls.push(error ? "error" : "ok");
      },
    };

    zodCompilerLoader.call(context, fs.readFileSync(filename, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(calls).toEqual(["ok"]);
  });

  it("passes an earlier loader's map through untouched when it does not transform", async () => {
    const filename = path.join(fixturesDir, "auto-discover-simple.ts");
    const inputMap = { version: 3, sources: [filename], names: [], mappings: "" };
    const result = await runLoader(
      filename,
      { exclude: ["**/auto-discover-simple.ts"] },
      { inputMap },
    );

    expect(result.map).toBe(inputMap);
  });

  it("refuses to cache an environment-dependent result", async () => {
    // The file exits during discovery (an env guard in a secret-less build), so
    // what was compiled reflects the ENVIRONMENT, not the content the host keys
    // its cache on.
    const result = await runLoader(path.join(fixturesDir, "process-exit-guard.ts"));

    expect(result.cacheable).toBe(false);
  });

  it("reports a transform failure through the callback instead of throwing", async () => {
    // picomatch rejects a non-string pattern. runLoader invokes the loader
    // outside its promise executor, so this only passes if the error reached
    // the host through the callback rather than escaping synchronously.
    await expect(
      runLoader(path.join(fixturesDir, "auto-discover-simple.ts"), {
        include: [42 as unknown as string],
      }),
    ).rejects.toThrow();
  });
});

/**
 * The reason `addDependency` exists. A dependency edit makes the host re-run
 * the loader for a schema file whose OWN content is unchanged, so an
 * entry-content diff alone never invalidates and discovery hands back the
 * cached module execution — the compiled validator keeps encoding the old
 * value. These drive the loader repeatedly against a mutating project, which
 * is the only way that shows up.
 */
describe("zod-compiler/turbopack invalidation", () => {
  const TMP = mkdtempSync(path.join(fixturesDir, ".turbopack-"));

  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  let n = 0;
  function project(files: Record<string, string>): string {
    const dir = path.join(TMP, `p${n++}`);
    mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(path.join(dir, rel), content);
    }
    return dir;
  }

  /** A schema whose only constraint comes from an imported constant. */
  const IMPORTS_LIMIT = [
    `import { z } from "zod";`,
    `import { MIN_HANDLE } from "./limits.js";`,
    `export const AccountSchema = z.object({ handle: z.string().min(MIN_HANDLE) });`,
  ].join("\n");

  const selfContained = (min: number): string =>
    [`import { z } from "zod";`, `export const S = z.object({ a: z.string().min(${min}) });`].join(
      "\n",
    );

  /** mtime has limited resolution; make an edit unambiguously newer. */
  function rewrite(file: string, content: string): void {
    writeFileSync(file, content);
    const future = new Date(Date.now() + 2000);
    utimesSync(file, future, future);
  }

  it("recompiles when an imported constant changes but the entry does not", async () => {
    const dir = project({
      "limits.ts": `export const MIN_HANDLE = 3;`,
      "schemas.ts": IMPORTS_LIMIT,
    });
    const entry = path.join(dir, "schemas.ts");

    const before = await runLoader(entry);
    expect(before.code).toContain("length>=3");

    rewrite(path.join(dir, "limits.ts"), `export const MIN_HANDLE = 99;`);

    // Same entry content — only the dependency moved.
    const after = await runLoader(entry);
    expect(after.code).toContain("length>=99");
    expect(after.code).not.toContain("length>=3");
  });

  it("recompiles when a dependency the loader never sees changes", async () => {
    const dir = project({
      "limits.ts": `export const MIN_HANDLE = 4;`,
      "schemas.ts": IMPORTS_LIMIT,
    });
    const entry = path.join(dir, "schemas.ts");

    // limits.ts never mentions zod, so a `content` rule condition keeps it out
    // of the loader entirely — the stamps have to come off disk.
    const before = await runLoader(entry, { exclude: ["**/limits.ts"] });
    expect(before.code).toContain("length>=4");

    rewrite(path.join(dir, "limits.ts"), `export const MIN_HANDLE = 44;`);

    const after = await runLoader(entry, { exclude: ["**/limits.ts"] });
    expect(after.code).toContain("length>=44");
  });

  it("recompiles when the entry's own content changes", async () => {
    const dir = project({
      "schemas.ts": selfContained(1),
    });
    const entry = path.join(dir, "schemas.ts");

    expect((await runLoader(entry)).code).toContain("length>=1");

    rewrite(entry, selfContained(7));

    expect((await runLoader(entry)).code).toContain("length>=7");
  });

  it("recompiles a file first seen only AFTER a shared dependency changed", async () => {
    // Both signals are per-file and empty on a first run, but the module cache
    // is global and already warm from the other file. `next dev` compiles
    // routes lazily, so "first transform of B happens after an edit A already
    // cached" is the normal case, not a corner.
    const dir = project({
      "limits.ts": `export const MIN_HANDLE = 6;`,
      "a.ts": IMPORTS_LIMIT,
      "b.ts": IMPORTS_LIMIT,
    });

    expect((await runLoader(path.join(dir, "a.ts"))).code).toContain("length>=6");

    rewrite(path.join(dir, "limits.ts"), `export const MIN_HANDLE = 66;`);

    // b.ts has never been through the loader — no content, no stamps of its own.
    expect((await runLoader(path.join(dir, "b.ts"))).code).toContain("length>=66");
  });

  it("recompiles even when the import graph is unanalyzable", async () => {
    // `cacheable(false)` gets the loader re-invoked, but re-invocation alone
    // does not re-read from disk — freshness has to come from the execution
    // stamps. dep-graph calls incomplete the common outcome on large graphs.
    const dir = project({
      "limits.ts": `export const MIN_HANDLE = 8;`,
      "schemas.ts": [
        IMPORTS_LIMIT,
        `const which = process.env["WHICH"] ?? "./limits.js";`,
        `export const loadIt = () => import(which);`,
      ].join("\n"),
    });
    const entry = path.join(dir, "schemas.ts");

    const before = await runLoader(entry);
    expect(before.cacheable).toBe(false);
    expect(before.code).toContain("length>=8");

    rewrite(path.join(dir, "limits.ts"), `export const MIN_HANDLE = 88;`);

    expect((await runLoader(entry)).code).toContain("length>=88");
  });

  it("stops wiping the cache once a file no longer runs discovery", async () => {
    // Execution stamps are refreshed globally rather than per entry, so a file
    // that drops its zod import cannot leave a permanently stale record that
    // re-evicts everyone else's executions on every later build.
    const dir = project({
      "limits.ts": `export const MIN_HANDLE = 9;`,
      "schemas.ts": IMPORTS_LIMIT,
    });
    const entry = path.join(dir, "schemas.ts");

    await runLoader(entry);
    rewrite(entry, `export const AccountSchema = null;`);
    await runLoader(entry);

    // Unchanged from here on: a second identical run must be a no-op.
    const first = await runLoader(entry);
    const second = await runLoader(entry);
    expect(second.code).toBe(first.code);
  });

  it("reuses the cached execution when nothing changed", async () => {
    const dir = project({
      "limits.ts": `export const MIN_HANDLE = 5;`,
      "schemas.ts": IMPORTS_LIMIT,
    });
    const entry = path.join(dir, "schemas.ts");

    // Turbopack runs the loader once per output graph (browser + SSR), so an
    // unchanged repeat must stay stable rather than churn the module cache.
    const first = await runLoader(entry);
    const second = await runLoader(entry);
    expect(second.code).toBe(first.code);
    expect(second.dependencies).toEqual(first.dependencies);
  });
});
