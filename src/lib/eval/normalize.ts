/*
  Step 7 v1 reference normalization (02_SCORING_AND_NORMALIZATION, section 2), applied identically
  to the reference and the hypothesis. Written separately from the copilot's own text helpers on
  purpose: the scorer must not share a bug with the code it measures.

  Two word views come out of it:
  - conventional words, with every numeral expanded to number words, for conventional WER;
  - number-collapsed tokens, where each number span is one token, for NC-ER.
  The interpretations of v1 this needed are listed in README.md ("How v1 is read").
*/

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const UNIT_NAMES = Object.keys(UNITS);
const TENS_NAMES = Object.fromEntries(Object.entries(TENS).map(([w, n]) => [n, w]));

/** Words after a number that make it a duration or amount: "four to seven days", "129 dollars". */
export const MEASURE = /^(days?|weeks?|months?|years?|hours?|minutes?|mins?|seconds?|dollars?|bucks?|cents?|business|working)$/;

/** Declared equivalences (2.1, rule 4): each pair counts as identical. */
const EQUIVALENT: Record<string, string[]> = {
  "it's": ["it", "is"],
  "i'd": ["i", "would"],
  "i'm": ["i", "am"],
  "don't": ["do", "not"],
  ok: ["okay"],
};
const FILLERS = new Set(["uh", "um", "er", "hmm"]);

export type Normalized = { words: string[]; unclear: string[] };

/**
 * Normalized words of one text: lower case, straight quotes, no punctuation except an apostrophe
 * inside a word, hyphens as spaces, equivalences expanded, fillers removed. "[pause …]" marks are
 * not words; "[unclear …]" spans are left out and listed. Numerals stay numerals here.
 */
export function normalizeText(text: string): Normalized {
  const unclear: string[] = [];
  let t = text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\[unclear[^\]]*\]/g, (m) => {
      unclear.push(m);
      return " ";
    })
    .replace(/\[pause[^\]]*\]/g, " ")
    // "$129" is an amount: "129 dollars", so it reads the same as the spoken form.
    .replace(/\$(\d[\d,]*)/g, "$1 dollars")
    .replace(/(\d),(\d{3})\b/g, "$1$2")
    // Digits joined by hyphens ("0-6-2-9-1") are digits said one by one.
    .replace(/\b\d(?:-\d){2,}\b/g, (m) => m.replace(/-/g, " "))
    // A written range before a unit ("4-7 days") is the spoken "4 to 7 days".
    .replace(/\b(\d{1,3})-(\d{1,3})(?=\s+(days?|weeks?|months?|years?|hours?|minutes?|business|working)\b)/g, "$1 to $2")
    .replace(/-/g, " ")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/(^|[^\p{L}])'+|'+(?=[^\p{L}]|$)/gu, "$1 ");
  t = t.replace(/\s+/g, " ").trim();
  const words: string[] = [];
  for (const w of t ? t.split(" ") : []) {
    if (FILLERS.has(w)) continue;
    words.push(...(EQUIVALENT[w] ?? [w]));
  }
  return { words: canonicalHundreds(words), unclear };
}

/** "a hundred and twenty nine" → "one hundred twenty nine", on both sides (2.2 equal forms of AMOUNT). */
function canonicalHundreds(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "a" && words[i + 1] === "hundred") out.push("one");
    else if (w === "and" && words[i - 1] === "hundred" && words[i + 1] !== undefined && (words[i + 1] in UNITS || words[i + 1] in TENS)) continue;
    else out.push(w);
  }
  return out;
}

const isNumeral = (w: string) => /^\d+$/.test(w);
const isNumberWord = (w: string) => w in UNITS || w in TENS;

/** Cardinal words for 0 to 999: 48 → "forty eight", 129 → "one hundred twenty nine". */
function cardinalWords(n: number): string[] {
  if (n < 20) return [UNIT_NAMES[n]];
  if (n < 100) return n % 10 ? [TENS_NAMES[n - (n % 10)], UNIT_NAMES[n % 10]] : [TENS_NAMES[n]];
  const rest = n % 100;
  return [UNIT_NAMES[Math.floor(n / 100)], "hundred", ...(rest ? cardinalWords(rest) : [])];
}

