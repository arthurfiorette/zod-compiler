import { describe, expect, it } from "vite-plus/test";
import type { NeverIR } from "#src/core/types.js";
import { compileIR } from "../helpers.js";

describe("slow-path — never", () => {
  it("rejects everything", () => {
    const ir: NeverIR = { type: "never" };
    const safeParse = compileIR(ir);
    expect(safeParse(undefined).success).toBe(false);
    expect(safeParse(null).success).toBe(false);
    expect(safeParse(0).success).toBe(false);
    expect(safeParse("").success).toBe(false);
    expect(safeParse(true).success).toBe(false);
    expect(safeParse({}).success).toBe(false);
    expect(safeParse([]).success).toBe(false);
  });
});
