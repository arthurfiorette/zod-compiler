/**
 * Bounded-repeat unrolling for `.test()` regexes.
 *
 * V8's irregexp compiles a counted quantifier (`[0-9a-fA-F]{12}`) into a
 * backtrack-capable loop carrying a counter register, but compiles the same
 * atom written out (`[0-9a-fA-F][0-9a-fA-F]…`) into straight-line matching
 * code. Rewriting one into the other is purely structural — the language the
 * pattern accepts is unchanged — and is worth a lot on exactly the string
 * formats everyday schemas lean on:
 *
 *   z.uuid()   3.1x    z.guid()   3.4x    z.ksuid()  2.7x
 *   z.xid()    2.2x    z.ulid()   2.1x    z.base64() 2.1x
 *   z.nanoid() 1.9x    z.e164()   1.5x    z.iso.date() 1.3x
 *
 * Measured on V8 13.x (node 24). The win starts at `{4}` (1.28x) and grows
 * with the count (2.7x at `{64}`); `{2}`/`{3}` are a wash, which is what
 * {@link MIN_REPEAT} encodes.
 *
 * The rewrite applies only to quantifiers whose atom is a SINGLE CHARACTER
 * matcher — a character class, an escape, or a literal character. A group's
 * repeat is left alone: unrolling it would duplicate capture groups and
 * renumber every backreference after it. Anything the scanner cannot account
 * for exactly makes the whole transform bail (`null`), leaving the original
 * pattern in place.
 *
 * Callers must keep reporting the ORIGINAL source in issues — the rewritten
 * regex's `toString()` would otherwise leak into `pattern:` and diverge from
 * zod. See `emitRegexSourceString`.
 */

/**
 * Smallest mandatory repeat count worth unrolling. Below this the counter loop
 * and the straight-line form measure the same (0.97-1.00x), so leaving the
 * pattern untouched keeps generated output smaller for no speed cost.
 */
const MIN_REPEAT = 4;

/**
 * Largest repeat count unrolled. A `{500}` would expand to a pattern longer
 * than anything it could save, so it keeps the counter loop.
 */
const MAX_REPEAT = 64;

/** Largest `max - min` optional tail expanded (`{6,14}` → 6 copies + 8 `?` copies). */
const MAX_OPTIONAL = 32;

/**
 * Total characters the rewrite may add across a whole pattern. Once spent,
 * later quantifiers are copied verbatim — the rewrite degrades gradually
 * instead of failing, and emitted size stays bounded for hand-written patterns.
 */
const GROWTH_BUDGET = 2_048;

/** Characters that begin something other than a literal single-character atom. */
const NON_ATOM = new Set(["^", "$", "|", "(", ")", "*", "+", "?"]);

/**
 * Rewrite bounded repeats of single-character atoms into explicit repetition.
 * Returns `null` when nothing changed or the pattern could not be scanned
 * exactly (in which case the caller keeps the original source).
 */
export function unrollRepeats(source: string): string | null {
  let out = "";
  let index = 0;
  /** Offset in `out` where the most recent atom starts, or -1 when the preceding construct is not a single-character atom. */
  let atomOffset = -1;
  let budget = GROWTH_BUDGET;
  let changed = false;

  while (index < source.length) {
    const char = source[index] as string;

    if (char === "\\") {
      const end = readEscape(source, index);
      if (end === null) return null;
      atomOffset = out.length;
      out += source.slice(index, end);
      index = end;
      continue;
    }

    if (char === "[") {
      const end = readClass(source, index);
      if (end === null) return null;
      atomOffset = out.length;
      out += source.slice(index, end);
      index = end;
      continue;
    }

    if (char === "{") {
      const quantifier = readQuantifier(source, index);
      if (quantifier !== null) {
        const expansion =
          // A lazy quantifier (`{n,m}?`) prefers the shortest match; the
          // unrolled form's `?` copies are greedy, so it is left alone.
          source[quantifier.end] === "?" || atomOffset < 0
            ? null
            : expand(out.slice(atomOffset), quantifier, budget);
        if (expansion === null) {
          out += source.slice(index, quantifier.end);
        } else {
          budget -= expansion.length - (out.length - atomOffset);
          out = out.slice(0, atomOffset) + expansion;
          changed = true;
        }
        // A quantifier cannot itself be quantified, so whatever follows starts
        // a fresh atom.
        atomOffset = -1;
        index = quantifier.end;
        continue;
      }
      // Not a valid quantifier — an unescaped `{` is a literal in Annex B.
    }

    atomOffset = NON_ATOM.has(char) || isSurrogate(char) ? -1 : out.length;
    out += char;
    index += 1;
  }

  return changed ? out : null;
}

