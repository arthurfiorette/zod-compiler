import { defineConfig } from "vite-plus";
import zodCompiler from "zod-compiler/vite";
import zodCompilerRolldown from "zod-compiler/rolldown";

export default defineConfig({
  plugins: [zodCompiler()],
  test: {
    include: ["tests/**/*.test.ts"],
  },
  pack: {
    entry: ["src/server.ts"],
    format: ["esm"],
    platform: "node",
    deps: {
      neverBundle: ["zod", /^@trpc\//],
    },
    plugins: [zodCompilerRolldown({ verbose: true })],
    outDir: "dist",
  },
});
