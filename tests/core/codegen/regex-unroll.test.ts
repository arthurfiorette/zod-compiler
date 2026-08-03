import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { unrollRepeats } from "#src/core/codegen/regex-unroll.js";
import { fastTestSource, WELL_KNOWN_REGEXES } from "#src/core/codegen/well-known-regex.js";
import { extractSchema } from "#src/core/extract/index.js";

/**
 * `unrollRepeats` rewrites bounded repeats into explicit repetition for speed.
 * It is only ever correct if the rewritten pattern accepts and rejects EXACTLY
 * the same strings, so most of this file is differential testing rather than
 * snapshotting the rewrite text.
 */
describe("unrollRepeats", () => {
  describe("what it rewrites", () => {
    it("unrolls a counted repeat of a character class", () => {
      expect(unrollRepeats("^[0-9]{4}$")).toBe("^[0-9][0-9][0-9][0-9]$");
    });

    it("unrolls a counted repeat of an escape", () => {
      expect(unrollRepeats("^\\d{4}$")).toBe("^\\d\\d\\d\\d$");
    });

    it("unrolls a counted repeat of a literal character", () => {
      expect(unrollRepeats("^a{5}$")).toBe("^aaaaa$");
    });

    it("expands the optional tail of {n,m}", () => {
      expect(unrollRepeats("^\\d{4,6}$")).toBe("^\\d\\d\\d\\d\\d?\\d?$");
    });

    it("expands {n,} into n copies plus a star", () => {
      expect(unrollRepeats("^\\d{4,}$")).toBe("^\\d\\d\\d\\d\\d*$");
    });

    it("rewrites every repeat in a pattern", () => {
      expect(unrollRepeats("^[a-f]{4}-[0-9]{4}$")).toBe(
        "^[a-f][a-f][a-f][a-f]-[0-9][0-9][0-9][0-9]$",
      );
    });
  });

  describe("what it leaves alone", () => {
    it("returns null when there is nothing to rewrite", () => {
      expect(unrollRepeats("^[0-9]+$")).toBeNull();
      expect(unrollRepeats("^abc$")).toBeNull();
      expect(unrollRepeats("")).toBeNull();
    });

    it("leaves repeats below the measured threshold", () => {
      // {2} and {3} measure the same unrolled as looped, so unrolling would
      // only grow the emitted pattern.
      expect(unrollRepeats("^[0-9]{2}$")).toBeNull();
      expect(unrollRepeats("^[0-9]{3}$")).toBeNull();
    });

    it("leaves group repeats alone", () => {
      // Unrolling a group would duplicate its capture and renumber every
      // backreference after it.
      expect(unrollRepeats("^(abc){8}$")).toBeNull();
      expect(unrollRepeats("^(?:abc){8}$")).toBeNull();
      expect(unrollRepeats("^(a)\\1{8}(b){8}$")).toBe("^(a)\\1\\1\\1\\1\\1\\1\\1\\1(b){8}$");
    });

    it("leaves lazy quantifiers alone", () => {
      expect(unrollRepeats("^[0-9]{4}?$")).toBeNull();
      expect(unrollRepeats("^[0-9]{4,8}?$")).toBeNull();
    });

    it("does not treat quantifier syntax inside a character class as a repeat", () => {
      expect(unrollRepeats("^[{4}]$")).toBeNull();
      expect(unrollRepeats("^[a-z{}]{4}$")).toBe("^[a-z{}][a-z{}][a-z{}][a-z{}]$");
    });

    it("does not treat an escaped brace as a quantifier", () => {
      expect(unrollRepeats("^a\\{4\\}$")).toBeNull();
    });

    it("leaves a literal (non-quantifier) brace run alone", () => {
      expect(unrollRepeats("^a{foo}$")).toBeNull();
    });

    it("leaves very large counts looped", () => {
      expect(unrollRepeats("^[0-9]{500}$")).toBeNull();
    });

    it("bails on an unterminated character class", () => {
      expect(unrollRepeats("^[0-9{4}$")).toBeNull();
    });

    it("bails on a truncated escape", () => {
      expect(unrollRepeats("^\\")).toBeNull();
    });

    it("keeps a lone surrogate from being unrolled as its own atom", () => {
      expect(unrollRepeats("^\u{1f600}{4}$")).toBeNull();
    });

    // Generated patterns are flag-less, so Annex B's identity-escape fallback
    // applies: `\p{L}` is the letter `p` plus three literal characters, and
    // `\uZZZZ` is `u` plus four literal `Z`s. Treating either as a single atom
    // would attach the following quantifier to the wrong character, so every
    // escape whose extent depends on flags or on group count must bail.
    it.each([
      String.raw`^\uZZZZ{4}$`,
      String.raw`^\p{L}{4}$`,
      String.raw`^\P{L}{4}$`,
      String.raw`^\k<n>{4}$`,
      String.raw`^\xZZ{4}$`,
      String.raw`^\x4{4}$`,
      String.raw`^\c9{4}$`,
      String.raw`^\c{4}$`,
      String.raw`^\12{4}$`,
    ])("bails on the ambiguous escape in %s", (source) => {
      expect(unrollRepeats(source)).toBeNull();
    });

    it.each([
      [String.raw`^\1{4}$`, String.raw`^\1\1\1\1$`],
      [String.raw`^\x41{4}$`, String.raw`^\x41\x41\x41\x41$`],
      [String.raw`^\cA{4}$`, String.raw`^\cA\cA\cA\cA$`],
      [String.raw`^A{4}$`, String.raw`^AAAA$`],
    ])("unrolls the well-formed escape in %s", (source, expected) => {
      expect(unrollRepeats(source)).toBe(expected);
    });
  });

  describe("rewrites are behavior-preserving", () => {
    /** Deterministic PRNG so a failure reproduces exactly. */
    const makeRandom = (seed: number) => {
      let state = seed;
      return () => {
        state = (state * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
        return state / 0x7f_ff_ff_ff;
      };
    };

    const CORPUS_ALPHABET = "abzABZ0189f-_.:/=@+ {}[]\\\n";

    /** Sample strings: the seeds, every single-character mutation, and random noise. */
    function corpus(seeds: readonly string[], seed: number): string[] {
      const out = ["", ...seeds];
      for (const s of seeds) {
        for (let i = 0; i < s.length; i++) {
          out.push(s.slice(0, i) + s.slice(i + 1));
          for (const ch of CORPUS_ALPHABET) {
            out.push(s.slice(0, i) + ch + s.slice(i + 1), s.slice(0, i) + ch + s.slice(i));
          }
        }
      }
      const random = makeRandom(seed);
      for (let i = 0; i < 4_000; i++) {
        const length = Math.floor(random() * 40);
        let s = "";
        for (let j = 0; j < length; j++) {
          s += CORPUS_ALPHABET[Math.floor(random() * CORPUS_ALPHABET.length)] as string;
        }
        out.push(s);
      }
      return out;
    }

    function expectEquivalent(source: string, rewritten: string, seeds: readonly string[]): void {
      const original = new RegExp(source);
      const fast = new RegExp(rewritten);
      for (const [index, sample] of corpus(seeds, source.length * 7 + 13).entries()) {
        if (original.test(sample) !== fast.test(sample)) {
          throw new Error(
            `pattern ${source}\nrewritten ${rewritten}\ndiverges on sample #${index} ${JSON.stringify(sample)}: ` +
              `original=${original.test(sample)} rewritten=${fast.test(sample)}`,
          );
        }
      }
    }

    const patterns: [string, string[]][] = [
      ["^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}$", ["3f2504e0-4f89", "3f2504e0-4f8", "3f2504e0-4f899"]],
      ["^\\d{6,14}$", ["123456", "12345", "123456789012345"]],
      ["^[a-z]{4,}$", ["abcd", "abc", "abcdefgh"]],
      ["^a{4}b{4}$", ["aaaabbbb", "aaabbbb"]],
      ["^(?:[0-9]{4}-)+[a-z]{4}$", ["1234-abcd", "1234-5678-abcd", "123-abcd"]],
      ["^[^\\s-]{8,}$", ["abcdefgh", "abcdefg", "abc defgh"]],
      ["^\\.{4}$", ["....", "..."]],
      ["^[\\]]{4}$", ["]]]]", "]]]"]],
      ["^\\u0041{4}$", ["AAAA", "AAA"]],
    ];

    for (const [source, seeds] of patterns) {
      it(`preserves behavior for ${source}`, () => {
        const rewritten = unrollRepeats(source);
        expect(rewritten, `expected ${source} to be rewritten`).not.toBeNull();
        expectEquivalent(source, rewritten as string, seeds);
      });
    }

    // The registry is the set of patterns real schemas actually run. If Zod
    // changes one upstream, this catches a rewrite that stops being equivalent.
    describe("every well-known registry pattern", () => {
      const SEEDS: Record<string, string[]> = {
        __zcReBase64: ["aGVsbG8gd29ybGQ=", "aGVsbG8="],
        __zcReBase64Url: ["aGVsbG8"],
        __zcReCuid: ["cjld2cjxh0000qzrmn831i7rn"],
        __zcReCuid2: ["tz4a98xxat96iws9zmbrgj3a"],
        __zcReE164: ["+14155552671"],
        __zcReEmail: ["john@example.com", "a.b'c+d@sub.example.co.uk"],
        __zcReGuid: ["3f2504e0-4f89-41d3-9a0c-0305e82c3301"],
        __zcReIpv4: ["192.168.1.1"],
        __zcReIpv6: ["2001:0db8:85a3:0000:0000:8a2e:0370:7334", "::1"],
        __zcReKsuid: ["2naeRjTrKbDPVJEXBTGfAP1H3Kz"],
        __zcReNanoid: ["V1StGXR8_Z5jdHi6B-myT"],
        __zcReUlid: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"],
        __zcReUuid: [
          "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
          "00000000-0000-0000-0000-000000000000",
        ],
        __zcReXid: ["9m4e2mr0ui3e8a215n4g"],
      };

      for (const entry of WELL_KNOWN_REGEXES) {
        it(`${entry.name} runs an equivalent pattern`, () => {
          const testSource = fastTestSource(entry.source);
          if (testSource === null) return; // used verbatim
          expectEquivalent(entry.source, testSource, SEEDS[entry.name] ?? []);
        });
      }
    });

    // Zod's live patterns, not the registry copies — the compiler rewrites
    // whatever source the installed Zod version actually produces.
    describe("every Zod string format, as extracted", () => {
      const formats: [string, z.ZodType, string[]][] = [
        ["email", z.email(), ["john@example.com"]],
        ["uuid", z.uuid(), ["3f2504e0-4f89-41d3-9a0c-0305e82c3301"]],
        ["guid", z.guid(), ["3f2504e0-4f89-41d3-9a0c-0305e82c3301"]],
        ["nanoid", z.nanoid(), ["V1StGXR8_Z5jdHi6B-myT"]],
        ["ulid", z.ulid(), ["01ARZ3NDEKTSV4RRFFQ69G5FAV"]],
        ["cuid", z.cuid(), ["cjld2cjxh0000qzrmn831i7rn"]],
        ["cuid2", z.cuid2(), ["tz4a98xxat96iws9zmbrgj3a"]],
        ["xid", z.xid(), ["9m4e2mr0ui3e8a215n4g"]],
        ["ksuid", z.ksuid(), ["2naeRjTrKbDPVJEXBTGfAP1H3Kz"]],
        ["ipv4", z.ipv4(), ["192.168.1.1"]],
        ["ipv6", z.ipv6(), ["::1"]],
        ["base64", z.base64(), ["aGVsbG8="]],
        ["e164", z.e164(), ["+14155552671"]],
        ["iso.date", z.iso.date(), ["2024-06-15", "2024-02-29"]],
        ["iso.time", z.iso.time(), ["12:34:56"]],
        ["iso.datetime", z.iso.datetime(), ["2024-06-15T12:34:56Z"]],
      ];

      for (const [name, schema, seeds] of formats) {
        it(`${name}`, () => {
          const ir = extractSchema(schema, []);
          expect(ir.type).toBe("string");
          const check = (ir as Extract<typeof ir, { type: "string" }>).checks.find(
            (c) => c.kind === "string_format",
          );
          const pattern = check && "pattern" in check ? check.pattern : undefined;
          expect(pattern, `${name} produced no pattern`).toBeTypeOf("string");
          const testSource = fastTestSource(pattern as string);
          if (testSource === null) return;
          expectEquivalent(pattern as string, testSource, seeds);
        });
      }
    });
  });

  describe("emitted validators still report zod's original pattern", () => {
    it("keeps the un-rewritten source in the issue", () => {
      const schema = z.object({ id: z.uuid() });
      const zodIssue = schema.safeParse({ id: "nope" }).error?.issues[0] as
        | Record<string, unknown>
        | undefined;
      // The compiled path is covered by tests/zod-parity.test.ts; this asserts
      // the shape the rewrite must not disturb.
      expect(zodIssue?.pattern).toBeTypeOf("string");
      expect(String(zodIssue?.pattern)).toContain("{12}");
    });
  });
});