/** Repeated-atom form of `atom{min,max}`, or null when it is not worth (or safe to) expand. */
function expand(
  atom: string,
  { min, max }: { max: number; min: number },
  budget: number,
): string | null {
  if (min < MIN_REPEAT || min > MAX_REPEAT) return null;
  const optional = max === Infinity ? 0 : max - min;
  if (optional > MAX_OPTIONAL) return null;
  const mandatory = atom.repeat(min);
  const tail = max === Infinity ? `${atom}*` : `${atom}?`.repeat(optional);
  const expansion = mandatory + tail;
  // `atom{min,max}` is being replaced by `expansion`; charge the difference.
  if (expansion.length - atom.length > budget) return null;
  return expansion;
}

/** True for a lone UTF-16 surrogate code unit, which is never treated as its own atom. */
function isSurrogate(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 0xd8_00 && code <= 0xdf_ff;
}

/**
 * End offset (exclusive) of the escape sequence starting at `start`, or null
 * when the sequence is not one whose extent is unambiguous.
 *
 * Everything here hinges on the caller only passing FLAG-LESS patterns, where
 * Annex B's "identity escape" fallback makes several sequences mean something
 * other than they would under `u`: `\p{L}` is the letter `p` followed by three
 * literal characters, not a property escape, and `\uZZZZ` is `u` followed by
 * four literal `Z`s. Consuming those as one atom would attach a following
 * quantifier to the wrong character, so the well-formed fixed-width escapes
 * are recognised exactly and every ambiguous form bails.
 */
function readEscape(source: string, start: number): number | null {
  const next = source[start + 1];
  if (next === undefined) return null;

  // Property escapes and named backreferences read differently with and
  // without the `u` flag — never worth resolving for the sake of a rewrite.
  if (next === "p" || next === "P" || next === "k") return null;

  // `\12` may be backreference 12 or backreference 1 followed by a literal 2,
  // depending on how many groups the pattern has.
  if (next >= "0" && next <= "9") {
    const after = source[start + 2];
    return after !== undefined && after >= "0" && after <= "9" ? null : start + 2;
  }

  if (next === "u") return fixedWidth(source, start, 4, isHexDigit);
  if (next === "x") return fixedWidth(source, start, 2, isHexDigit);
  if (next === "c") return fixedWidth(source, start, 1, isAsciiLetter);

  // Character-class escapes (`\d`, `\w`, `\s`), control escapes (`\n`, `\t`)
  // and identity escapes (`\.`, `\\`, `\{`) are all one character wide.
  return start + 2;
}

/** End offset of `\<kind>` plus exactly `width` chars satisfying `valid`, or null. */
function fixedWidth(
  source: string,
  start: number,
  width: number,
  valid: (char: string) => boolean,
): number | null {
  const end = start + 2 + width;
  if (end > source.length) return null;
  for (let index = start + 2; index < end; index++) {
    if (!valid(source[index] as string)) return null;
  }
  return end;
}

function isHexDigit(char: string): boolean {
  return /[0-9a-fA-F]/.test(char);
}

function isAsciiLetter(char: string): boolean {
  return /[a-zA-Z]/.test(char);
}

/**
 * End offset (exclusive) of the character class starting at `start`, or null
 * when unterminated. The first unescaped `]` closes the class — `[]]` is an
 * empty class followed by a literal `]`, not a class containing `]`.
 */
function readClass(source: string, start: number): number | null {
  let index = start + 1;
  if (source[index] === "^") index += 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      const end = readEscape(source, index);
      if (end === null) return null;
      index = end;
      continue;
    }
    // A `v`-mode nested class would need its own nesting rules; callers only
    // pass flag-less patterns, where `[` inside a class is a literal.
    if (char === "]") return index + 1;
    index += 1;
  }
  return null;
}

/**
 * Parse `{n}`, `{n,}` or `{n,m}` at `start`. Returns null when the braces do
 * not form a quantifier, which Annex B treats as literal `{` characters.
 */
function readQuantifier(
  source: string,
  start: number,
): { end: number; max: number; min: number } | null {
  const close = source.indexOf("}", start);
  if (close === -1) return null;
  const body = source.slice(start + 1, close);
  const match = /^(\d+)(?:,(\d*))?$/.exec(body);
  if (!match) return null;
  const min = Number(match[1]);
  const max =
    match[2] === undefined ? min : match[2] === "" ? Infinity : Number(match[2] as string);
  if (max < min) return null;
  return { end: close + 1, max, min };
}
