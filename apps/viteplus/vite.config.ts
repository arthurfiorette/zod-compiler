import { defineConfig, lazyPlugins } from "vite-plus";
import zodCompiler from "zod-compiler/vite";

export default defineConfig({
  plugins: lazyPlugins(() => [zodCompiler()]),
  build: {
    lib: {
      entry: "src/main.ts",
      formats: ["es"],
      fileName: "main",
    },
    rollupOptions: {
      external: ["zod"],
    },
    outDir: "dist",
  },
});
