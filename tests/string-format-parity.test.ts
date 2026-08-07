/**
 * Differential parity for EVERY Zod string format reachable from the public API.
 *
 * Why this file exists: `def.pattern` is not always the validator Zod runs.
 * Zod attaches a pattern to every string format because `toJSONSchema()` needs
 * one to emit, and `$ZodStringFormat.init` installs a pattern-testing check with
 * `inst._zod.check ??= …`. But several constructors follow that init with a bare
 * `inst._zod.check = …` assignment, which overwrites the pattern check with an
 * algorithmic one — `new URL("http://[…]")` for ipv6/cidrv6, `atob` for
 * base64/base64url. For those formats the pattern is metadata that DISAGREES
 * with the runtime verdict, in both directions: the ipv6 regex has no branch for
 * IPv4-mapped addresses Zod accepts, and the base64url regex (`^[A-Za-z0-9_-]*$`)
 * accepts every `length % 4 === 1` string that Zod's decode rejects.
 *
 * zod-compiler compiles `def.pattern`, so a format whose pattern and check
 * disagree must be delegated to Zod instead — see NON_AUTHORITATIVE_PATTERN_FORMATS
 * in src/core/extract/checks.ts. This file is what tells the two classes apart:
 * every format is fuzzed against Zod over one shared corpus, so a pattern that
 * silently stops matching its check — here, or after a Zod upgrade — fails here
 * rather than in a user's validator.
 */
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { extractSchema } from "#src/core/extract/index.js";
import { compileLikeProduction, expectParity } from "./parity-harness.js";

/** Deterministic LCG (numerical recipes constants) — never Math.random. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_00_00_00_00;
  };
}

/**
 * Alphabets chosen so random draws land inside — and just outside — the
 * charsets these formats care about. The last one carries ASCII whitespace,
 * which is what exposed base64: `atob` strips it before decoding, the regex
 * cannot match it.
 */
const ALPHABETS = [
  "0123456789abcdefABCDEF:.",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
  "0123456789.:/-",
  "abcXYZ019.:-_+/=@% \t\n",
];

function randomStrings(count: number): string[] {
  const rand = lcg(0x5eed_1234);
  const out: string[] = [];
  for (let index = 0; index < count; index++) {
    const alphabet = ALPHABETS[index % ALPHABETS.length] as string;
    const length = Math.floor(rand() * 12);
    let value = "";
    for (let charIndex = 0; charIndex < length; charIndex++) {
      value += alphabet[Math.floor(rand() * alphabet.length)];
    }
    out.push(value);
  }
  return out;
}

/**
 * Hand-picked inputs, each one an edge the random draws would rarely reach:
 * every known pattern-vs-check disagreement, plus a canonical valid value per
 * format so an over-eager delegation that rejects everything cannot pass.
 */
