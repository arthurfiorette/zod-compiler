import type { NextConfig } from "next";
import zodCompiler from "zod-compiler/webpack";

/**
 * Both bundlers, from one config: Next ignores `webpack` under Turbopack and
 * `turbopack` under `--webpack`, so `vp run build` and `vp run build:turbopack`
 * exercise the plugin and the loader against the same app.
 */
const nextConfig: NextConfig = {
  webpack: (config) => {
    config.plugins?.push(zodCompiler({ verbose: true }));
    return config;
  },
  turbopack: {
    rules: {
      "*.{ts,tsx}": {
        condition: {
          all: [{ not: "foreign" }, { content: /[Zz]od/ }],
        },
        loaders: [{ loader: "zod-compiler/turbopack", options: { verbose: true } }],
      },
    },
  },
};

export default nextConfig;
