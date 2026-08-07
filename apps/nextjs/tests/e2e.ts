/**
 * E2E test for zod-compiler + Next.js, against BOTH bundlers.
 *
 * 1. Builds the app with webpack (the `zod-compiler/webpack` build plugin) and
 *    again with Turbopack (the `zod-compiler/turbopack` loader)
 * 2. Asserts each build actually compiled the app's schemas
 * 3. Starts the production server and tests API routes with valid/invalid data
 * 4. Exits with 0 on success, 1 on failure
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

const BASE_URL = "http://localhost:3456";
const PORT = 3456;
const APP_DIR = path.resolve(import.meta.dirname, "..");

function log(msg: string) {
  // oxlint-disable-next-line no-console -- E2E test runner output
  console.log(`[e2e] ${msg}`);
}

function portInUse(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net
      .connect(PORT, "localhost")
      .on("connect", () => {
        socket.destroy();
        resolve(true);
      })
      .on("error", () => resolve(false));
  });
}

/**
 * Wait for the port to be free again.
 *
 * The whole point: a server left holding it would answer the NEXT bundler's
 * requests, and every assertion would silently re-test the previous build.
 */
async function waitForPortFree(maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    if (!(await portInUse())) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Port ${PORT} still in use after ${maxRetries / 2}s`);
}

async function waitForServer(url: string, server: ChildProcess, maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    // A server that died (EADDRINUSE, a build error) must fail here rather than
    // let polling succeed against somebody else's listener.
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`Server exited early (code ${server.exitCode ?? server.signalCode})`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Server did not start within ${maxRetries}s`);
}

async function testValidUser(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/validate?type=user`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Alice",
      email: "alice@example.com",
      age: 30,
      role: "admin",
    }),
  });
  const data = await res.json();
  assert(res.status === 200, `Expected 200, got ${res.status}`);
  assert(data.success === true, "Expected success");
  assert(data.data.name === "Alice", "Expected name Alice");
  // Everything above passes on plain Zod. This is what proves the bundle that
  // actually shipped went through zod-compiler.
  assert(data.compiled === true, "Expected CreateUserSchema to be compiled");
  log("PASS: valid user (compiled)");
}

async function testInvalidUser(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/validate?type=user`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "",
      email: "not-an-email",
      age: -1,
      role: "unknown",
    }),
  });
  const data = await res.json();
  assert(res.status === 400, `Expected 400, got ${res.status}`);
  assert(data.success === false, "Expected failure");
  assert(Array.isArray(data.errors), "Expected errors array");
  assert(data.errors.length > 0, "Expected at least one error");
  log("PASS: invalid user");
}

async function testValidProduct(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/validate?type=product`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Widget",
      price: 9.99,
      tags: ["electronics"],
      inStock: true,
    }),
  });
  const data = await res.json();
  assert(res.status === 200, `Expected 200, got ${res.status}`);
  assert(data.success === true, "Expected success");
  assert(data.compiled === true, "Expected ProductSchema to be compiled");
  log("PASS: valid product (compiled)");
}

async function testInvalidProduct(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/validate?type=product`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "not-a-uuid",
      name: "",
      price: -5,
      tags: "not-an-array",
      inStock: "yes",
    }),
  });
  const data = await res.json();
  assert(res.status === 400, `Expected 400, got ${res.status}`);
  assert(data.success === false, "Expected failure");
  assert(data.errors.length > 0, "Expected validation errors");
  log("PASS: invalid product");
}

async function testHomePage(): Promise<void> {
  const res = await fetch(BASE_URL);
  assert(res.status === 200, `Expected 200, got ${res.status}`);
  const html = await res.text();
  assert(html.includes("zod-compiler"), "Expected page to contain zod-compiler");
  log("PASS: home page renders");
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

/**
 * Build with one bundler, serve it, and run every assertion against it.
 *
 * webpack goes through `zod-compiler/webpack` (the unplugin build plugin);
 * Turbopack through `zod-compiler/turbopack` (the loader). They are separate
 * integrations of the same transform, so both need the round trip — a compiled
 * validator that only exists in one of them is the failure this catches.
 */
async function runAgainst(bundler: "webpack" | "turbopack"): Promise<void> {
  let server: ChildProcess | null = null;
  const script = bundler === "webpack" ? "build" : "build:turbopack";

  // A listener left over from a previous run would answer every request below,
  // making the whole leg a test of somebody else's build.
  if (await portInUse()) {
    throw new Error(`Port ${PORT} is already in use before the ${bundler} run`);
  }

  try {
    log(`Building Next.js app with ${bundler}...`);
    execSync(`vp run ${script}`, {
      cwd: APP_DIR,
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "production" },
    });
    log("Build succeeded!");

    log(`Starting production server on port ${PORT}...`);
    // `vp` is a shell wrapper, so the real server is a grandchild: detached puts
    // the whole tree in one process group that can be signalled as a unit.
    // Signalling the wrapper alone orphans the server and leaks the port.
    server = spawn("vp", ["run", "start", "-p", String(PORT)], {
      cwd: APP_DIR,
      stdio: "pipe",
      detached: true,
      env: { ...process.env, NODE_ENV: "production" },
    });

    await waitForServer(BASE_URL, server);
    log("Server is ready.");

    await testHomePage();
    await testValidUser();
    await testInvalidUser();
    await testValidProduct();
    await testInvalidProduct();

    log(`All ${bundler} tests passed!`);
  } finally {
    if (server?.pid !== undefined) {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    await waitForPortFree();
  }
}

async function main() {
  try {
    await runAgainst("webpack");
    await runAgainst("turbopack");
    log("All tests passed!");
    process.exit(0);
  } catch (err) {
    // oxlint-disable-next-line no-console -- E2E test runner output
    console.error("[e2e] FAILED:", err);
    process.exit(1);
  }
}

void main();