const HAND_PICKED = [
  // Short strings — base64url's regex accepts all of these, its decode does not.
  "",
  "a",
  "-",
  "A",
  "9",
  "_",
  "aa",
  "aaa",
  "aaaa",
  // base64 padding and whitespace (atob's forgiving decode strips whitespace).
  "aGVsbG8=",
  "aGVsbG8",
  "a===",
  "A===",
  "AA==",
  "AAA=",
  "AAAA",
  "====",
  "AA=A",
  "AAAA    ",
  "AAAA\n\n\n\n",
  "\t\t\t\tAAAA",
  "AAAA\t",
  "AA==AA==",
  "+c \n",
  // IPv6, including IPv4-mapped forms the regex has no alternative for.
  "::ffff:1.2.3.4",
  "::ffff:192.168.0.1",
  "64:ff9b::1.2.3.4",
  "1:2:3:4:5:6:1.2.3.4",
  "::1",
  "::",
  "2001:db8::1",
  "0:0:0:0:0:0:0:1",
  "fe80::1%eth0",
  // `new URL` strips tabs and ends the host at `@` or `/` — Zod accepts this.
  "@_c.Z=\t/X+9",
  // CIDR.
  "::ffff:1.2.3.4/64",
  "2001:db8::/32",
  "::/0",
  "::1/129",
  "10.0.0.0/8",
  "10.0.0.0/33",
  // IPv4 / MAC / hex / hashes.
  "1.2.3.4",
  "192.168.1.1",
  "256.1.1.1",
  "deadbeef",
  "DEADBEEF",
  "d41d8cd98f00b204e9800998ecf8427e",
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "00:1A:2B:3C:4D:5E",
  "00-1A-2B-3C-4D-5E",
  // Hostnames, emails, URLs.
  "example.com",
  "localhost",
  "a.b.c",
  "-bad-.com",
  "john@example.com",
  "john..doe@example.com",
  "https://example.com",
  "http://example.com/a?b=c",
  "ftp://example.com",
  "not a url",
  // Identifiers.
  "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  "00000000-0000-0000-0000-000000000000",
  "cjld2cjxh0000qzrmn831i7rn",
  "tz4a98xxat96iws9zmbrgj3a",
  "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "9m4e2mr0ui3e8a215n4g",
  "2naeRjTrKbDPVJEXBTGfAP1H3Kz",
  "V1StGXR8_Z5jdHi6B-myT",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhIjoxfQ.sig",
  // Misc.
  "+14155552671",
  "😀",
  "abc",
  "ABC",
  "AbC",
  "2024-06-15",
  "2024-02-30",
  "12:34:56",
  "2024-06-15T12:34:56Z",
  "P3Y6M4DT12H30M5S",
];

const CORPUS: readonly string[] = [...HAND_PICKED, ...randomStrings(200)];

/** Every string format reachable from Zod's public API. */
const FORMATS: [name: string, schema: z.ZodType][] = [
  ["ipv4", z.ipv4()],
  ["ipv6", z.ipv6()],
  ["cidrv4", z.cidrv4()],
  ["cidrv6", z.cidrv6()],
  ["base64", z.base64()],
  ["base64url", z.base64url()],
  ["hex", z.hex()],
  ["hostname", z.hostname()],
  ["hash md5", z.hash("md5")],
  ["hash sha256", z.hash("sha256")],
  ["hash md5 (base64)", z.hash("md5", { enc: "base64" })],
  ["hash sha256 (base64url)", z.hash("sha256", { enc: "base64url" })],
  ["mac", z.mac()],
  ["email", z.email()],
  ["url", z.url()],
  ["httpUrl", z.httpUrl()],
  ["uuid", z.uuid()],
  ["guid", z.guid()],
  ["cuid", z.cuid()],
  ["cuid2", z.cuid2()],
  ["ulid", z.ulid()],
  ["xid", z.xid()],
  ["ksuid", z.ksuid()],
  ["nanoid", z.nanoid()],
  ["jwt", z.jwt()],
  ["e164", z.e164()],
  ["emoji", z.emoji()],
  ["iso.datetime", z.iso.datetime()],
  ["iso.date", z.iso.date()],
  ["iso.time", z.iso.time()],
  ["iso.duration", z.iso.duration()],
  ["lowercase", z.string().lowercase()],
  ["uppercase", z.string().uppercase()],
  ["stringFormat (regex)", z.stringFormat("custom_re", /^[ab]+$/)],
  ["stringFormat (fn)", z.stringFormat("custom_fn", (value) => value.length === 3)],
];

describe("string format parity", () => {
  for (const [name, schema] of FORMATS) {
    it(`${name} matches Zod across the corpus`, () => {
      expectParity(schema, [...CORPUS], `fmt_${name.replace(/\W/g, "_")}`);
    });
  }
});

