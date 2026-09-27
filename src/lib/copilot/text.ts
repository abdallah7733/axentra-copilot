/* Text helpers for recognised speech: lower-case words, number words, fuzzy matching. */

/** Lower case, straight apostrophes, hyphens and punctuation to spaces. Keeps "$" and digits. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/(\d),(\d{3})\b/g, "$1$2")
    .replace(/[^\p{L}\p{N}'$@.\s-]/gu, " ")
    .replace(/(\p{L})\.(?=\p{L})/gu, "$1 dot ")
    .replace(/[.\-]/g, " ")
    .replace(/(^|\s)'|'(\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const words = (text: string): string[] => (normalize(text) ? normalize(text).split(" ") : []);

const units: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const tens: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** The value of a number word ("four" → 4, "twenty" → 20), or null. */
export function numberWord(word: string): number | null {
  if (word in units) return units[word];
  if (word in tens) return tens[word];
  return null;
}

export const isTens = (word: string) => word in tens;

/** Edit distance with adjacent transpositions (Damerau–Levenshtein, optimal string alignment). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** A heard word is close enough to an expected one: exact for short words, one edit for longer ones. */
export const sameWord = (heard: string, expected: string) =>
  heard === expected || (expected.length >= 4 && heard.length >= 3 && editDistance(heard, expected) <= 1);

/** True if a negation ("not", "don't", "no") comes up to three words before position `index`. */
export function negatedAt(tokens: string[], index: number): boolean {
  for (let i = Math.max(0, index - 3); i < index; i++) {
    if (/^(not|no|never|don't|dont|doesn't|doesnt|isn't|isnt|wasn't|wasnt|didn't|didnt|without)$/.test(tokens[i])) return true;
  }
  return false;
}

/** Finds a phrase pattern in normalised text and reports whether it is negated. */
export function findPhrase(text: string, pattern: RegExp): { phrase: string; negated: boolean } | null {
  const norm = normalize(text);
  const match = new RegExp(pattern.source, pattern.flags.replace("g", "")).exec(norm);
  if (!match) return null;
  const before = norm.slice(0, match.index).trim();
  const tokens = before ? before.split(" ") : [];
  return { phrase: match[0].trim(), negated: negatedAt(tokens, tokens.length) };
}
