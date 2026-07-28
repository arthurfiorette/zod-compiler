import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    conditions: ["source"],
    // Explicit alias: the test pipeline does not reliably honor custom
    // conditions for `#`-subpath imports, and the package-imports fallback
    // would resolve #src through a (possibly stale) dist build.
    alias: {
      "#src": path.resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
    },
    server: {
      deps: {
        inline: ["zod"],
      },
    },
  },
  pack: {
    entry: ["src/**/*.ts"],
    format: ["esm"],
    unbundle: true,
    sourcemap: true,
    dts: {
      sourcemap: true,
    },
    fixedExtension: false,
    target: "es2022",
    deps: {
      neverBundle: true,
    },
    logLevel: "warn",
    publint: true,
    report: false,
  },
  run: {
    tasks: {
      ci: {
        command: ["vp pack", "vp check", "knip", "vp test"],
        input: [
          { auto: true },
          "!.tmp/**",
          "!node_modules/.cache/**",
          "!node_modules/.modules.yaml",
          "!node_modules/.vite/vitest",
          "!node_modules/.vite/vitest/**",
          "!tests/fixtures/.*",
          "!tests/fixtures/.*/**",
          "!tests/fixtures/__*",
          "!tests/fixtures/__*/**",
        ],
        output: [
          { auto: true },
          "!.tmp/**",
          "!node_modules/.cache/**",
          "!node_modules/.modules.yaml",
          "!node_modules/.vite/vitest",
          "!node_modules/.vite/vitest/**",
          "!tests/fixtures/.*",
          "!tests/fixtures/.*/**",
          "!tests/fixtures/__*",
          "!tests/fixtures/__*/**",
        ],
      },
    },
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    useTabs: false,
    tabWidth: 2,
    printWidth: 100,
    singleQuote: false,
    jsxSingleQuote: false,
    quoteProps: "as-needed",
    trailingComma: "all",
    semi: true,
    arrowParens: "always",
    bracketSameLine: false,
    bracketSpacing: true,
    ignorePatterns: [
      "node_modules",
      "dist",
      "**/dist",
      "coverage",
      "*.compiled.ts",
      "*.compiled.js",
      ".agents",
      ".claude",
      "**/.next",
    ],
  },
  lint: {
    plugins: ["import", "typescript", "unicorn", "oxc", "promise"],
    categories: {
      correctness: "error",
    },
    rules: {
      "no-unused-vars": "error",
      "no-undef": "off",
      "typescript/no-explicit-any": "error",
      "no-empty": "error",
      "no-console": "warn",
      "no-var": "error",
      "import/no-cycle": "warn",
      "prefer-const": "error",
      "typescript/consistent-type-imports": [
        "error",
        {
          disallowTypeAnnotations: false,
        },
      ],
      "no-param-reassign": "error",
      "typescript/no-non-null-assertion": "warn",
      "typescript/no-namespace": "error",
      "no-else-return": "warn",
      "typescript/prefer-as-const": "error",
      "unicorn/no-static-only-class": "warn",
      "typescript/no-useless-empty-export": "error",
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": "error",
      "typescript/no-implied-eval": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    overrides: [
      {
        files: ["src/**", "tests/**"],
        rules: {
          "import/no-nodejs-modules": "error",
        },
      },
      {
        files: [
          "src/cli/**",
          "src/loader.ts",
          "src/swc.ts",
          "src/static-filter.ts",
          "tests/cli/**",
          "tests/discovery.test.ts",
          "tests/loader.test.ts",
          "tests/swc.test.ts",
          "src/unplugin/**",
          "tests/unplugin/**",
          "tests/zod-version.ts",
        ],
        rules: {
          "import/no-nodejs-modules": "off",
        },
      },
      {
        files: ["src/core/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["#src/cli/**", "#src/unplugin/**", "#src/discovery.*", "#src/loader.*"],
                  message: "core/ must not depend on cli/, unplugin/, discovery, or loader",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["src/cli/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["#src/unplugin/**"],
                  message: "cli/ must not depend on unplugin/",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["src/unplugin/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["#src/cli/**"],
                  message: "unplugin/ must not depend on cli/",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["apps/hono/**"],
        globals: {
          Bun: "readonly",
        },
      },
    ],
    ignorePatterns: [
      "node_modules",
      "dist",
      "**/dist",
      "**/*.compiled.ts",
      "**/*.compiled.js",
      "**/.next",
      "smoke/node_modules",
      "tests/fixtures",
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
});