/**
 * A custom string format built from a `g`/`y`-flagged regex is STATEFUL in Zod,
 * and repeated parses of one schema disagree with each other.
 *
 * `z.stringFormat(name, /re/)` routes through `_stringFormat`, which keeps the
 * regex as `def.pattern` and ALSO closes over it as
 * `def.fn = (val) => fnOrRegex.test(val)`. `$ZodCustomStringFormat` validates by
 * calling `def.fn` and never touches `lastIndex`, so a `g`/`y` regex resumes
 * where the previous parse stopped. `$ZodCheckRegex` — what `.regex()` builds —
 * does an explicit `def.pattern.lastIndex = 0` first and stays stateless. The
 * codegen emits that reset for every flagged pattern, which is correct for
 * `.regex()` and wrong for a custom format, so those now delegate to Zod.
 *
 * Zod's sequence is pinned literally rather than compared side-by-side alone:
 * if an upstream Zod release starts resetting `lastIndex` in
 * `$ZodCustomStringFormat`, this fails loudly instead of quietly agreeing at a
 * new value and leaving the delegation unexplained.
 *
 * EVERY case below builds TWO schema instances, one per side. Sharing one
 * instance would let both sides advance the SAME RegExp's `lastIndex`, and the
 * comparison would pass no matter what the compiler did.
 */
describe("stateful custom string format (g/y flag)", () => {
  /** Four repeated parses of the same input, as a pass/fail sequence. */
  function sequence(parse: (value: unknown) => { success: boolean }, input: string): boolean[] {
    return [1, 2, 3, 4].map(() => parse(input).success);
  }

  for (const flag of ["g", "y"] as const) {
    it(`z.stringFormat with /ab/${flag} reproduces Zod's stateful sequence`, () => {
      // "abab" matches at index 0 then 2; the third test starts at lastIndex 4,
      // fails, and resets the cursor — so the fourth passes again.
      const zodSide = z.stringFormat("stateful", new RegExp("ab", flag));
      expect(sequence((v) => zodSide.safeParse(v), "abab")).toStrictEqual([
        true,
        true,
        false,
        true,
      ]);

      const compiledSide = z.stringFormat("stateful", new RegExp("ab", flag));
      const compiled = compileLikeProduction(compiledSide, `stateful_${flag}`);
      expect(sequence(compiled, "abab")).toStrictEqual([true, true, false, true]);
    });

    it(`z.stringFormat with /ab/${flag} delegates instead of compiling`, () => {
      const ir = extractSchema(z.stringFormat("stateful", new RegExp("ab", flag)), []);
      expect(ir.type).toBe("fallback");
    });

    // Control: $ZodCheckRegex resets lastIndex itself, so .regex() is stateless
    // on both sides and must keep compiling — this is not the bug.
    it(`.regex(/ab/${flag}) stays stateless and stays compiled`, () => {
      const zodSide = z.string().regex(new RegExp("ab", flag));
      expect(sequence((v) => zodSide.safeParse(v), "abab")).toStrictEqual([true, true, true, true]);

      const compiledSide = z.string().regex(new RegExp("ab", flag));
      const compiled = compileLikeProduction(compiledSide, `regex_${flag}`);
      expect(sequence(compiled, "abab")).toStrictEqual([true, true, true, true]);

      expect(extractSchema(z.string().regex(new RegExp("ab", flag)), []).type).not.toBe("fallback");
    });
  }

  // Control: an UNflagged custom format has no cursor to carry, so the fix must
  // not cost it its compiled path.
  it("an unflagged custom format still compiles", () => {
    const ir = extractSchema(z.stringFormat("digits", /^\d+$/), []);
    expect(ir.type).not.toBe("fallback");

    const zodSide = z.stringFormat("digits", /^\d+$/);
    expect(sequence((v) => zodSide.safeParse(v), "123")).toStrictEqual([true, true, true, true]);

    const compiled = compileLikeProduction(z.stringFormat("digits", /^\d+$/), "unflagged_custom");
    expect(sequence(compiled, "123")).toStrictEqual([true, true, true, true]);
  });

  // Control: Zod routes these built-ins through the same `_stringFormat` helper,
  // so they DO carry `def.fn` — only the unflagged pattern keeps them compiled.
  // Delegating on `def.fn` alone would silently cost all three their fast path.
  it.each([
    ["hostname", () => z.hostname()],
    ["hex", () => z.hex()],
    ["hash md5", () => z.hash("md5")],
  ])("built-in %s carries def.fn but still compiles", (_name, make) => {
    const schema = make();
    expect(typeof (schema._zod.def as { fn?: unknown }).fn).toBe("function");
    expect(extractSchema(schema, []).type).not.toBe("fallback");
  });
});
