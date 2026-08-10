/**
 * Controlled module-startup report for generated-schema workloads.
 *
 * Every timing observation imports a bundle in a fresh Node process. Structural
 * probes are the deterministic guard; timing and heap deltas are informational.
 *
 * Run: vp run startup:unplugin
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { build, type PluginOption } from "vite";
import zodCompiler from "zod-compiler/vite";

const SCHEMA_COUNT = 120;
const SET_GROUP_SIZE = 10;
const ROUNDS = 7;
const VARIANTS = ["plain", "schema", "compact", "bag"] as const;
type Variant = (typeof VARIANTS)[number];

interface BundleReport {
  file: string;
  gzip: number;
  probes: {
    boundDelegates: number;
    compactMethods: number;
    compactFinalizers: number;
    eagerSets: number;
    issueHelpers: number;
    localCompilerSets: number;
    sharedCompilerSets: number;
    slowWalks: number;
  };
  raw: number;
}

interface StartupSample {
  heapDelta: number;
  ms: number;
  schemaEvaluations: number;
}

function count(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

function fixtureSource(): string {
  const schemas = Array.from({ length: SCHEMA_COUNT }, (_unused, index) => {
    const setGroup = Math.floor(index / SET_GROUP_SIZE);
    const values = Array.from({ length: 6 }, (_v, value) => `"v${setGroup}_${value}"`).join(",");
    return [
      `export const Schema${index}=(()=>{`,
      `globalThis.__zcStartupSchemaCount=(globalThis.__zcStartupSchemaCount??0)+1;`,
      `return z.object({`,
      `id:z.string().min(${(index % 5) + 1}).max(${40 + index}),`,
      `kind:z.enum([${values}]),`,
      `items:z.array(z.object({name:z.string(),score:z.number().int()})).max(${(index % 8) + 1})`,
      `});`,
      `})()`,
    ].join("");
  });
  return [
    'import {z} from "zod";',
    "globalThis.__zcStartupSchemaCount=0;",
    ...schemas,
    "export function startupSchemaCount(){return globalThis.__zcStartupSchemaCount}",
  ].join("\n");
}

async function bundle(root: string, entry: string, variant: Variant): Promise<BundleReport> {
  const outDir = path.join(root, variant);
  const plugins: PluginOption[] =
    variant === "plain"
      ? []
      : [zodCompiler({ schemas: "auto", output: variant, hoist: false }) as PluginOption];
  await build({
    configFile: false,
    logLevel: "silent",
    plugins,
    build: {
      emptyOutDir: true,
      lib: { entry, formats: ["es"], fileName: () => "startup.js" },
      minify: false,
      outDir,
    },
  });

  const file = path.join(outDir, "startup.js");
  const source = fs.readFileSync(file, "utf8");
  return {
    file,
    raw: Buffer.byteLength(source),
    gzip: gzipSync(source).length,
    probes: {
      // Rollup may suffix IIFE-local names while deconflicting hundreds of
      // exports, so probe the stable generated prefixes rather than full lines.
      boundDelegates: count(source, /var __rfp_[^;]+\.safeParse\.bind/g),
      compactMethods: count(source, /var __rfm_/g),
      compactFinalizers: count(source, /return __zcFinZ\(/g),
      eagerSets: count(source, /new Set\(/g),
      issueHelpers: count(source, /__zcIT\(/g),
      localCompilerSets: count(source, /var __set_[^=]+\s*=/g),
      sharedCompilerSets: count(source, /var __zcSet_\d+(?:\$\d+)?\s*=/g),
      slowWalks: count(source, /function __sw_\d+\(/g),
    },
  };
}

function sample(file: string): StartupSample {
  const url = pathToFileURL(file).href;
  const script = [
    "const before=process.memoryUsage().heapUsed;",
    "const start=process.hrtime.bigint();",
    `const mod=await import(${JSON.stringify(url)});`,
    "const end=process.hrtime.bigint();",
    "const after=process.memoryUsage().heapUsed;",
    "console.log(JSON.stringify({",
    "ms:Number(end-start)/1e6,",
    "heapDelta:after-before,",
    "schemaEvaluations:mod.startupSchemaCount()",
    "}));",
  ].join("");
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
  });
  if (child.status !== 0) {
    throw new Error(child.stderr || `startup child exited with ${child.status}`);
  }
  return JSON.parse(child.stdout.trim()) as StartupSample;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

async function main(): Promise<void> {
  // Keep the temporary entry under the workspace so its runtime discovery can
  // resolve the benchmark package's Zod dependency normally.
  const root = fs.mkdtempSync(path.join(import.meta.dirname, ".startup-"));
  try {
    const entry = path.join(root, "fixture.ts");
    fs.writeFileSync(entry, fixtureSource());
    const bundles = new Map<Variant, BundleReport>();
    for (const variant of VARIANTS) bundles.set(variant, await bundle(root, entry, variant));

    const samples = new Map(VARIANTS.map((variant) => [variant, [] as StartupSample[]]));
    for (let round = 0; round < ROUNDS; round++) {
      for (let offset = 0; offset < VARIANTS.length; offset++) {
        const variant = VARIANTS[(round + offset) % VARIANTS.length] as Variant;
        samples.get(variant)?.push(sample(bundles.get(variant)?.file ?? ""));
      }
    }

    // oxlint-disable-next-line no-console -- benchmark report
    console.log(`\nModule startup report (${SCHEMA_COUNT} schemas, ${ROUNDS} fresh processes)\n`);
    for (const variant of VARIANTS) {
      const report = bundles.get(variant);
      const observations = samples.get(variant) ?? [];
      if (report === undefined) throw new Error(`missing ${variant} bundle`);
      const times = observations.map((entry) => entry.ms);
      const heaps = observations.map((entry) => entry.heapDelta);
      const evaluations = new Set(observations.map((entry) => entry.schemaEvaluations));
      // oxlint-disable-next-line no-console -- benchmark report
      console.log(
        `${variant.padEnd(7)} raw=${formatBytes(report.raw).padStart(10)} gzip=${formatBytes(report.gzip).padStart(10)} ` +
          `import=${percentile(times, 0.5).toFixed(2)}ms [${percentile(times, 0.25).toFixed(2)}, ${percentile(times, 0.75).toFixed(2)}] ` +
          `heap=${formatBytes(percentile(heaps, 0.5))} schemas=${[...evaluations].join(",")} ` +
          `compactMethods=${report.probes.compactMethods} binds=${report.probes.boundDelegates} ` +
          `finZ=${report.probes.compactFinalizers} slowWalks=${report.probes.slowWalks} ` +
          `issueHelpers=${report.probes.issueHelpers} sets=${report.probes.eagerSets} ` +
          `sharedSets=${report.probes.sharedCompilerSets} localSets=${report.probes.localCompilerSets}`,
      );
    }

    const compact = bundles.get("compact");
    const compactEvaluations = new Set(
      (samples.get("compact") ?? []).map((entry) => entry.schemaEvaluations),
    );
    if (
      compact === undefined ||
      compact.probes.compactMethods !== SCHEMA_COUNT ||
      compact.probes.compactFinalizers !== SCHEMA_COUNT ||
      compact.probes.boundDelegates !== 0 ||
      compact.probes.issueHelpers !== 0 ||
      compact.probes.localCompilerSets !== 0 ||
      compact.probes.sharedCompilerSets !== SCHEMA_COUNT / SET_GROUP_SIZE ||
      compact.probes.slowWalks !== 0 ||
      compactEvaluations.size !== 1 ||
      !compactEvaluations.has(SCHEMA_COUNT)
    ) {
      throw new Error("compact startup structural invariants failed");
    }
  } finally {
    if (process.env["KEEP_STARTUP_BUNDLES"] === "1") {
      // oxlint-disable-next-line no-console -- explicit benchmark debugging aid
      console.log(`Kept generated bundles at ${root}`);
    } else {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

await main();
