# zod-compiler

**Compile Zod schemas into zero-overhead validation functions at build time.**

Keep your existing Zod schemas. Get **2-43x faster** validation. No code changes required.

- [What Gets Compiled](#what-gets-compiled)
- [Schema Hoisting](#schema-hoisting)
- [Benchmark](#benchmark)

> [!NOTE]
> zod-compiler has been tested to work in large projects with tens of thousands of Zod schemas.

## Usage

There are three ways to use zod-compiler. Choose the one that fits your project.

### 1. Automatic Mode (Default)

The plugin automatically detects and compiles all exported Zod schemas at build time. No wrappers, no imports from `zod-compiler` in your source code.

**vite.config.ts:**

```typescript
import zodCompiler from "zod-compiler/vite";

export default defineConfig({
  plugins: [zodCompiler()],
});
```

**Your schema file stays pure Zod:**

```typescript
// src/schemas.ts
import { z } from "zod";

export const CreateUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.email(),
  role: z.enum(["admin", "editor", "viewer"]),
});
```

Use them as usual. Compiled methods are installed on the original schema object, so `.shape`, `._zod`,
Standard Schema, `instanceof` and `z.toJSONSchema()` keep working and consumers need no changes.

Compiled schemas also expose **`.is(input): input is T`** — the compiled check itself, allocating
nothing. A drop-in replacement for `safeParse(x).success`.

### 2. compile() (Explicit)

If you prefer explicit opt-in, wrap specific schemas with `compile()`:

```typescript
import { z } from "zod";
import { compile } from "zod-compiler";

const UserSchema = z.object({
  name: z.string().min(3),
  email: z.email(),
});

export const validateUser = compile(UserSchema);

// In dev: falls back to Zod's runtime validation
// After build: uses AOT-compiled optimized code
validateUser.parse(data);
validateUser.safeParse(data);
```

`compile()` and auto mode coexist — `compile()` schemas are detected first, then every remaining plain Zod export is picked up. To make `compile()` the _only_ path (no automatic detection, no build-time execution of plain schema files), pair it with `schemas: "explicit"` in the plugin options.

### 3. CLI (No Bundler)

Generate optimized validation files from the command line:

```bash
# Single file
npx zod-compiler generate src/schemas.ts -o src/schemas.compiled.ts

# Directory
npx zod-compiler generate src/ -o src/compiled/

# Watch mode
npx zod-compiler generate src/ --watch

# Only compile() calls (skip plain exports); minimal methods-only output
npx zod-compiler generate src/ --schemas explicit --emit bag

# Compact output: fast path only, cold errors delegated to Zod (~70% smaller)
npx zod-compiler generate src/ --emit compact
```

## Build Plugin

### Supported Build Tools

| Build Tool | Import                                            |
| ---------- | ------------------------------------------------- |
| Vite       | `import zodCompiler from "zod-compiler/vite"`     |
| webpack    | `import zodCompiler from "zod-compiler/webpack"`  |
| esbuild    | `import zodCompiler from "zod-compiler/esbuild"`  |
| SWC        | `import zodCompiler from "zod-compiler/swc"`      |
| Rollup     | `import zodCompiler from "zod-compiler/rollup"`   |
| Rolldown   | `import zodCompiler from "zod-compiler/rolldown"` |
| Rsbuild    | `import zodCompiler from "zod-compiler/rsbuild"`  |
| rspack     | `import zodCompiler from "zod-compiler/rspack"`   |
| Bun        | `import zodCompiler from "zod-compiler/bun"`      |
| Farm       | `import zodCompiler from "zod-compiler/farm"`     |

### Options

| Option        | Type                             | Default         | Description                                                                                                 |
| ------------- | -------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------- |
| `schemas`     | `"auto" \| "explicit"`           | `"auto"`        | `"auto"` compiles every exported schema (and hoisted in-function ones); `"explicit"` only `compile()` calls |
| `include`     | `string[]`                       | —               | Only process files matching these path globs                                                                |
| `exclude`     | `string[]`                       | —               | Skip files matching these path globs                                                                        |
| `output`      | `"schema" \| "bag" \| "compact"` | `"schema"`      | What a compiled export evaluates to — see [Compact Output](#compact-output-output-compact)                  |
| `verbose`     | `boolean`                        | `false`         | Log per-schema compilation status                                                                           |
| `hoist`       | `boolean`                        | `true`          | Move schemas built inside functions to module scope — see [Schema Hoisting](#schema-hoisting)               |
| `apply`       | `"build" \| "serve" \| "all"`    | builds + Vitest | **Vite only**: when the plugin runs                                                                         |
| `codegenMode` | `"lean" \| "inline"`             | auto            | `"inline"` emits helpers per file; needed for transpile-only esbuild — see [SWC](#swc)                      |
| `cache`       | `boolean \| string`              | `true`          | Persistent transform cache in `node_modules/.cache/zod-compiler`                                            |

```typescript
zodCompiler({
  include: ["src/schemas"],
  verbose: true,
});
```

**rsbuild.config.ts:**

```typescript
import { defineConfig } from "@rsbuild/core";
import zodCompiler from "zod-compiler/rsbuild";

export default defineConfig({
  plugins: [zodCompiler()],
});
```

> **Note:** Vitest is detected automatically (via the `VITEST` env var), so
> tests compile and exercise the same validators that ship to production —
> including their performance. Pass `apply: "build"` if you want tests to use
> the plain Zod fallback instead.

### Bun

zod-compiler is a build-time tool, so on Bun it applies wherever your code passes through a build step.
Requires **Bun ≥ 1.2.22**.

```typescript
import zodCompiler from "zod-compiler/bun";

await Bun.build({ entrypoints: ["./src/index.tsx"], outdir: "./dist", plugins: [zodCompiler()] });
```

For code run straight from source (`bun run src/server.ts`) no build plugin fires — use the
[CLI](#3-cli-no-bundler) to compile ahead of time.

### Schema Hoisting

Schemas built inside functions are rebuilt on every call. With `hoist` (on by default) they move to
module scope:

```typescript
// before                                  // after
function getSchema() {
  const _zh_94b7 = z.object({ name: z.string() });
  return z.object({ name: z.string() });
  function getSchema() {}
  return _zh_94b7;
}
```

Only expressions built from imported bindings and literals move; anything touching locals, `this` or
`new Date()` stays put. Combinator chains on imported schemas qualify via `schemaNamePattern`
(default `/ZodSchema$/`).

In auto mode hoisted schemas also **compile** — which rescues the schema that never leaves a function
(a slonik query, a tRPC input), invisible to export scanning. Measured on that pattern: ~16,700 ns →
~14 ns per call.

### Bundle Size & Cross-File Dedup

Validators share a runtime helper layer imported from one module, so each helper appears once per
bundle. Schemas in a file sharing a structurally identical sub-shape emit its error walk once, which
scales with how much a file repeats: **19% raw / 10% gzipped** for two exports reusing one nested
shape, **28% / 18%** for four exports reusing two.

**Transpile-only esbuild builds** (no `--bundle`) never fire the bundler's resolve hooks, so the
`virtual:` specifier would survive into `dist/` and fail at runtime. Set `codegenMode: "inline"` to emit
helpers per file instead:

```typescript
export default [zodCompiler({ schemas: "explicit", codegenMode: "inline" })];
```

Set `output: "bag"` to also drop the retained Zod schema when you don't need `.shape` / `instanceof`.

### SWC

`zod-compiler/swc` is a programmatic `@swc/core` bridge, not a `.swcrc` WASM plugin — discovery needs
Node.js, so it wraps `transform()`. Install `@swc/core`, then:

```typescript
import { transform } from "zod-compiler/swc";

const result = await transform(sourceCode, {
  filename: "src/schemas.ts",
  swc: { jsc: { parser: { syntax: "typescript" } } },
});
```

Defaults `codegenMode` to `"inline"` (SWC has no virtual-module hook); pass
`zodCompiler: { codegenMode: "lean" }` if a later bundler resolves the runtime specifier. Honours
`include`/`exclude` and keeps no disk cache.

### Compact Output (`output: "compact"`)

The error-collecting walk is 64–77% of the generated bytes, and it only reproduces Zod's issues on
failure — which the retained Zod schema already does. `output: "compact"` (CLI: `--emit compact`)
compiles the fast path and delegates the cold error path to it.

On 50 distinct schemas, output drops **~73% raw / ~71% gzipped**. The hot path is unchanged, errors are
Zod's own, and `safeParse(x).success` / `.is(x)` never invoke Zod — only reading `.error` does. Mutation
schemas keep the compiled path. Mutually exclusive with `output: "bag"`.

### Auto Mode: Side Effects Warning

Auto mode executes files to inspect their exports, so a file with schema-shaped exports **and** side
effects runs them at build time. Limit the scan with `include`.

For the common `env.ts` that validates `process.env` and exits, zod-compiler sets
`process.env.ZOD_COMPILER` during discovery and intercepts `process.exit`, so the build never crashes —
those files just fall back to runtime Zod. To keep them compiled, guard on it:

```typescript
if (!process.env.ZOD_COMPILER) {
  // ...validate and exit
}
```

With `@t3-oss/env-*`, pass `skipValidation: !!process.env.ZOD_COMPILER`.

### schemas: "auto" vs "explicit"

|                              | `"auto"` (default)                                         | `"explicit"` + compile()                    |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| Source code changes          | None                                                       | Wrap each schema                            |
| `zod-compiler` import needed | No                                                         | Yes                                         |
| What gets compiled           | All exported Zod schemas                                   | Only wrapped schemas                        |
| Build-time file execution    | Zod-importing files that may export schemas (pre-filtered) | Files with `import ... from "zod-compiler"` |
| Best for                     | New projects, framework integration                        | Gradual adoption, selective optimization    |

### Large projects and CI

Discovery executes each schema file inside the bundler's process, so the **first cold run** is the
expensive one — later runs hit the persistent cache.

```yaml
- uses: actions/cache@v4
  with:
    path: node_modules/.cache/zod-compiler
    key: zod-compiler-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
```

Cache entries self-validate against dependency hashes, so a stale cache can only cause recompiles.
Scope discovery with `include`; set `ZOD_COMPILER_TIMING=1` to see per-phase wall time. Files that never
mention `zod` cost nothing.

## Framework Examples

Nothing framework-specific is needed. In auto mode your exported schemas are compiled in place, so
anything that accepts a Zod schema keeps working and picks up the compiled version:

```typescript
// tRPC — no .input(compile(...)) needed
t.procedure.input(CreateUserSchema).mutation(({ input }) => createUser(input));

// Hono
app.post("/users", zValidator("json", UserSchema), (c) => c.json(c.req.valid("json")));

// React Hook Form
useForm({ resolver: zodResolver(SignupSchema) });
```

The same applies to any [Standard Schema](https://standardschema.dev) consumer. `~standard.validate`
is re-installed on top of the compiled path — Zod's own builds it around its internal parse, so
leaving it alone would have handed these consumers plain Zod. Its `version`/`vendor` are unchanged,
and an async refinement still resolves through Zod.

## Schema Diagnostics

Analyze your schemas before compiling — check coverage, Fast Path eligibility, and get actionable hints:

```bash
npx zod-compiler check src/schemas.ts
```

Output:

```
src/schemas.ts

  CreateUserSchema — 100% compiled (4/4 nodes) | Fast Path: eligible
    └─ ✓ object
       ├─ ✓ string .name
       ├─ ✓ string .email
       ├─ ✓ number .age
       └─ ✓ enum .role

  OrderSchema — 67% compiled (2/3 nodes) | Fast Path: ineligible (fallback (transform))
    └─ ✓ object
       ├─ ✓ string .id
       └─ ✓ object .metadata
          ├─ ✓ string .metadata.region
          └─ ✗ fallback .metadata.audit (transform)
                hint: Extract transform into a separate post-processing step

    Fallbacks:
      ✗ .metadata.audit — transform
        Extract transform into a separate post-processing step
```

### CI Integration

```bash
# JSON output
npx zod-compiler check src/schemas.ts --json

# Fail if any schema below 80% coverage
npx zod-compiler check src/schemas.ts --json --fail-under 80
```

| Flag                 | Description                             |
| -------------------- | --------------------------------------- |
| `--json`             | Structured JSON output                  |
| `--fail-under <pct>` | Exit code 1 if coverage below threshold |
| `--no-color`         | Disable colored output                  |

## What Gets Compiled

### Fully Compiled (2-43x faster)

Every Zod type except the fallbacks below — all primitives, `object` / `strictObject` / `looseObject`,
`array`, `tuple`, `record`, `set`, `map`, `union`, `discriminatedUnion`, `intersection`, `pipe`,
the `optional` / `nullable` / `readonly` / `default` / `catch` / `coerce` wrappers, `templateLiteral`,
recursive `lazy` (self, mutual and nested), and `transform` / `refine` / `superRefine`.

All standard checks are supported: `min`, `max`, `length`, `email`, `uuid`, `regex`, `int`, `positive`,
`multipleOf`, `includes`, `startsWith`, and the rest.

### Falls Back to Zod (Still Works, Not Faster)

A schema delegates to Zod when it reaches JavaScript the generated code cannot reproduce:

| Construct                                   | Why                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `.check(fn)`, `superRefine` + later checks  | The callback holds Zod's payload unmediated, or `fatal` aborts Zod's chain |
| `ctx`-taking or `async` transforms          | Needs Zod's parse context / the async pipeline                             |
| `z.custom()`, `z.instanceof()`              | No extractor yet                                                           |
| `z.url()`, `z.jwt()`                        | Algorithmic formats (`new URL()`, signature parsing)                       |
| Object intersections                        | Zod parses both sides and merges; the compiler cannot reproduce the merge  |
| Dynamic error maps, unresolvable `z.lazy()` | Not knowable at build time                                                 |

Everything else compiles, including `transform`/`refine`/`superRefine` whether or not the callback
captures — a zero-capture one is inlined, a capturing one called by reference. Delegation is
per-sub-schema: one uncompilable field goes to Zod, not the whole object. Run `zod-compiler check` to
see what compiled.

### Behavioral Differences from Zod

Compiled validators match Zod on verdicts, output data and error messages, including issue ordering.
Two things differ by design, both from the zero-allocation fast path:

| Behavior                  | Zod                                | zod-compiler                                            |
| ------------------------- | ---------------------------------- | ------------------------------------------------------- |
| Record key iteration      | All own keys (`Reflect.ownKeys`)   | Own enumerable **string** keys only                     |
| Container output identity | A fresh array / set / map / object | The input container, by reference (array holes survive) |

A container whose contents need no rewriting is validated in place and handed back, where Zod always
rebuilds it. `z.object()` is the exception — it strips unknown keys exactly as Zod does, so its output
is always a fresh object.

## Benchmark

5-way comparison: **Zod v3** vs **Zod v4** vs **zod-compiler** vs **[Typia](https://typia.io/)** vs **[AJV](https://ajv.js.org/)**

| Scenario                                        | Zod v3 | Zod v4 | **zod-compiler** | Typia | AJV   | vs Zod v4 |
| ----------------------------------------------- | ------ | ------ | ---------------- | ----- | ----- | --------- |
| simple string                                   | 12.6M  | 14.3M  | **16.5M**        | 17.8M | 17.6M | 1.2x      |
| string (min/max)                                | 12.5M  | 7.5M   | **15.9M**        | 17.0M | 15.2M | 2.1x      |
| number (int+positive)                           | 12.3M  | 7.8M   | **16.6M**        | 16.8M | 17.3M | 2.1x      |
| enum                                            | 11.7M  | 12.1M  | **16.2M**        | 17.7M | 17.3M | 1.3x      |
| bigint (min/max)                                | 12.0M  | 7.7M   | **15.9M**        | —     | —     | 2.1x      |
| tuple [string, int, bool]                       | 5.8M   | 6.5M   | **15.7M**        | 17.1M | 16.3M | 2.4x      |
| record\<string, number\>                        | 3.2M   | 2.8M   | **15.2M**        | 12.1M | 15.2M | 5.5x      |
| set\<string\> (5 items)                         | 3.7M   | 2.3M   | **14.7M**        | —     | —     | 6.4x      |
| set\<string\> (20 items)                        | 1.3M   | 683K   | **12.0M**        | —     | —     | **18x**   |
| map\<string, number\> (5 entries)               | 2.1M   | 1.4M   | **13.1M**        | —     | —     | 9.6x      |
| map\<string, number\> (20 entries)              | 635K   | 362K   | **8.3M**         | —     | —     | **23x**   |
| pipe (non-transform)                            | 8.6M   | 5.6M   | **15.9M**        | —     | —     | 2.8x      |
| discriminatedUnion (3 variants)                 | 3.3M   | 4.0M   | **15.8M**        | 15.5M | 7.7M  | 4.0x      |
| discriminatedUnion (8 variants, rotating)       | 2.7M   | 3.4M   | **9.2M**         | —     | —     | 2.7x      |
| plain union of 8 tagged objects (auto-discrim.) | 363K   | 632K   | **9.1M**         | —     | —     | **14x**   |
| strict object (DB row)                          | 1.8M   | 3.1M   | **10.9M**        | —     | —     | 3.5x      |
| medium object (valid)                           | 1.9M   | 2.4M   | **9.7M**         | 11.2M | 7.7M  | 4.1x      |
| medium object (extra keys stripped)             | 1.8M   | 2.3M   | **9.4M**         | —     | —     | 4.2x      |
| medium object (invalid)                         | 504K   | 80K    | **14.7M**        | 2.9M  | 7.7M  | **184x**  |
| large object (10 items)                         | 122K   | 166K   | **5.3M**         | 5.9M  | 1.2M  | **32x**   |
| large object (100 items)                        | 13K    | 18K    | **781K**         | 1.3M  | 125K  | **43x**   |
| recursive tree (7 nodes)                        | 569K   | 2.1M   | **8.2M**         | 11.6M | 4.8M  | 3.9x      |
| recursive tree (121 nodes)                      | 32K    | 135K   | **800K**         | 1.9M  | 372K  | 5.9x      |
| nested recursion (7 nodes)                      | 391K   | 1.0M   | **7.9M**         | 11.1M | 3.1M  | 7.8x      |
| nested recursion (121 nodes)                    | 24K    | 62K    | **818K**         | 1.6M  | 218K  | **13x**   |
| deeply nested object (243 leaves)               | 11K    | 20K    | **828K**         | 1.1M  | 117K  | **42x**   |
| event log (combined)                            | 368K   | 609K   | **8.2M**         | —     | —     | **13x**   |
| object with transform (zero-capture)            | 1.2M   | 1.9M   | **6.5M**         | —     | —     | 3.4x      |
| array 10 × transform (zero-capture)             | 121K   | 214K   | **4.2M**         | —     | —     | **20x**   |
| array 50 × transform (zero-capture)             | 25K    | 44K    | **1.0M**         | —     | —     | **24x**   |
| object with captured transform                  | 1.4M   | 6.3M   | **15.1M**        | —     | —     | 2.4x      |
| object with captured refine (cross-field)       | 1.6M   | 2.4M   | **15.3M**        | —     | —     | 6.3x      |
| object with superRefine (cross-field)           | 1.6M   | 2.3M   | **11.6M**        | —     | —     | 5.0x      |

_ops/s, higher is better. `vitest bench` on an Apple M4 Max (zod 4.3.6, zod v3 3.23.8, typia 12, ajv 8),
best of three runs. The harness costs ~55 ns per iteration, so the fastest rows sit at that floor and gaps
between the AOT columns there are noise, not real._

Nested objects, arrays and recursive types gain the most. Rejection is fast because a failed
`safeParse` defers building the error until `.error` is read.

```bash
pnpm benchmark   # run locally
```

### Performance Architecture

An eligible schema compiles to a **fast path** — one `&&` chain validating the whole input with zero
allocations, reused by `.is()` and `parse()` — plus a **slow path** that collects errors, run only on
failure and deferred until `.error` is read. A `z.object()` strips, so it instead compiles to a single
pass that validates and rebuilds together, bailing on the first failure. That pass also covers the
idioms that reshape a value — array size checks, `.refine()`, `.default()`, `.trim()`, `.transform()` —
so one of them in a schema no longer costs it the whole single-pass parse.

Regexes are pre-compiled with bounded repeats unrolled, checks run cheapest-first, discriminated unions
dispatch through a jump table (plain tagged unions are auto-discriminated into it), and oversized check
functions are split to stay within V8's optimizer budget.

## Development

```bash
pnpm install
pnpm test
pnpm benchmark
pnpm lint
```

## Acknowledgements

zod-compiler started as a fork of [zod-aot](https://github.com/wakita181009/zod-aot) by [@wakita181009](https://github.com/wakita181009).
