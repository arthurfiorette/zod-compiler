/**
 * Where an issue's message comes from when nothing was baked into it.
 *
 * Zod resolves it in `finalizeIssue`, in order: the schema's own `error` option,
 * the per-call `ctx.error`, `config.customError`, `config.localeError`, then
 * "Invalid input". The compiled path bakes the first link at build time and
 * resolves the two config links at `.error`-read time.
 *
 * It used to snapshot `config().localeError` into `__zcMsg` at module init,
 * which broke two things silently: `customError` was never consulted at all, and
 * a `z.config()` running AFTER the schema module was imported — the normal order
 * when an entry point configures a locale and imports schemas — was ignored.
 *
 * `ctx.error` and `reportInput` remain unsupported: they arrive per call, so
 * `safeParse` would have to carry them, and that entry point has no room (an
 * unused second parameter alone measured ~12% on every parse).
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { compileLikeProduction } from "./parity-harness.js";

/** First issue's message from the compiled validator. */
function message(schema: z.ZodType, input: unknown, name: string): string | undefined {
  const result = compileLikeProduction(schema, name)(input);
  return result.success
    ? undefined
    : (result.error.issues[0] as { message?: string } | undefined)?.message;
}

afterEach(() => {
  z.config({ customError: undefined, localeError: undefined });
});

describe("error maps — resolved at .error-read time, not module init", () => {
  it("honours a customError installed after the schema was compiled", () => {
    const schema = z.object({ a: z.string().min(3) });
    const compiled = compileLikeProduction(schema, "cfgLate");
    z.config({ customError: () => "CUSTOM" });
    const result = compiled({ a: "x" });
    expect(result.success).toBe(false);
    expect((result as { error: { issues: { message: string }[] } }).error.issues[0]?.message).toBe(
      "CUSTOM",
    );
  });

  it("honours a localeError installed after the schema was compiled", () => {
    const schema = z.string().min(3);
    const compiled = compileLikeProduction(schema, "locLate");
    z.config({ localeError: () => "LOCALE" });
    const result = compiled("x");
    expect((result as { error: { issues: { message: string }[] } }).error.issues[0]?.message).toBe(
      "LOCALE",
    );
  });

  it("prefers customError over localeError, as zod does", () => {
    z.config({ customError: () => "CUSTOM", localeError: () => "LOCALE" });
    expect(message(z.string().min(3), "x", "prec")).toBe("CUSTOM");
  });

  it("falls through to localeError when customError returns undefined", () => {
    z.config({ customError: () => undefined, localeError: () => "LOCALE" });
    expect(message(z.string().min(3), "x", "fall")).toBe("LOCALE");
  });

  it("unwraps a map that returns an object", () => {
    z.config({ customError: () => ({ message: "OBJ" }) });
    expect(message(z.string().min(3), "x", "obj")).toBe("OBJ");
  });

  it('falls back to "Invalid input" when every map declines', () => {
    z.config({ customError: () => undefined, localeError: () => undefined });
    expect(message(z.string().min(3), "x", "none")).toBe("Invalid input");
  });

  it("leaves a baked schema-level message alone", () => {
    // The schema's own `error` wins over both config maps — it is baked into the
    // issue at build time, so the resolver never runs for it.
    z.config({ customError: () => "CUSTOM" });
    expect(message(z.string().min(3, "BAKED"), "x", "baked")).toBe("BAKED");
  });

  it("matches zod for every map combination", () => {
    const cases: [string, () => void][] = [
      ["none", () => {}],
      ["custom only", () => z.config({ customError: () => "C" })],
      ["locale only", () => z.config({ localeError: () => "L" })],
      ["both", () => z.config({ customError: () => "C", localeError: () => "L" })],
      ["custom declines", () => z.config({ customError: () => undefined, localeError: () => "L" })],
    ];
    for (const [label, setup] of cases) {
      z.config({ customError: undefined, localeError: undefined });
      setup();
      const schema = z.object({ a: z.string().min(3), b: z.number().int() });
      const input = { a: "x", b: 1.5 };
      const zodMessages = (schema.safeParse(input).error?.issues ?? []).map((i) => i.message);
      const result = compileLikeProduction(schema, `combo${label.replace(/\W/g, "")}`)(input);
      const compiledMessages = result.success
        ? []
        : (result.error.issues as { message: string }[]).map((i) => i.message);
      expect(compiledMessages, label).toStrictEqual(zodMessages);
    }
  });
});
