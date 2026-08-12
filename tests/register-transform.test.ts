import { beforeAll, describe, expect, it } from "vite-plus/test";
import { init } from "es-module-lexer";
import { instrumentModule } from "#src/register/transform.js";

beforeAll(async () => {
  await init;
});

describe("Node register source instrumentation", () => {
  it("registers named ESM exports through their local bindings", () => {
    const source = `
import { z } from "zod";
const LocalSchema = z.string();
export { LocalSchema as PublicSchema };
export const OtherSchema: z.ZodType = z.number();
`;
    const output = instrumentModule(source, "/app/schemas.ts", "module-typescript", {
      hoist: false,
    });

    expect(output).toContain('globalThis[Symbol.for("zod-compiler:register")](LocalSchema);');
    expect(output).toContain('globalThis[Symbol.for("zod-compiler:register")](OtherSchema);');
    expect(output).not.toContain("PublicSchema);");
  });

  it("does not turn type-only exports into runtime references", () => {
    const source = `
import { z } from "zod";
type Shape = { value: string };
const UserSchema = z.object({ value: z.string() });
export { type Shape, UserSchema };
`;
    const output = instrumentModule(source, "/app/schemas.ts", "module-typescript", {
      hoist: false,
    });

    expect(output).toContain('globalThis[Symbol.for("zod-compiler:register")](UserSchema);');
    expect(output).not.toContain("](Shape);");
    expect(output).not.toContain("](type);");
  });

  it("registers the final CommonJS exports object", () => {
    const source = `const { z } = require("zod"); module.exports.UserSchema = z.string();`;
    const output = instrumentModule(source, "/app/schemas.cjs", "commonjs", { hoist: false });

    expect(output).toContain(
      'globalThis[Symbol.for("zod-compiler:register")](module.exports, true);',
    );
  });

  it("honors include and exclude filters", () => {
    const source = `import { z } from "zod"; export const Schema = z.string();`;
    expect(
      instrumentModule(source, "/app/schemas.ts", "module-typescript", {
        exclude: ["schemas.ts"],
      }),
    ).toBeNull();
    expect(
      instrumentModule(source, "/app/schemas.ts", "module-typescript", {
        include: ["other/**"],
      }),
    ).toBeNull();
  });

  it("registers schemas introduced by hoisting", () => {
    const source = `
import { z } from "zod";
export function validate(value) {
  return z.object({ value: z.string() }).safeParse(value);
}
`;
    const output = instrumentModule(source, "/app/schemas.mjs", "module", {});

    expect(output).toMatch(/const (_zh_[0-9a-f]{8}) = z\.object/);
    const name = output?.match(/const (_zh_[0-9a-f]{8}) =/)?.[1];
    expect(output).toContain(`globalThis[Symbol.for("zod-compiler:register")](${name});`);
  });
});
