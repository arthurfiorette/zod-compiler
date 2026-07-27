import { describe, expect, it } from "vitest";
import { ZodRealError, z } from "zod";
import { declareFastTemps } from "#src/core/codegen/context.js";
import { generateValidator } from "#src/core/codegen/index.js";
import { FAIL_CLASS_DECL, FIN_DECL, FIN_DEFERRED_DECL } from "#src/core/iife.js";
import { extractSchema } from "#src/core/extract/index.js";
import type { RefEntry } from "#src/core/extract/index.js";

/**
 * `optional`/`nullable`/`default` bind their input to a `var` temp so the value
 * is loaded once (see fastSentinelWrapper). The declaration is emitted by
 * whichever function hosts the expression — and there are many such sites: the
 * root fast check, each extracted `__fo_` helper, the array/set element loops,
 * the tuple rest loop, the record and object-catchall for-in helpers, the
 * discriminated-union switch, and each non-root recursion target.
 *
 * Miss one and the assignment targets an undeclared name: a ReferenceError in
 * the ES module the generated code actually ships inside. Every schema here
 * puts a hoisting wrapper inside a different one of those hosts, and the whole
 * corpus is both executed in strict mode and statically checked.
 */

const STRICT = '"use strict";';
const mkFin = (decl: string, name: string) =>
  new Function("__zcMsg", "__zcZodError", `${FAIL_CLASS_DECL}${decl}; return ${name};`)(
    undefined,
    ZodRealError,
  );
const __zcFin = mkFin(FIN_DECL, "__zcFin");
const __zcFinD = mkFin(FIN_DEFERRED_DECL, "__zcFinD");

interface Compiled {
  code: string;
  safeParse: (input: unknown) => { success: boolean };
}

function compile(schema: z.ZodType, name: string): Compiled {
  const refEntries: RefEntry[] = [];
  const ir = extractSchema(schema, refEntries);
  const result = generateValidator(ir, name, { refCount: refEntries.length });
  const factory = new Function(
    "__zcZodError",
    "__zcFin",
    "__zcFinD",
    "__rf",
    `${STRICT}${result.code}\nreturn ${result.functionDef};`,
  );
  return {
    code: `${result.code}\n${result.functionDef}`,
    safeParse: factory(
      ZodRealError,
      __zcFin,
      __zcFinD,
      refEntries.map((e) => e.schema),
    ) as Compiled["safeParse"],
  };
}

const Leaf = z.object({ v: z.string().optional(), w: z.number().nullable() });

/** Each entry forces a hoisting wrapper into a different function-emitting site. */
const CORPUS: [string, z.ZodType, unknown[]][] = [
  [
    "root object",
    z.object({ a: z.string(), b: z.string().optional(), c: z.number().int().default(1) }),
    [{ a: "x" }, { a: "x", b: "y", c: 2 }, { a: "x", b: 5 }, { b: "y" }, null, [], "no"],
  ],
  ["nullish chain", z.object({ a: z.string().nullish() }), [{ a: "x" }, { a: null }, {}, { a: 5 }]],
  [
    "array element helper",
    z.array(Leaf),
    [[], [{ w: null }], [{ v: "x", w: 1 }], [{ v: 5, w: 1 }], [{ w: "no" }]],
  ],
  [
    "set element helper",
    z.set(z.string().optional()),
    [new Set(["a"]), new Set([undefined]), new Set([1]), new Set()],
  ],
  [
    "tuple rest loop",
    z.tuple([z.string()]).rest(z.number().optional()),
    [["a"], ["a", 1, undefined], ["a", "b"], []],
  ],
  [
    "record value helper",
    z.record(z.string(), z.string().optional()),
    [{}, { k: "v" }, { k: undefined }, { k: 1 }],
  ],
  [
    "object catchall helper",
    z.object({ known: z.string() }).catchall(z.number().optional()),
    [
      { known: "x" },
      { known: "x", other: 1 },
      { known: "x", other: undefined },
      { known: "x", other: "no" },
    ],
  ],
  [
    "discriminated union switch",
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("a"), a: z.string().optional() }),
      z.object({ kind: z.literal("b"), b: z.number().nullable() }),
      z.object({ kind: z.literal("c"), c: z.string().default("d") }),
    ]),
    [
      { kind: "a" },
      { kind: "a", a: "x" },
      { kind: "b", b: null },
      { kind: "b", b: "no" },
      { kind: "z" },
    ],
  ],
  [
    "plain union",
    z.union([z.object({ t: z.string().optional() }), z.array(z.number().nullable())]),
    [{}, { t: "x" }, [1, null], [{}], 5],
  ],
  [
    "map key/value helper",
    z.map(z.string(), z.number().optional()),
    [new Map([["a", 1]]), new Map([["a", undefined]]), new Map([["a", "no"]])],
  ],
  [
    "nested object (inlined, deep path)",
    z.object({ outer: z.object({ inner: z.object({ leaf: z.string().optional() }) }) }),
    [
      { outer: { inner: {} } },
      { outer: { inner: { leaf: "x" } } },
      { outer: { inner: { leaf: 1 } } },
    ],
  ],
  [
    "intersection",
    z.intersection(z.object({ a: z.string().optional() }), z.object({ b: z.number().nullable() })),
    [{ b: null }, { a: "x", b: 1 }, { a: 1, b: 1 }],
  ],
];

