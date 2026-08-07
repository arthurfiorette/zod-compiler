import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
  ALL_HELPER_NAMES,
  loadVirtual,
  RESOLVED_RUNTIME_ID,
  resolveVirtualId,
  RUNTIME_PACKAGE_ID,
  RUNTIME_SOURCE,
  VIRTUAL_RUNTIME_ID,
  WP_RUNTIME_ID,
} from "#src/unplugin/virtual.js";
import pkg from "../../package.json" with { type: "json" };

const distRuntime = path.resolve(import.meta.dirname, "../../dist/runtime.js");

describe("unplugin/virtual", () => {
  describe("resolveVirtualId", () => {
    it("returns the resolved id (\\0-prefixed) for the public virtual id", () => {
      expect(resolveVirtualId(VIRTUAL_RUNTIME_ID)).toBe(RESOLVED_RUNTIME_ID);
    });

    it("returns the same resolved id for the webpack/rspack bare-specifier alias", () => {
      expect(resolveVirtualId(WP_RUNTIME_ID)).toBe(RESOLVED_RUNTIME_ID);
    });

    it("returns null for any other id", () => {
      expect(resolveVirtualId("zod")).toBeNull();
      expect(resolveVirtualId("./schemas.ts")).toBeNull();
      expect(resolveVirtualId(RESOLVED_RUNTIME_ID)).toBeNull();
    });
  });

  describe("loadVirtual", () => {
    it("returns ESM source for the resolved id", () => {
      const src = loadVirtual(RESOLVED_RUNTIME_ID);
      expect(src).not.toBeNull();
      expect(src).toContain("export function __zcMkv");
      expect(src).toContain("export function __zcFin");
    });

    it("returns null for unrelated ids", () => {
      expect(loadVirtual(VIRTUAL_RUNTIME_ID)).toBeNull();
      expect(loadVirtual("zod")).toBeNull();
    });

    it("exports EVERY name in ALL_HELPER_NAMES (no registry/source skew)", () => {
      // Regression: __zcUK was added to ISSUE_DECLS (→ ALL_HELPER_NAMES → the
      // imports codegen emits) while buildRuntimeSource enumerated decl
      // constants by hand — every consumer bundle failed with MISSING_EXPORT.
      // The registries are the single source of truth; this asserts the
      // source agrees with them name for name.
      const src = loadVirtual(RESOLVED_RUNTIME_ID) ?? "";
      const exported = new Set(
        [...src.matchAll(/export (?:function|const) ([\w$]+)/g)].map((m) => m[1]),
      );
      for (const name of ALL_HELPER_NAMES) {
        expect(exported.has(name), `helper not exported by runtime source: ${name}`).toBe(true);
      }
      // ...and nothing is exported that tooling doesn't know about.
      for (const name of exported) {
        if (name === "__zcMsg") continue; // module-internal locale binding
        expect(ALL_HELPER_NAMES, `export missing from ALL_HELPER_NAMES: ${name}`).toContain(name);
      }
    });

    it("exports each well-known regex constant", () => {
      const src = loadVirtual(RESOLVED_RUNTIME_ID) ?? "";
      for (const name of ["__zcReEmail", "__zcReUuid", "__zcReCuid2", "__zcReIpv4"]) {
        expect(src, `missing regex export: ${name}`).toMatch(
          new RegExp(`export const ${name}=new RegExp\\(`),
        );
      }
    });
  });

  describe("RUNTIME_PACKAGE_ID", () => {
    it("is the real package subpath, resolvable without any bundler hook", () => {
      // Lean-mode output emits this verbatim; if it stops matching the exports
      // map, every loader-host bundle fails to resolve it.
      expect(RUNTIME_PACKAGE_ID).toBe("zod-compiler/runtime");
      const exports = pkg.exports as Record<string, { import?: string }>;
      expect(exports["./runtime"]?.import).toBe("./dist/runtime.js");
    });

    it("is NOT intercepted by the resolveId hook", () => {
      // The other two ids resolve to nothing without the hook, so answering
      // them is free. This one already resolves — and to a specific copy, which
      // may be a newer nested zod-compiler whose runtime exports helpers this
      // version has never heard of. Hijacking it would fail that build.
      expect(resolveVirtualId(RUNTIME_PACKAGE_ID)).toBeNull();
    });

    /**
     * The shipped file is a BUILD ARTIFACT: vite.config.ts writes it from
     * RUNTIME_SOURCE during `vp pack`. Comparing RUNTIME_SOURCE to itself would
     * prove nothing, so this reads dist — skipped on a tree that was never
     * built, and always present in CI, where `vp pack` precedes `vp test`.
     */
    describe.skipIf(!existsSync(distRuntime))("dist/runtime.js", () => {
      it("is the source the virtual module serves", () => {
        expect(readFileSync(distRuntime, "utf8").trimEnd()).toBe(RUNTIME_SOURCE.trimEnd());
      });

      it("exports every helper codegen can import, and nothing more", async () => {
        // The __zcUK incident in reverse: the file ships separately from the
        // registries that name the imports, so it gets its own skew check.
        const runtime = (await import(pathToFileURL(distRuntime).href)) as Record<string, unknown>;
        const exported = new Set(Object.keys(runtime).filter((name) => name !== "default"));
        expect(exported).toEqual(new Set(ALL_HELPER_NAMES));
        for (const name of ALL_HELPER_NAMES) {
          expect(runtime[name], `helper is undefined at runtime: ${name}`).toBeDefined();
        }
      });

      it("declares the same names in its .d.ts", () => {
        const source = readFileSync(distRuntime.replace(/\.js$/, ".d.ts"), "utf8");
        const declared = new Set(
          [...source.matchAll(/export declare const ([\w$]+):/g)].map((m) => m[1] as string),
        );
        expect(declared).toEqual(new Set(ALL_HELPER_NAMES));
      });
    });
  });

  describe("codegen ↔ runtime module agreement", () => {
    it("every helper lean-mode codegen registers resolves in the virtual module", async () => {
      // The other half of the skew surface: emit-issue registers helper NAMES
      // as strings (usedHelpers) that the transform turns into imports — each
      // must be a real export. Compile a kitchen sink covering every issue
      // family and cross-check.
      const { z } = await import("zod");
      const { extractSchema } = await import("#src/core/extract/index.js");
      const { generateValidator } = await import("#src/core/codegen/index.js");
      const schema = z.strictObject({
        name: z.string().min(2).max(10),
        email: z.email(),
        kind: z.enum(["a", "b"]),
        count: z.number().multipleOf(0.1),
        pair: z.tuple([z.string(), z.number()]),
      });
      const result = generateValidator(extractSchema(schema), "sink", { mode: "lean" });
      expect(result.usedHelpers.size).toBeGreaterThan(0);
      for (const helper of result.usedHelpers) {
        expect(ALL_HELPER_NAMES, `codegen registered unknown helper: ${helper}`).toContain(helper);
      }
    });
  });

  describe("ALL_HELPER_NAMES", () => {
    it("includes the wrapper, finalizer, every issue factory, and every well-known regex", () => {
      expect(ALL_HELPER_NAMES).toContain("__zcMkv");
      expect(ALL_HELPER_NAMES).toContain("__zcFin");
      expect(ALL_HELPER_NAMES).toContain("__zcTS");
      expect(ALL_HELPER_NAMES).toContain("__zcReEmail");
      expect(ALL_HELPER_NAMES).toContain("__zcReUuid");
    });

    it("contains no duplicate names", () => {
      const unique = new Set(ALL_HELPER_NAMES);
      expect(unique.size).toBe(ALL_HELPER_NAMES.length);
    });
  });
});