/**
 * Conventional words: each numeral becomes number words. Digit by digit when it has a leading
 * zero, four or more digits, or follows "order" ("order 714" → "seven one four"); otherwise as a
 * cardinal ("48" → "forty eight"). The rule is fixed and doesn't look at the reference.
 */
export function conventionalWords(text: string): string[] {
  const { words } = normalizeText(text);
  const out: string[] = [];
  words.forEach((w, i) => {
    if (!isNumeral(w)) return void out.push(w);
    const afterOrder = words[i - 1] === "order" || (/^(number|is)$/.test(words[i - 1] ?? "") && words[i - 2] === "order") || (words[i - 1] === "is" && words[i - 2] === "number" && words[i - 3] === "order");
    if (w.length >= 4 || (w.startsWith("0") && w.length > 1) || afterOrder) out.push(...[...w].map((d) => UNIT_NAMES[Number(d)]));
    else out.push(...cardinalWords(Number(w)));
  });
  return out;
}

/* ---------- Number-collapsed tokens (NC-ER) ---------- */

/**
 * How a number was written or said:
 * - "numeral": one written number ("58316", "48");
 * - "digits": two or more single digits ("five eight three one six", "0 6 2 9 4", "oh six …");
 * - "cardinal": a number said as a value ("forty eight", "one hundred twenty nine", "seven");
 * - "mixed": anything else that runs numbers together ("four twenty seven", "714 26").
 */
export type NumForm = "numeral" | "digits" | "cardinal" | "mixed";
export type NumToken = { kind: "num"; digits: string; value: number | null; form: NumForm; text: string; tag?: string };
export type RangeToken = { kind: "range"; from: number; to: number; unit: string; text: string; tag?: string };
export type WordToken = { kind: "word"; word: string };
export type Token = WordToken | NumToken | RangeToken;

type Piece = { digits: string; value: number; single: boolean; written: boolean; words: string[] };

/** Reads one number piece at i: a numeral, "oh", a number word, a tens+unit pair, or an "N hundred M" value. */
function readPiece(words: string[], i: number, inRun: boolean): { piece: Piece; next: number } | null {
  const w = words[i];
  if (w === undefined) return null;
  if (isNumeral(w)) return { piece: { digits: w, value: Number(w), single: w.length === 1, written: true, words: [w] }, next: i + 1 };
  // "oh" is a zero only inside a run of digits: "oh six two nine four", never a bare "Oh, okay".
  if (w === "oh") {
    const after = words[i + 1];
    const digitAfter = after !== undefined && ((after in UNITS && UNITS[after] < 10) || /^\d$/.test(after));
    return digitAfter || inRun ? { piece: { digits: "0", value: 0, single: true, written: false, words: [w] }, next: i + 1 } : null;
  }
  if (!isNumberWord(w)) return null;
  let value = w in UNITS ? UNITS[w] : TENS[w];
  let next = i + 1;
  const used = [w];
  if (w in TENS && words[next] in UNITS && UNITS[words[next]] > 0 && UNITS[words[next]] < 10) {
    value += UNITS[words[next]];
    used.push(words[next]);
    next++;
  }
  if (words[next] === "hundred" && value > 0 && value < 10) {
    value *= 100;
    used.push("hundred");
    next++;
    const rest = words[next];
    if (rest !== undefined && isNumberWord(rest)) {
      let add = rest in UNITS ? UNITS[rest] : TENS[rest];
      used.push(rest);
      next++;
      if (rest in TENS && words[next] in UNITS && UNITS[words[next]] > 0 && UNITS[words[next]] < 10) {
        add += UNITS[words[next]];
        used.push(words[next]);
        next++;
      }
      value += add;
    }
    return { piece: { digits: String(value), value, single: false, written: false, words: used }, next };
  }
  return { piece: { digits: String(value), value, single: value < 10 && used.length === 1, written: false, words: used }, next };
}

function runToken(pieces: Piece[]): NumToken {
  const text = pieces.flatMap((p) => p.words).join(" ");
  const digits = pieces.map((p) => p.digits).join("");
  if (pieces.length === 1) {
    const p = pieces[0];
    return p.written ? { kind: "num", digits, value: Number(digits), form: "numeral", text } : { kind: "num", digits, value: p.value, form: "cardinal", text };
  }
  if (pieces.every((p) => p.single)) return { kind: "num", digits, value: null, form: "digits", text };
  return { kind: "num", digits, value: null, form: "mixed", text };
}

