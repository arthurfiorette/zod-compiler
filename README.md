# zod-compiler

**Compile Zod schemas into zero-overhead validation functions at build time.**

Keep your existing Zod schemas. Get **2-75x faster** validation. No code changes required.

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
  age: z.number().int().min(0).max(150),
  role: z.enum(["admin", "editor", "viewer"]),
});

export const UpdateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.email().optional(),
});

export const ListUsersSchema = z.object({
  page: z.number().int().min(1).optional().default(1),
  limit: z.number().int().min(1).max(100).optional().default(20),
});
```

**Use them as usual:**

```typescript
const user = CreateUserSchema.parse(data); // throws on failure
const result = CreateUserSchema.safeParse(data); // { success, data/error }
```

**Zero-allocation type guard — `.is()`:** compiled schemas also expose an `.is(input): input is T` boolean guard. For the common case (objects, primitives, arrays, enums with no `coerce`/`default`/`catch`/`transform`) this _is_ the compiled fast-check — one boolean expression, no `SafeParseResult`, no issues array — the cheapest possible "does this match?" check, on par with typia's `is<T>()` and a clean replacement for `schema.safeParse(x).success`:

```typescript
if (CreateUserSchema.is(data)) {
  data.email; // narrowed to the schema's output type
}
const valid = items.filter((x) => CreateUserSchema.is(x));
```

Schemas without a total fast path fall back to `safeParse(input).success` (still correct). The guard is also available on `compile()`-wrapped schemas (Zod's runtime fallback before the build).

At build time, the plugin:

1. Finds every file with `import ... from "zod"` (skips type-only imports)
2. Statically pre-filters: files whose exports provably can't be schemas (functions, components, constants) are skipped without ever being executed
3. Executes the remaining candidates and detects exported Zod schemas
4. Compiles each schema into an optimized validator
5. Replaces the export with a tree-shakeable IIFE that preserves the full Zod API

**What "preserves the full Zod API" means:** The optimized `parse`/`safeParse`/`parseAsync`/`safeParseAsync` methods (plus the `.is()` guard) are installed directly on the original schema object, which is exported as-is. Identity is preserved, so `._zod`, `.shape`, Standard Schema (`~standard`), `instanceof`, `.meta()` / `z.globalRegistry`, and `z.toJSONSchema()` all still work. Libraries that accept Zod schemas (tRPC, Hono, React Hook Form) work without changes.

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

# Strip unknown keys from z.object() output (matches Zod's default .parse())
npx zod-compiler generate src/ --strip-unknown-keys
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

| Option             | Type                             | Default         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | -------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemas`          | `"auto" \| "explicit"`           | `"auto"`        | How schemas are found. `"auto"`: every exported Zod schema compiles (also enables compiling hoisted in-function schemas). `"explicit"`: only `compile()`-wrapped schemas; only files importing zod-compiler execute at build time                                                                                                                                                                                                                                                  |
| `include`          | `string[]`                       | —               | Only process files matching these path globs (picomatch, matched anywhere in the path; plain substrings work too)                                                                                                                                                                                                                                                                                                                                                                  |
| `exclude`          | `string[]`                       | —               | Skip files matching these path globs (same matching rules as `include`)                                                                                                                                                                                                                                                                                                                                                                                                            |
| `output`           | `"schema" \| "bag" \| "compact"` | `"schema"`      | What a compiled export evaluates to. `"schema"`: the original Zod schema with compiled methods installed (full API preserved). `"bag"`: a minimal methods-only object — smaller bundles, breaks Zod-schema consumers. `"compact"`: like `"schema"` but only the fast path is compiled — cold errors delegate to the retained Zod schema, dropping the slow walk (~70% smaller output, hot path unchanged). See [Compact Output](#compact-output-output-compact)                    |
| `verbose`          | `boolean`                        | `false`         | Log per-schema compilation status during build                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `hoist`            | `boolean`                        | `true`          | Hoist Zod schemas defined inside function bodies to module scope so they're constructed once instead of per call (babel-plugin-zod-hoist equivalent). Only expressions built purely from imports and literals are hoisted                                                                                                                                                                                                                                                          |
| `apply`            | `"build" \| "serve" \| "all"`    | builds + Vitest | **Vite only**: when the plugin runs. By default, production builds and test runs are compiled (so tests exercise what ships); plain dev servers use the Zod fallback. `"all"` also compiles the dev server; `"build"` also skips tests                                                                                                                                                                                                                                             |
| `codegenMode`      | `"lean" \| "inline"`             | auto            | Override the codegen mode. `"lean"` (default for all supported bundlers): shared runtime helpers are imported from `virtual:zod-compiler/runtime`, which the bundler resolves via its module hooks. `"inline"`: helpers are emitted directly into each transformed file — use this for transpile-only esbuild builds (no `--bundle`) or similar setups where the bundler's hooks never fire for already-transformed output and the `virtual:` specifier would survive into `dist/` |
| `stripUnknownKeys` | `boolean`                        | `false`         | Strip unknown keys from `z.object()` output, matching Zod's default `.parse()`. Off by default (a valid object is returned by reference, keeping extras). When on, genuine `z.object()` schemas rebuild a fresh object with only the declared keys; `z.looseObject()` still keeps extras and `z.strictObject()` still rejects them. Use it to sanitize untrusted input against mass-assignment. See [Behavioral Differences](#behavioral-differences-from-zod)                     |
| `cache`            | `boolean \| string`              | `true`          | Persistent transform cache (`node_modules/.cache/zod-compiler`, or a custom directory). Skips discovery + codegen across processes when nothing changed; entries self-validate against dependency content hashes                                                                                                                                                                                                                                                                   |

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

zod-compiler is a **build-time** tool, so on Bun it compiles wherever your code
passes through a build step; everywhere else schemas still run as plain Zod
(correct, just not accelerated). The Bun plugin requires **Bun ≥ 1.2.22**.

**Bundled code** (a frontend, or a server you `bun build --target=bun` first) —
register the plugin and every exported (and hoisted) schema compiles:

```typescript
import zodCompiler from "zod-compiler/bun";

await Bun.build({
  entrypoints: ["./src/index.tsx"],
  outdir: "./dist",
  plugins: [zodCompiler()],
});
```

**Code run straight from source** (`bun run src/server.ts`) — a `Bun.build` plugin
doesn't run here, so use the [CLI](#3-cli-no-bundler) to compile ahead of time and
import the output:

```bash
bunx zod-compiler generate src/ -o src/compiled/   # add --watch during development
```

### Schema Hoisting

Schemas defined inside functions are rebuilt on every call — a hidden cost in
React components, request handlers, and helpers. With `hoist` (on by default),
the plugin moves them to module scope:

```typescript
// before
function getSchema() {
  return z.object({ name: z.string() }); // rebuilt per call
}

// after (build output)
const _zh_94b7f5c1 = z.object({ name: z.string() });
function getSchema() {
  return _zh_94b7f5c1; // built once per module
}
```

Hoisting is conservative: only expressions built purely from **imported
bindings and literals** move. Anything referencing local variables,
module-level bindings, `this`, or eagerly-evaluated globals (`new Date()`,
`Math.random()`) stays where it is — though safe globals inside callbacks
(`refine((v) => Number.isFinite(v))`) are fine, since callbacks run per parse
regardless. Inline `.parse(...)` calls are peeled so evaluation stays at the
call site (`z.string().parse(x)` → `_zh_….parse(x)`), names that are ever
shadowed (`function f(z) {...}`) disqualify hoists referencing them, and
identical schemas dedupe to a single binding.

Combinator chains on imported schemas also qualify: bases matching
`schemaNamePattern` (default `/ZodSchema$/`) or chains containing an inline
`z.*` reference (`Base.extend({ a: z.string() })`). Configure via
`hoist: { schemaNamePattern: /Shape$/ }` (string and `null` accepted).

#### Hoisted schemas compile too (auto mode)

The most common shape this rescues is a schema that never leaves a function —
a [slonik](https://github.com/gajus/slonik) query, a tRPC input, a handler-local
validator. It is not exported, so export scanning alone would never see it:

```typescript
import { pool, sql } from "./db.js";
import { z } from "zod";

const getUser = (id: number) => {
  return pool.one(
    sql.type(
      z.object({
        id: z.number(),
        name: z.string(),
      }),
    )`SELECT id, name FROM users WHERE id = ${id}`,
  );
};
```

In auto mode (the default), the build output is (verbatim, lightly trimmed):

```typescript
import { __zcFin, __zcFinD, __zcIT, __zcMkv } from "virtual:zod-compiler/runtime";
const _zh_6c9cb1a3 = /* @__PURE__ */ (() => {
  function __fc_0(input) {
    return (
      typeof input === "object" &&
      input !== null &&
      !Array.isArray(input) &&
      Number.isFinite(input["id"]) &&
      typeof input["name"] === "string"
    );
  }
  function __sw_2(input) {
    var _e = [];
    /* error-collecting walk — runs only when .error is read */ return _e;
  }
  function safeParse__zh_6c9cb1a3(input) {
    if (__fc_0(input)) {
      return { success: true, data: input };
    }
    return __zcFinD(__sw_2, input);
  }
  return __zcMkv(
    safeParse__zh_6c9cb1a3,
    z.object({
      id: z.number(),
      name: z.string(),
    }),
    __fc_0,
  );
})();
import { pool, sql } from "./db.js";
import { z } from "zod";

const getUser = (id: number) => {
  return pool.one(sql.type(_zh_6c9cb1a3)`SELECT id, name FROM users WHERE id = ${id}`);
};
```

Reading it bottom-up:

- **The real Zod schema is still constructed** (once, at module load) and is the
  object `_zh_6c9cb1a3` resolves to — `__zcMkv` installs the compiled
  `parse`/`safeParse`/`parseAsync`/`safeParseAsync` as own properties on it and
  returns it. `sql.type()` receives a genuine Zod schema (identity, `.shape`,
  `._zod`, Standard Schema all intact) whose `safeParse` happens to be compiled.
- **`__fc_0` is the Fast Path**: when slonik validates each row, a valid row
  costs one boolean chain — no per-node traversal, no allocations beyond the
  result object.
- **`__sw_2` + `__zcFinD` are the failure path**: an invalid row returns
  `{success: false}` immediately; the full error walk runs lazily only if
  `.error` is actually read.
- The `sql.type(...)` call itself stays at the call site (it closes over `id`
  via the tagged template) — only its schema argument was hoisted and compiled.

Measured on this exact pattern: schema construction + validation drops from
~16,700ns to ~14ns per call — construction amortizes to module load, and
per-row validation rides the Fast Path. With `schemas: "explicit"` the same file
still gets the plain hoist (construction once instead of per call); the
compiled IIFE requires auto mode (the default) because the schema is anonymous.

### Bundle Size & Cross-File Dedup

Generated validators share a small runtime helper layer (`__zcMkv` validator
wrapper, issue factories like `__zcTS`/`__zcIT`, and well-known regexes for
`email`, `uuid`, `cuid`, `ipv4`, etc.).

On every supported bundler the plugin imports these helpers from a single
plugin-provided runtime module — `virtual:zod-compiler/runtime` on Vite,
Rollup, Rolldown, esbuild, Farm, and Bun, or the bare-specifier alias
`__zod-compiler-runtime__` on webpack and rspack (which reject the `virtual:`
URI scheme) — so the bundler emits a single bundle-wide copy regardless of how
many files reference them.

**Transpile-only esbuild builds** (no `--bundle`, e.g. `astro-scripts build`) never invoke the bundler's `onResolve`/`onLoad` hooks for already-transformed files, so the `virtual:` specifier survives verbatim into `dist/` and Node.js rejects it at runtime with `ERR_UNSUPPORTED_ESM_URL_SCHEME`. Set `codegenMode: "inline"` to emit helpers directly into each file instead:

```typescript
import zodCompiler from "zod-compiler/esbuild";
export default [zodCompiler({ schemas: "explicit", codegenMode: "inline" })];
```

The result: a 5-file project with 10 schemas all using `z.email()` and
`z.uuid()` produces a bundle where each shared regex appears exactly **once**.
Set `output: "bag"` to additionally drop the original Zod schema reference
when you don't need `instanceof` / `.shape` access on the compiled output.

### SWC

`zod-compiler/swc` is a **programmatic `@swc/core` bridge**, not a native
`.swcrc` WASM plugin. Native SWC plugins run inside SWC's Rust/WASM plugin
runtime; zod-compiler needs Node.js at build time to execute schema modules
for discovery, so the SWC integration wraps `@swc/core.transform()` instead.

Install `@swc/core` in the consuming project:

```bash
pnpm add -D @swc/core
```

Use the default factory when you want shared SWC/zod-compiler defaults:

```typescript
import zodCompiler from "zod-compiler/swc";

const compiler = zodCompiler({
  swc: {
    jsc: {
      parser: { syntax: "typescript", tsx: true },
    },
    sourceMaps: true,
  },
  zodCompiler: {
    schemas: "auto",
  },
});

const result = await compiler.transform(sourceCode, {
  filename: "src/schemas.ts",
});
```

Or use the one-shot helper:

```typescript
import { transform } from "zod-compiler/swc";

const result = await transform(sourceCode, {
  filename: "src/schemas.ts",
  swc: {
    jsc: {
      parser: { syntax: "typescript" },
    },
  },
});
```

The bridge defaults `codegenMode` to `"inline"` because SWC does not provide
Rollup-style virtual module hooks for `virtual:zod-compiler/runtime`. If your
pipeline runs another bundler after SWC and that bundler resolves the runtime
specifier, you can opt into smaller lean output:

```typescript
await transform(sourceCode, {
  filename: "src/schemas.ts",
  zodCompiler: { codegenMode: "lean" },
});
```

The bridge honors `include`/`exclude` globs (rejected files pass through to
SWC without the zod-compiler step) and re-runs schema discovery when a
file's content changes between calls, so watch-mode hosts pick up schema
edits. It keeps no persistent disk cache — long-running hosts that want one
should key cached transform results on file content.

**Structural dedup within a file.** Beyond the shared runtime layer, schemas in
the same file that contain a structurally identical sub-tree — a reused
`Address`, a `Money` pair, an exported schema also embedded in another — emit
that shape's error-collecting walk **once** as a shared function and call it
from every occurrence. Only the cold error path is shared (it's 60–80% of the
generated bytes); the zero-allocation fast path stays fully inlined, so valid
input runs exactly as fast as before. On a realistic schema set where
`User`/`Company`/`Order`/`Invoice` reuse `Address`/`Money`/`Contact`, generated
output drops **~50% raw / ~34% gzipped** with no change to validation behavior.

### Compact Output (`output: "compact"`)

Structural dedup only helps when shapes _repeat_. For a large app of mostly
**distinct** schemas it can't fire, and the per-schema error-collecting walk —
64–77% of the generated bytes — is emitted in full for every schema. But that
walk exists only to reproduce Zod's issues on failure, and in `"schema"` mode
**the original Zod schema is already in your bundle**. `output: "compact"`
exploits this: it compiles the fast path as usual and, on a fast-check failure,
delegates the cold error path to the retained schema's own `safeParse` instead
of emitting a compiled slow walk.

```typescript
import zodCompiler from "zod-compiler/vite";

export default defineConfig({
  plugins: [zodCompiler({ output: "compact" })],
});
```

On a 50-schema set of distinct shapes (where dedup can't help), generated
output drops **~73% raw / ~71% gzipped**:

| Mode      |     Raw |   Gzip |
| --------- | ------: | -----: |
| `schema`  | 169,599 | 16,645 |
| `compact` |  45,735 |  4,789 |

The gzip win is far larger than collapsing duplicated code (which gzip already
compresses well) because the slow walk is **removed**, not re-encoded.

**What it costs — and doesn't:**

- **Hot path unchanged.** `parse`/`safeParse` of valid input and the `.is()`
  guard run the exact same compiled fast check as `"schema"` mode. Identity is
  preserved (`.shape`, `.meta()`, `z.toJSONSchema()`, `instanceof`, tRPC/Hono
  all keep working).
- **Errors are Zod's own.** A failed `safeParse` reports byte-identical issues
  to Zod — there is no second validation engine to drift, so correctness is
  guaranteed by construction.
- **Cold error reporting runs Zod.** Reading `.error` (or `.parse()` throwing)
  on _invalid_ input runs Zod's full parse — slower than the compiled slow walk,
  but it's the cold path. The delegation is **lazy**: `safeParse(x).success` and
  `.is(x)` never invoke Zod (the fast check alone decides), so the common
  validation-failure checks stay fast.
- **Mutation schemas keep the compiled path.** Schemas that transform their
  input (`default` / `catch` / `coerce` / `transform`) are compiled exactly as
  in `"schema"` mode — only pure validators delegate.

Use it when bundle size dominates (large schema counts, edge/serverless cold
starts, memory at scale) and you can afford a slower _error_ path. It requires
the Zod schema, so it's mutually exclusive with `output: "bag"` (which drops it).
The CLI exposes it as `--emit compact`.

### Auto Mode: Side Effects Warning

In auto mode (the default), the plugin executes files to inspect their exports. A static pre-filter skips files whose exports provably can't be schemas without executing them — but if a file has schema-shaped exports AND side effects (starts a server, connects to a database), those side effects run at build time.

**Fix:** Use `include` to limit which files are scanned:

```typescript
zodCompiler({
  include: ["src/schemas", "src/validators"],
});
```

#### Environment validation that calls `process.exit`

A common pattern is an `env.ts` that validates `process.env` and calls
`process.exit(1)` when required secrets are missing — schema files often import
it transitively. In a CI build those secrets are intentionally absent, so
executing the file at build time would otherwise terminate the bundler.

zod-compiler guards against this. While it executes a module for discovery it:

1. Sets `process.env.ZOD_COMPILER` so cooperating modules can skip validation.
2. Intercepts `process.exit` — an unguarded exit becomes a normal load failure,
   so the build **does not crash**. The affected files fall back to runtime Zod
   and a one-time warning names the optimization that was skipped.

To keep those schemas compiled, guard the exit on the marker:

```typescript
// env.ts
if (!process.env.ZOD_COMPILER) {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Missing required environment variables:", result.error.format());
    process.exit(1);
  }
}
```

If you use `@t3-oss/env-*`, pass `skipValidation: !!process.env.ZOD_COMPILER`.

(Only synchronous exits during module evaluation are intercepted — an exit
deferred to a `setTimeout` or later event still exits.)

### schemas: "auto" vs "explicit"

|                              | `"auto"` (default)                                         | `"explicit"` + compile()                    |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| Source code changes          | None                                                       | Wrap each schema                            |
| `zod-compiler` import needed | No                                                         | Yes                                         |
| What gets compiled           | All exported Zod schemas                                   | Only wrapped schemas                        |
| Build-time file execution    | Zod-importing files that may export schemas (pre-filtered) | Files with `import ... from "zod-compiler"` |
| Best for                     | New projects, framework integration                        | Gradual adoption, selective optimization    |

### Large projects and CI

Discovery executes each schema file — and transitively its first-party import
graph — inside the bundler's single-threaded process. In a repository where
schema files pull in thousands of modules, the **first cold run** is the
expensive part: subsequent runs hit the persistent cache and skip discovery
entirely. On saturated CI hosts a cold discovery of a huge graph can stall the
bundler's event loop long enough to trip test timeouts (the plugin warns when
a single file's discovery exceeds 5s). Three levers, in order of impact:

**1. Persist the cache across CI runs.** The cache directory is small
(dependency snapshots are content-addressed and shared between entries) and
entries self-validate against dependency content hashes — restoring a stale
cache can only cause recompiles, never stale output:

```yaml
# GitHub Actions
- uses: actions/cache@v4
  with:
    path: node_modules/.cache/zod-compiler
    key: zod-compiler-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
    restore-keys: zod-compiler-${{ runner.os }}-
```

**2. Scope what gets discovered.** `include` limits discovery to your schema
directories. If test startup latency matters more than test-time validator
performance, run hoist-only in Vitest and compile only real builds:

```typescript
// vitest.config.ts — hoisting still applies; validation uses plain Zod
zodCompiler({ schemas: "explicit" });

// vite.config.ts (build)
zodCompiler({ include: ["src/schemas"] });
```

**3. Measure before tuning.** `ZOD_COMPILER_TIMING=1` prints per-phase wall
time (hoist / static-filter / discover / compile) on exit, so you can see
whether discovery or codegen dominates and which files pay it.

Everything else is automatic: the plugin declares
[hook filters](https://vite.dev/guide/rolldown.html#hook-filter-feature) on
its `transform`, `load` and `resolveId` hooks, so bundlers that support them
(Vite, Rolldown, Rollup ≥ 4.40) never call the plugin for a module that cannot
contain a schema — a file that never mentions `zod` costs nothing at all, not
even a hook call. Bundlers without native support get the same filtering in
JavaScript. The one exception is a custom `hoist.schemaNamePattern`: it
promotes arbitrary imported identifiers to schema roots, so the content filter
is dropped for that configuration (path filtering still applies).

## Framework Examples

### tRPC

```typescript
// src/schemas.ts
import { z } from "zod";

export const CreateUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.email(),
  age: z.number().int().min(0).max(150),
});

// src/router.ts
import { CreateUserSchema } from "./schemas";

export const appRouter = t.router({
  createUser: t.procedure.input(CreateUserSchema).mutation(({ input }) => createUser(input)),
});
```

In auto mode (the default), `CreateUserSchema` is compiled at build time. The tRPC router uses the optimized version automatically. No `.input(compile(CreateUserSchema))` needed.

### Hono

```typescript
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { UserSchema } from "./schemas";

const app = new Hono();

app.post("/users", zValidator("json", UserSchema), (c) => {
  const user = c.req.valid("json");
  return c.json(user);
});
```

### React Hook Form

```typescript
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { UserSchema } from "./schemas";

function UserForm() {
  const form = useForm({
    resolver: zodResolver(UserSchema),
  });
  // ...
}
```

### Any Standard Schema Consumer

Compiled schemas are the original Zod schema objects with optimized parse methods installed, so they still implement [Standard Schema](https://standardschema.dev). Any library that accepts Standard Schema validators works automatically.

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

### Fully Compiled (2-75x faster)

`string`, `number`, `bigint`, `boolean`, `null`, `undefined`, `any`, `unknown`, `literal`, `enum`, `stringbool`, `date`, `file`, `object`, `strictObject` / `.strict()`, `looseObject`, `array`, `tuple`, `record`, `set`, `map`, `union`, `discriminatedUnion`, `intersection`, `pipe` (non-transform), `optional`, `nullable`, `readonly`, `default`, `catch`, `coerce`, `templateLiteral`, `symbol`, `void`, `nan`, `never`, `lazy` (recursive — self-, mutual, and nested), `transform` / `refine` (zero-capture — see below)

All standard Zod checks are supported: `min`, `max`, `length`, `email`, `url`, `uuid`, `regex`, `int`, `positive`, `negative`, `multipleOf`, `int32`, `uint32`, `float32`, `float64`, `includes`, `startsWith`, `endsWith`, and more.

### Falls Back to Zod (Still Works, Not Faster)

These reach JavaScript that generated code cannot reproduce — an opaque callback, or control flow that depends on one:

| Type                                     | Why                                                          | Alternative                                    |
| ---------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| `transform` that is async or takes `ctx` | A promise result, or zod's issue-collection protocol         | Use a plain single-argument callback           |
| `superRefine` followed by another check  | An aborting issue truncates zod's remaining checks           | Put the `superRefine` last in the chain        |
| `custom` / raw `.check(fn)`              | Arbitrary validation logic against zod's raw payload         | Use `superRefine`, which compiles              |
| `preprocess`                             | Input preprocessing function                                 | Use `z.coerce` when possible                   |
| `lazy` (unresolvable inner)              | Getter throws / inner type can't be resolved at compile time | Ensure the lazy getter returns a static schema |

**Zero-capture effects compile:** a `transform`/`refine` callback that takes a
single argument and references only its own parameters, locals, and safe
globals (`Math`, `Number`, `JSON`, …) is extracted via `fn.toString()` and
inlined into the generated validator. `z.string().transform((s) => s.trim())`
compiles; `z.string().transform((s) => s + suffix)` falls back (it captures
`suffix`).

**Every `refine` and `transform` compiles, captures or not.** A callback that
cannot be inlined is instead **called by reference** — the generated validator
invokes your own function object, reached from the schema — so the schema keeps
its compiled path either way. This matters most on the root, where one captured
callback used to send the whole object through Zod:

- `z.object({ … }).refine((d) => d.password === d.confirm)` — the cross-field
  check. Measured on a six-field object: **246.7 ns → 8.5 ns (29x)**, against
  Zod's own 250.5 ns.
- `z.object({ … }).transform((d) => ({ ...d, id: prefix + d.id }))` —
  **163.7 ns → 12.7 ns**. That case was previously _slower than not compiling
  at all_ (Zod itself: 136.7 ns), because the delegate wrapper sat on top of
  Zod's parse.

Where the callback itself dominates, compiled output reaches its cost and no
more: a captured `refine` doing `allowedDomains.some(…)` measures 23.9 ns
against 24.1 ns for calling that predicate alone — zero remaining validation
overhead.

**`superRefine` compiles too.** It has no verdict to read — the callback takes
Zod's payload and pushes issues onto it — so it is called through a reference to
Zod's own wrapper with a synthesized payload, which leaves issue construction
Zod's job and keeps error shapes identical by construction. That turns the most
common form of cross-field validation from a total fallback into the 2.3M →
13.3M row below; measured in isolation, where the harness floor stops
compressing the ratio, the same object runs 357.8 ns → 39.9 ns (9.0x) and an
array of numbers 240.7 ns → 5.3 ns (46x), with rejecting inputs 31-92x. Two
shapes still delegate: a `superRefine` with another check after it
(an issue marked `fatal` aborts Zod's remaining chain, which generated code —
running every check — cannot reproduce), and a raw `.check(fn)`, where the
callback holds the payload unmediated rather than through Zod's wrapper. An
`async` callback is invisible at compile time, since the reference points at the
wrapper; the promise it returns raises Zod's own `$ZodAsyncError`, exactly as a
synchronous Zod parse does. `ctx.value`, `ctx.aborted`, and direct
`ctx.issues.push` are all honored.

**`.catchall(schema)` compiles.** Unknown keys are validated against the value
schema by the same bare `for-in` the `strict` pass uses — zod's own
`handleCatchall` iteration, inherited enumerable keys included — with each issue
reported at its key. A header bag (`z.object({...}).catchall(z.string())`)
measures 117.2 ns → 9.0 ns (**13x**), a numeric metrics bag 105.1 ns → 11.5 ns
(9.1x); both were 1.0x. Value-rewriting catchalls (`z.coerce.number()`,
`.trim()`, a `.default()`) write through a clone, so the caller's input is never
mutated. A catchall that itself delegates keeps the whole object delegated —
one zod call beats one per unknown key.

**Partial fallback:** If an object has 10 properties and 1 uses `transform`, the other 9 are still compiled. Only the `transform` property falls back to Zod.

**Recursive schemas compile** — whether directly self-recursive (`z.lazy(() => Self)`), mutually recursive (`A` ↔ `B`), or **nested as a field of a larger root** (a recursive `Comment` inside `z.object({ thread, root: Comment })`). Each distinct recursive shape is hosted once as a dedicated validator and reached by reference, so the whole structure stays on the fast path instead of delegating to Zod — a recursive type nested in an API envelope runs **12–32x faster than Zod** (see the benchmark table). A `lazy` schema only falls back when its getter can't be resolved at compile time.

**Tip:** Run `npx zod-compiler check` to see exactly which parts of your schemas are compiled and which fall back.

### Behavioral Differences from Zod

Compiled validators match Zod on accept/reject decisions, output data for the known shape, and error messages — including issue ordering for multi-failure inputs. A few observable behaviors differ **by design**, all stemming from the zero-allocation fast path: a successful parse returns the **input value itself** rather than rebuilding it.

| Behavior                               | Zod                              | zod-compiler                                                                     |
| -------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------- |
| Unknown keys on a default `z.object()` | Stripped from the output         | **Kept** by default — returned by reference; opt in with `stripUnknownKeys`      |
| Record key iteration                   | All own keys (`Reflect.ownKeys`) | Own **enumerable string** keys only — symbol and non-enumerable keys are ignored |
| Array / object output identity         | A fresh value                    | The input value, returned by reference                                           |

What this means in practice:

- **Unknown keys are not stripped by default.** `z.object({ a: z.string() }).parse({ a: "x", b: 1 })` returns `{ a: "x" }` under Zod but `{ a: "x", b: 1 }` compiled. Three ways to get stripping behavior, in order of preference:
  - Enable the **`stripUnknownKeys`** build option (or the `--strip-unknown-keys` CLI flag). Genuine `z.object()` schemas then rebuild a fresh object with only the declared keys — exactly matching Zod's default strip, including nested objects, array elements, `.pick()`/`.partial()`/`.extend()` results, and discriminated-union options. This is the right choice if you forward parsed request bodies to an ORM and need protection against mass-assignment / overposting. (Cost: stripped objects are rebuilt on every successful parse, so they no longer take the by-reference fast path.)
  - Use **`z.strictObject()`** if you'd rather reject unknown keys outright (changes the API contract — extras become errors).
  - Use **`z.looseObject()`** to make the default keep-extras behavior explicit at the schema level.

  All three compile fully, and validation of the declared keys is identical in every case.

  **Performance of `stripUnknownKeys`** (`pnpm benchmark strip-unknown-keys`): stripping rebuilds the object, so it gives up the by-reference fast path — but the rebuild is a single object literal per level, which costs little next to the validation itself. Representative throughput:

  | Schema (input)                | Zod (strips) | compiler (keep, default) | compiler (strip) | strip vs keep | strip vs Zod |
  | ----------------------------- | ------------ | ------------------------ | ---------------- | ------------- | ------------ |
  | medium object, 7 keys (clean) | 2.7M         | 13.5M                    | 12.7M            | 0.94x         | **4.7x**     |
  | wide object, 20 keys (clean)  | 4.0M         | 24.4M                    | 18.1M            | 0.74x         | **4.5x**     |
  | nested API response (clean)   | 176K         | 9.3M                     | 5.4M             | 0.58x         | **31x**      |

  The tax scales with nesting depth (one fresh object per level), not really with key count, and is independent of whether unknown keys are actually present. It is small enough that you should turn stripping on wherever you want sanitization — forwarding parsed bodies to an ORM, for instance — rather than trading it away for throughput.

- **Records skip symbol / non-enumerable keys.** `z.record(z.string(), …)` validates (and rejects) a symbol-keyed or non-enumerable-keyed entry under Zod; the compiled record never visits it. Plain string-keyed records — the common case — are unaffected.

Matching Zod on these would mean allocating a fresh object (or a `Reflect.ownKeys` array) on every successful parse — the exact cost the fast path exists to avoid.

## Benchmark

5-way comparison: **Zod v3** vs **Zod v4** vs **zod-compiler** vs **[Typia](https://typia.io/)** vs **[AJV](https://ajv.js.org/)**

| Scenario                                        | Zod v3 | Zod v4 | **zod-compiler** | Typia | AJV   | vs Zod v4 |
| ----------------------------------------------- | ------ | ------ | ---------------- | ----- | ----- | --------- |
| simple string                                   | 13.3M  | 14.5M  | **17.3M**        | 17.7M | 17.9M | 1.2x      |
| string (min/max)                                | 12.4M  | 8.0M   | **17.0M**        | 17.9M | 15.7M | 2.1x      |
| number (int+positive)                           | 12.6M  | 8.3M   | **17.4M**        | 18.0M | 18.1M | 2.1x      |
| enum                                            | 12.3M  | 12.6M  | **17.6M**        | 17.8M | 18.3M | 1.4x      |
| bigint (min/max)                                | 12.2M  | 7.8M   | **17.0M**        | —     | —     | 2.2x      |
| tuple [string, int, bool]                       | 5.9M   | 6.5M   | **16.5M**        | 16.5M | 16.4M | 2.6x      |
| record\<string, number\>                        | 3.2M   | 2.8M   | **15.2M**        | 11.9M | 15.7M | 5.5x      |
| set\<string\> (5 items)                         | 3.7M   | 2.3M   | **15.0M**        | —     | —     | 6.5x      |
| set\<string\> (20 items)                        | 1.3M   | 715K   | **11.8M**        | —     | —     | **16x**   |
| map\<string, number\> (5 entries)               | 2.0M   | 1.4M   | **13.2M**        | —     | —     | 9.6x      |
| map\<string, number\> (20 entries)              | 665K   | 360K   | **8.4M**         | —     | —     | **23x**   |
| pipe (non-transform)                            | 8.7M   | 5.7M   | **16.7M**        | —     | —     | 2.9x      |
| discriminatedUnion (3 variants)                 | 3.5M   | 4.2M   | **16.0M**        | 15.9M | 7.9M  | 3.9x      |
| discriminatedUnion (8 variants, rotating)       | 2.7M   | 3.5M   | **10.1M**        | —     | —     | 2.9x      |
| plain union of 8 tagged objects (auto-discrim.) | 374K   | 678K   | **10.0M**        | —     | —     | **15x**   |
| strict object (DB row)                          | 1.8M   | 3.2M   | **8.1M**         | —     | —     | 2.5x      |
| medium object (valid)                           | 1.9M   | 2.4M   | **9.9M**         | 11.5M | 7.6M  | 4.1x      |
| medium object (invalid)                         | 553K   | 80K    | **15.1M**        | 3.0M  | 7.8M  | **188x**  |
| large object (10 items)                         | 122K   | 166K   | **7.9M**         | 6.1M  | 1.2M  | **48x**   |
| large object (100 items)                        | 14K    | 18K    | **1.4M**         | 1.3M  | 127K  | **77x**   |
| recursive tree (7 nodes)                        | 589K   | 2.1M   | **12.8M**        | 12.0M | 4.9M  | 6.0x      |
| recursive tree (121 nodes)                      | 32K    | 143K   | **2.5M**         | 2.0M  | 392K  | **18x**   |
| nested recursion (7 nodes)                      | 394K   | 1.0M   | **12.1M**        | 11.1M | 3.0M  | **12x**   |
| nested recursion (121 nodes)                    | 25K    | 66K    | **2.1M**         | 1.7M  | 219K  | **32x**   |
| deeply nested object (243 leaves)               | 11K    | 20K    | **1.2M**         | 1.1M  | 129K  | **59x**   |
| event log (combined)                            | 389K   | 645K   | **6.4M**         | —     | —     | 9.9x      |
| object with transform (zero-capture)            | 1.2M   | 2.0M   | **6.3M**         | —     | —     | 3.1x      |
| array 10 × transform (zero-capture)             | 126K   | 208K   | **3.3M**         | —     | —     | **16x**   |
| array 50 × transform (zero-capture)             | 26K    | 45K    | **839K**         | —     | —     | **19x**   |
| object with captured transform                  | 1.3M   | 6.4M   | **15.0M**        | —     | —     | 2.4x      |
| object with captured refine (cross-field)       | 1.6M   | 2.5M   | **16.1M**        | —     | —     | 6.4x      |
| object with superRefine (cross-field)           | 1.6M   | 2.3M   | **13.3M**        | —     | —     | 5.7x      |

_ops/s, higher is better. "—" = not supported by the library. Measured with `vitest bench` on Apple M4 Max (zod 4.3.6, zod v3 3.23.8, typia 12, ajv 8), best of two full runs; rows reproduce within ~5% between runs. The harness itself costs ~55 ns per iteration — the fastest rows sit at that floor — so it compresses the top of the range: gaps between the three AOT columns on the primitive rows are below the noise, not real._

Performance scales with schema complexity. Nested objects and arrays see the biggest gains because zod-compiler eliminates per-node traversal overhead. Deeply nested schemas (the 243-leaf dashboard row) stay fast because oversized fast-check functions are split into smaller boolean helpers, each kept within V8's optimizing-compiler budget. `discriminatedUnion` dispatches instead of trying options in sequence the way Zod does, and each case validates only its variant's distinctive fields — the object type-guard and the discriminator are checked once before dispatch, never re-checked inside the matched case (a redundancy the engine only elides on unions small enough to inline, so large unions get a measured ~1.5x on the fast check). Dispatch is genuinely O(1) for string discriminators: a `switch` over string labels is only _written_ as a jump, V8 lowers it to sequential `===` comparisons (~0.5 ns per preceding case, so 52 ns of pure dispatch at 80 variants), so the discriminator goes through a `{value: ordinal}` table into a dense integer switch — measured 1.9x at 8 variants and 2.8x at 60, for ~1% more generated bytes. Unions of two variants, or with non-string discriminators, keep the plain switch. A **plain `z.union`** of objects that all pin a shared key to disjoint literals is auto-detected and lowered to the same switch dispatch — so an untagged union written without `discriminatedUnion` still validates in O(1) (15x faster than Zod here), as long as it has enough options to outweigh the switch's setup cost; below that it keeps the fully-inlined `||`-chain, whose options and per-option checks are ordered cheapest-first so a non-matching option is dropped without running its regexes. The invalid-input row is large because failed `safeParse` defers error materialization until `.error` is read. `transform`/`refine` callbacks compile whether or not they capture (3-19x): a zero-capture one is inlined from its source, a capturing one is called by reference rather than costing the schema its compiled path — the cross-field refine row measures 2.5M → 16.1M, and captured transforms went from matching Zod (1.0x) to 2.4x. `superRefine` compiles as well, called through a reference to Zod's own payload wrapper (2.3M → 13.3M here, from a total fallback); only a `superRefine` with another check after it, raw `.check(fn)`, and `ctx`-taking or async transforms still delegate.

`parse()` (throwing API) rides a zero-allocation fast path: medium object 2.4M → 10.2M ops/s (4.3x), large object (100 items) 18K → 1.4M ops/s (78x).

The `.is()` guard answers both halves of "does this match?" cheaply — 10.3M ops/s on matching input and **16.8M on non-matching**, against Zod's 2.4M / 159K via `safeParse().success` (medium object). Rejection is the _faster_ half by construction: the fast check's conjuncts are ordered so a mismatch is decided on a type guard rather than on the schema's most expensive check — 106x Zod, which pays full error construction to say no.

```bash
pnpm benchmark   # run locally
```

### Performance Architecture

For eligible schemas, zod-compiler generates a **two-phase validator**:

1. **Fast Path** — A single `&&` expression chain that validates the entire input with zero allocations. Valid input returns immediately.
2. **Slow Path** — Error-collecting validation that only runs when the Fast Path fails.

Additional optimizations: pre-compiled regex, per-type check ordering (a string's `.min()` before its format regex), discriminated-union cases that skip the now-redundant object-guard and discriminator re-check after `switch` dispatch, and auto-discrimination of plain `z.union`s of tagged objects into the same switch dispatch.

**Cheapest-first check ordering.** A fast check is one `&&` chain, so accepting input runs every conjunct whatever the order — but a _rejection_ stops at the first false one. Object properties, tuple positions, intersection sides and union options are therefore emitted in estimated-cost order, cheap type guards ahead of regex formats and nested containers. Valid input is unaffected; deciding that input does _not_ match gets much cheaper, which is what `.is()` guards, `z.union` probing and every failed `safeParse` actually do. Measured per validator (no harness overhead) on a 3-option union of objects declaring `{email, kind, note}`: an input matching the last option 102 ns → 39 ns (2.6x), one matching none 102 ns → 6 ns (16x); a 6-property object guard rejecting a wrong-typed field 38 ns → 5 ns (8x).

**Object construction.** Where a fresh object must be produced — `stripUnknownKeys` — it is emitted as one object literal rather than assembled key by key. V8 stamps a literal out of a cached boilerplate map in a single allocation; adding keys one at a time walks a transition chain and re-checks the map on every store, which measured 8.1x slower on a 20-key shape. Keys that can be absent (optionals) are appended after the literal, in shape order, under zod's own presence rule.

**Local bindings for called helpers.** Lean mode imports its shared helpers from the plugin's runtime module, and a bundler leaves those as module-scope `var`s. V8 folds a _local_ binding into a constant callee and inlines straight through `helper.call(...)`; a mutable module-scope one it will not, so the record fast path's per-key `__zcHop.call(o, k)` became a generic call. Aliasing such helpers into the IIFE once fixes it: measured on a plugin-transformed, esbuild-bundled artifact, a 5-key record went 34.6 ns → 9.2 ns and a 20-key record 157.3 ns → 23.1 ns. Only helpers invoked through `.call` need this — a direct call to an imported function, and an imported RegExp receiver, are both unaffected.

**One declaration per value.** Constant tables — an enum's `Set`, a strict shape's key list, a file's mime list — are keyed by their initializer, so a value list reached from both the fast check and the slow walk, or shared by sibling properties, is emitted once rather than per use. Worth 18-21% of the generated bytes on enum-heavy schemas, and 10% raw / 5% gzip across a realistic schema set.

**Membership tests.** A strict object's unknown-key pass consults an object literal (`TABLE[k] === 1`) rather than a `Set`, whose `has` costs a flat ~4 ns hash probe per key however small the set — 3.7x (8 keys) to 4.5x (32 keys) faster over the same for-in, taking an 8-key strict object from 53 ns to 32 ns end to end. Enum values keep the existing split: an inlined `===` chain up to 5 values, one `Set` lookup above that.

Run `npx zod-compiler check --json` to see which schemas qualify for Fast Path.

## Development

```bash
pnpm install
pnpm test
pnpm benchmark
pnpm lint
```

## Acknowledgements

zod-compiler started as a fork of [zod-aot](https://github.com/wakita181009/zod-aot) by [@wakita181009](https://github.com/wakita181009).
