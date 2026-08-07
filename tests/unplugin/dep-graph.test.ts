import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { collectStaticDeps, transformDependencies } from "#src/unplugin/dep-graph.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Inside the repo so bare specifiers (zod) resolve through node_modules.
const ROOT = mkdtempSync(path.join(__dirname, "..", "fixtures", ".depgraph-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

let n = 0;
function project(files: Record<string, string>): string {
  const dir = path.join(ROOT, `p${n++}`);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

describe("collectStaticDeps()", () => {
  it("follows relative import chains (extensionless and .js-to-.ts)", () => {
    const dir = project({
      "entry.ts": `import { a } from "./a";\nimport { b } from "./nested/b.js";\nexport const x = a + b;`,
      "a.ts": `export const a = 1;`,
      "nested/b.ts": `import { c } from "../c";\nexport const b = 2;`,
      "c.ts": `export const c = 3;`,
    });
    const result = collectStaticDeps(path.join(dir, "entry.ts"));
    expect(result.complete).toBe(true);
    expect(new Set(result.deps)).toEqual(
      new Set([path.join(dir, "a.ts"), path.join(dir, "nested/b.ts"), path.join(dir, "c.ts")]),
    );
  });

  it("handles cycles", () => {
    const dir = project({
      "entry.ts": `import "./a";`,
      "a.ts": `import "./b";`,
      "b.ts": `import "./a";`,
    });
    const result = collectStaticDeps(path.join(dir, "entry.ts"));
    expect(result.complete).toBe(true);
    expect(result.deps.sort()).toEqual([path.join(dir, "a.ts"), path.join(dir, "b.ts")].sort());
  });

  it("excludes node_modules packages (zod) but keeps the graph complete", () => {
    const dir = project({
      "entry.ts": `import { z } from "zod";\nimport { helper } from "./helper";\nexport const s = z.string();`,
      "helper.ts": `export const helper = 1;`,
    });
    const result = collectStaticDeps(path.join(dir, "entry.ts"));
    expect(result.complete).toBe(true);
    expect(result.deps).toEqual([path.join(dir, "helper.ts")]);
  });

  it("follows arbitrary tsconfig path aliases", () => {
    const dir = project({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@lib/*": ["src/lib/*"],
            "~*": ["src/*"],
            "pkg-*": ["packages/*/index"],
          },
        },
      }),
      "entry.ts": `import { a } from "@lib/a";\nimport { b } from "~shared/b";\nimport { c } from "pkg-c";\nexport const x = a + b + c;`,
      "src/lib/a.ts": `export const a = 1;`,
      "src/shared/b.ts": `export const b = 2;`,
      "packages/c/index.ts": `export const c = 3;`,
    });
    const result = collectStaticDeps(path.join(dir, "entry.ts"));
    expect(result.complete).toBe(true);
    expect(new Set(result.deps)).toEqual(
      new Set([
        path.join(dir, "src/lib/a.ts"),
        path.join(dir, "src/shared/b.ts"),
        path.join(dir, "packages/c/index.ts"),
      ]),
    );
  });

  it("keeps bare and #-subpath imports resolvable under a baseUrl tsconfig", () => {
    // With baseUrl set, the paths matcher proposes `<baseDir>/<specifier>`
    // for EVERY bare specifier — npm packages and package.json imports must
    // still fall through to node resolution instead of poisoning the graph.
    const dir = project({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: "." },
      }),
      "package.json": JSON.stringify({
        name: "p",
        type: "module",
        imports: { "#util": "./util.ts" },
      }),
      "entry.ts": `import { z } from "zod";\nimport { u } from "#util";\nimport { a } from "src/a";\nexport const x = z.number().parse(u + a);`,
      "util.ts": `export const u = 1;`,
      "src/a.ts": `export const a = 2;`,
    });
    const result = collectStaticDeps(path.join(dir, "entry.ts"));
    expect(result.complete).toBe(true);
    expect(new Set(result.deps)).toEqual(
      new Set([path.join(dir, "util.ts"), path.join(dir, "src/a.ts")]),
    );
  });

  it("degrades instead of throwing on a tsconfig tsc would reject", () => {
    // createPathsMatcher enforces the same validations tsc does (TS5090
    // non-relative substitution without baseUrl, multi-star patterns). A
    // stray invalid tsconfig anywhere in the crawled tree must mark the
    // graph incomplete, not crash the build.
    const ts5090 = project({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@x/*": ["src/x/*"] } },
      }),
      "entry.ts": `import { z } from "zod";\nexport const S = z.string();`,
    });
    const multiStar = project({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@x/*/*": ["src/*"] } },
      }),
      "entry.ts": `import { z } from "zod";\nexport const S = z.string();`,
    });
    for (const dir of [ts5090, multiStar]) {
      const entry = path.join(dir, "entry.ts");
      expect(() => collectStaticDeps(entry)).not.toThrow();
      expect(collectStaticDeps(entry).complete).toBe(false);
    }
  });

  it("distrusts a paths alias whose targets are all missing", () => {
    const dir = project({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } },
      }),
      "entry.ts": `import { a } from "@lib/missing";\nexport const x = a;`,
    });
    const result = collectStaticDeps(path.join(dir, "entry.ts"));
    expect(result.complete).toBe(false);
  });

  it("covers export-from and side-effect imports", () => {
    const dir = project({
      "entry.ts": `export * from "./a";\nimport "./effects";`,
      "a.ts": `export const a = 1;`,
      "effects.ts": `globalThis.x = 1;`,
    });
    const result = collectStaticDeps(path.join(dir, "entry.ts"));
    expect(result.complete).toBe(true);
    expect(result.deps.sort()).toEqual(
      [path.join(dir, "a.ts"), path.join(dir, "effects.ts")].sort(),
    );
  });

  it("marks graphs with non-literal dynamic imports incomplete", () => {
    const dir = project({
      "entry.ts": `const name = "./a";\nexport const load = () => import(name);`,
      "a.ts": `export const a = 1;`,
    });
    expect(collectStaticDeps(path.join(dir, "entry.ts")).complete).toBe(false);
  });

  it("detects dynamic imports independently per file (no shared regex state)", () => {
    // Regression: DYNAMIC_CALL was a /g regex whose .test() resumed from the
    // previous file's lastIndex — a long file matching late made the next
    // (shorter) file's dynamic import invisible, recording a falsely-complete
    // dep set.
    const dirA = project({
      "entry.ts": `${"// padding\n".repeat(80)}const m = "./a";\nexport const load = () => import(m);`,
    });
    const dirB = project({
      "entry.ts": `const m = "./b";\nexport const load = () => import(m);`,
    });
    expect(collectStaticDeps(path.join(dirA, "entry.ts")).complete).toBe(false);
    expect(collectStaticDeps(path.join(dirB, "entry.ts")).complete).toBe(false);
  });

  it("treats specifiers that traverse through a file as unresolvable (no throw)", () => {
    // Probing `a.ts/nested.ts` stats through a FILE → ENOTDIR, which
    // throwIfNoEntry does not suppress — must be caught, not crash.
    const dir = project({
      "entry.ts": `import "./a.ts/nested";`,
      "a.ts": `export const a = 1;`,
    });
    expect(collectStaticDeps(path.join(dir, "entry.ts")).complete).toBe(false);
  });

  it("returns identical results across repeated calls (memoized edges)", () => {
    const dir = project({
      "entry.ts": `import { a } from "./a.js";\nimport { b } from "./b";\nexport const x = a + b;`,
      "a.ts": `export const a = 1;`,
      "b.ts": `import { a } from "./a.js";\nexport const b = 2;`,
    });
    const first = collectStaticDeps(path.join(dir, "entry.ts"));
    const second = collectStaticDeps(path.join(dir, "entry.ts"));
    expect(first.complete).toBe(true);
    expect(new Set(first.deps)).toEqual(new Set([path.join(dir, "a.ts"), path.join(dir, "b.ts")]));
    expect(second).toEqual(first);
  });

  it("follows literal dynamic imports and stays complete", () => {
    const dir = project({
      "entry.ts": `export const load = () => import("./lazy");`,
      "lazy.ts": `export const lazy = 1;`,
    });
    const result = collectStaticDeps(path.join(dir, "entry.ts"));
    expect(result.complete).toBe(true);
    expect(result.deps).toEqual([path.join(dir, "lazy.ts")]);
  });

  it("marks unresolvable relative specifiers incomplete", () => {
    const dir = project({
      "entry.ts": `import { gone } from "./missing";`,
    });
    expect(collectStaticDeps(path.join(dir, "entry.ts")).complete).toBe(false);
  });

  it("strips resource query suffixes", () => {
    const dir = project({
      "entry.ts": `import logo from "./logo.svg?url";`,
      "logo.svg": `<svg/>`,
    });
    const result = collectStaticDeps(path.join(dir, "entry.ts"));
    expect(result.complete).toBe(true);
    expect(result.deps).toEqual([path.join(dir, "logo.svg")]);
  });

  it("re-scans when a file changes (mtime-validated memo)", () => {
    const dir = project({
      "entry.ts": `import "./a";`,
      "a.ts": `export const a = 1;`,
    });
    const entry = path.join(dir, "entry.ts");
    expect(collectStaticDeps(entry).deps).toEqual([path.join(dir, "a.ts")]);
    // rewrite entry to drop the import; force a different mtime
    writeFileSync(entry, `export const standalone = 1;`);
    const future = Date.now() / 1000 + 5;
    const fsMod = require("node:fs") as typeof import("node:fs");
    fsMod.utimesSync(entry, future, future);
    expect(collectStaticDeps(entry).deps).toEqual([]);
  });
});

describe("transformDependencies()", () => {
  it("reports the entry first, then its static closure", () => {
    const dir = project({
      "entry.ts": `import { a } from "./a";\nexport const x = a;`,
      "a.ts": `export const a = 1;`,
    });
    const entry = path.join(dir, "entry.ts");

    const result = transformDependencies(entry);
    expect(result.complete).toBe(true);
    expect(result.files[0]).toBe(entry);
    expect(result.files).toEqual([entry, path.join(dir, "a.ts")]);
  });

  it("resolves a relative id before crawling", () => {
    const dir = project({ "entry.ts": `export const x = 1;` });
    const entry = path.join(dir, "entry.ts");
    const relative = path.relative(process.cwd(), entry);

    expect(transformDependencies(relative)).toEqual({ files: [entry], complete: true });
  });

  /**
   * The point of the flag: an unanalyzable graph must not be reported as a
   * usable dependency list. Papering over it with the process-global executed
   * -modules superset would be unsound — that set is point-in-time, so an
   * unrelated file's discovery can leave it describing the wrong graph.
   */
  it("reports complete: false rather than guessing when the graph is unanalyzable", () => {
    const dir = project({
      "entry.ts": `const which = process.env.WHICH;\nexport const m = import(which!);`,
    });
    const entry = path.join(dir, "entry.ts");

    expect(collectStaticDeps(entry).complete).toBe(false);
    expect(transformDependencies(entry)).toEqual({ files: [entry], complete: false });
  });

  it("never repeats the entry, whatever spelling the caller used", () => {
    const dir = project({
      "entry.ts": `import { a } from "./a";\nexport const x = a;`,
      "a.ts": `import { x } from "./entry";\nexport const a = 1;`,
    });
    const entry = path.join(dir, "entry.ts");

    // a.ts imports back, so the entry is reachable from its own closure.
    const { files } = transformDependencies(entry);
    expect(files).toEqual([...new Set(files)]);
    expect(files.filter((f) => f === entry)).toHaveLength(1);
  });

  it("normalizes a symlinked entry to the same spelling the closure uses", () => {
    const dir = project({
      "entry.ts": `import { a } from "./a";\nexport const x = a;`,
      "a.ts": `export const a = 1;`,
    });
    const link = path.join(ROOT, `link${n++}`);
    symlinkSync(dir, link, "dir");

    const { files } = transformDependencies(path.join(link, "entry.ts"));
    // Every path realpath'd through the symlink, so no file appears twice.
    expect(files).toEqual([path.join(dir, "entry.ts"), path.join(dir, "a.ts")]);
  });
});