/**
 * Number-collapsed tokens of one or more lines. Each run of numbers becomes one token, and
 * "NUM to NUM <unit>" becomes one range token. A line boundary ends a run: a number split over
 * two transcript lines is two tokens, not one.
 */
export function collapsedTokens(lines: string | string[]): Token[] {
  const out: Token[] = [];
  for (const line of typeof lines === "string" ? [lines] : lines) {
    const { words } = normalizeText(line);
    const tokens: Token[] = [];
    let i = 0;
    while (i < words.length) {
      const pieces: Piece[] = [];
      let j = i;
      for (let r = readPiece(words, j, false); r; r = readPiece(words, j, true)) {
        pieces.push(r.piece);
        j = r.next;
      }
      if (pieces.length) {
        tokens.push(runToken(pieces));
        i = j;
      } else tokens.push({ kind: "word", word: words[i++] });
    }
    // Ranges: "4 to 7 days", "four to seven days".
    for (let k = 0; k + 3 < tokens.length; k++) {
      const [a, to, b, unit] = tokens.slice(k, k + 4);
      if (a?.kind === "num" && a.value !== null && to?.kind === "word" && to.word === "to" && b?.kind === "num" && b.value !== null && unit?.kind === "word" && MEASURE.test(unit.word) && !/^dollars?$/.test(unit.word)) {
        tokens.splice(k, 4, { kind: "range", from: a.value, to: b.value, unit: unit.word.replace(/s$/, ""), text: `${a.text} to ${b.text} ${unit.word}` });
      }
    }
    out.push(...tokens);
  }
  return out;
}

/** Tags the reference's number and range tokens with its spans, in order (ORDER_ID, AMOUNT, …). */
export function tagReference(tokens: Token[], spans: { tag: string }[]): Token[] {
  const numberTags = spans.filter((s) => /^(ORDER_ID|ORDER_ID_SUPERSEDED|AMOUNT|HOUSE_NO)$/.test(s.tag)).map((s) => s.tag);
  const rangeTags = spans.filter((s) => s.tag === "RANGE").map((s) => s.tag);
  const nums = tokens.filter((t) => t.kind === "num");
  const ranges = tokens.filter((t) => t.kind === "range");
  if (nums.length !== numberTags.length || ranges.length !== rangeTags.length) {
    throw new Error(`Reference has ${nums.length} numbers and ${ranges.length} ranges, but its spans tag ${numberTags.length} and ${rangeTags.length}`);
  }
  let n = 0;
  return tokens.map((t) => (t.kind === "num" ? { ...t, tag: numberTags[n++] } : t.kind === "range" ? { ...t, tag: "RANGE" } : t));
}

const ID_TAGS = new Set(["ORDER_ID", "ORDER_ID_SUPERSEDED"]);

/**
 * Whether a hypothesis number equals a tagged reference number (2.2 table):
 * - an order number: the same digits, leading zeros kept, written or said digit by digit (not as a value);
 * - an amount or house number: the same value, written or said as a value ("4 8" is not 48).
 */
export function sameNumber(ref: NumToken, hyp: NumToken): boolean {
  if (ref.tag && ID_TAGS.has(ref.tag)) return hyp.digits === ref.digits && hyp.form !== "cardinal";
  if (ref.tag === "AMOUNT" || ref.tag === "HOUSE_NO") return hyp.value !== null && hyp.value === ref.value && (hyp.form === "numeral" || hyp.form === "cardinal");
  return hyp.digits === ref.digits && hyp.form === ref.form;
}

/** Token equality for NC-ER: words exactly, numbers by their tag, ranges by both ends and the unit. */
export function sameToken(ref: Token, hyp: Token): boolean {
  if (ref.kind === "word") return hyp.kind === "word" && hyp.word === ref.word;
  if (ref.kind === "range") return hyp.kind === "range" && hyp.from === ref.from && hyp.to === ref.to && hyp.unit === ref.unit;
  return hyp.kind === "num" && sameNumber(ref, hyp);
}
