import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vite-plus/test";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const builtRegister = path.join(root, ".tmp", "register-test", "register", "index.js");
const fixtures = path.join(root, "tests", "fixtures", "register");
const tsx = path.join(root, "node_modules", ".bin", "tsx");

beforeAll(async () => {
  await execFileAsync(
    path.join(root, "node_modules", ".bin", "esbuild"),
    [
      path.join(root, "src", "register", "index.ts"),
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node22.15",
      "--packages=external",
      `--outfile=${builtRegister}`,
    ],
    { cwd: root },
  );
});

async function run(
  fixture: string,
  mode: "javascript" | "tsx",
  cwd = root,
): Promise<{ after: string; before: string }> {
  const executable = mode === "tsx" ? tsx : process.execPath;
  const preload = ["--import", builtRegister];
  const { stdout } = await execFileAsync(executable, [...preload, path.join(fixtures, fixture)], {
    cwd,
  });
  return JSON.parse(stdout) as { after: string; before: string };
}

describe("zod-compiler/register", () => {
  it("instruments native ESM imports", async () => {
    await expect(run("esm-runner.mjs", "javascript")).resolves.toStrictEqual({
      after: "safeParse_jit",
      before: "function",
    });
  });

  it("instruments CommonJS require calls", async () => {
    await expect(run("cjs-runner.cjs", "javascript")).resolves.toStrictEqual({
      after: "safeParse_jit",
      before: "function",
    });
  });

  it("chains with tsx for TypeScript applications", async () => {
    await expect(run("tsx-runner.ts", "tsx")).resolves.toStrictEqual({
      after: "safeParse_jit",
      before: "function",
    });
  });

  it("loads zod-compiler.json from the working directory", async () => {
    await expect(run("esm-runner.mjs", "javascript", fixtures)).resolves.toStrictEqual({
      after: "",
      before: "undefined",
    });
  });
});