// Recursive schemas exercise the non-root recursion-target host.
const Tree: z.ZodType = z.lazy(() =>
  z.object({ value: z.string().optional(), children: z.array(Tree).optional() }),
);
CORPUS.push([
  "recursive target",
  z.object({ root: Tree }),
  [
    { root: {} },
    { root: { value: "a", children: [{ value: "b" }, { children: [] }] } },
    { root: { value: 1 } },
    { root: { children: [{ value: 2 }] } },
  ],
]);

// A schema large enough to force generateFast's size-gated `__fo_` extraction,
// with an optional inside the extracted subtree.
const wide = Object.fromEntries(
  Array.from({ length: 60 }, (_, i) => [
    `f${i}`,
    z.object({ a: z.string().min(1).max(40).optional(), b: z.number().int().nullable() }),
  ]),
);
const wideValue = Object.fromEntries(
  Array.from({ length: 60 }, (_, i) => [`f${i}`, { a: "x", b: 1 }]),
);
CORPUS.push([
  "size-gated __fo_ extraction",
  z.object(wide),
  [wideValue, { ...wideValue, f0: { b: null } }, { ...wideValue, f0: { a: 1, b: 1 } }],
]);

describe("fast-path hoisted locals", () => {
  describe("every emitted function declares the temps it assigns", () => {
    for (const [name, schema] of CORPUS) {
      it(name, () => {
        const { code } = compile(schema, "S");
        // Generated preamble entries are top-level `function f(..){..}` /
        // `var x=..;` declarations — no nesting — so each function's body can be
        // isolated by matching to the last `}` on its line.
        for (const line of code.split("\n")) {
          const match = /^function\s+\w+\s*\([^)]*\)\s*\{(.*)\}$/.exec(line);
          if (!match) continue;
          const body = match[1] as string;
          const used = new Set(body.match(/__w_\d+/g) ?? []);
          if (used.size === 0) continue;
          const declared = new Set(
            (body.match(/var ([\w,]+);/g) ?? []).flatMap((d) =>
              (d.slice(4, -1).split(",") as string[]).filter((n) => n.startsWith("__w_")),
            ),
          );
          for (const name_ of used) {
            expect(declared.has(name_), `${name_} assigned but not declared in: ${line}`).toBe(
              true,
            );
          }
        }
      });
    }
  });

  describe("compiled output agrees with zod (strict mode, no ReferenceError)", () => {
    for (const [name, schema, inputs] of CORPUS) {
      it(name, () => {
        const { safeParse } = compile(schema, "S");
        for (const input of inputs) {
          expect(safeParse(input).success, `verdict for ${JSON.stringify(input)}`).toBe(
            schema.safeParse(input).success,
          );
        }
      });
    }
  });

  it("declareFastTemps emits nothing for a scope with no temps", () => {
    expect(declareFastTemps({ temps: [], used: 0 })).toBe("");
    expect(declareFastTemps({ temps: ["__w_0", "__w_1"], used: 0 })).toBe("var __w_0,__w_1;");
  });

  it("does not hoist when the input is already a local binding", () => {
    // The array element is bound to a loop variable, so there is nothing to
    // hoist — output must stay in the shorter, byte-identical form.
    const { code } = compile(z.array(z.string().optional()), "S");
    expect(code).not.toContain("__w_");
  });
});
