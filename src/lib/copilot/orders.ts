import { editDistance, isTens, numberWord, words } from "./text";
import type { Order } from "./types";

/*
  Spoken order numbers are the weakest part of recognition: "427" has come out as
  "4 to 7", "for 27" and "527". The engine must not rewrite these ("4 to 7 days" is
  real speech). The copilot knows when an order number is expected, so it reads the
  possible numbers here and matches them only against the verified customer's own
  orders, asking the agent to confirm anything that was not heard exactly.
*/

/** How a number was read from the words. */
export type MentionMethod =
  /** Digits as recognised: "427". */
  | "exact"
  /** Number words with nothing guessed: "four two seven", "four twenty-seven". */
  | "spoken"
  /** A sound-alike word stood in for a digit: "4 to 7", "for 27". */
  | "sound-alike";

export type OrderMention = {
  /** The words as heard, for "matched from '4 to 7'". */
  heard: string;
  /** Digit strings the words could mean, most likely first. */
  candidates: string[];
  method: MentionMethod;
  /** Said right after "order" (or "order number is"). */
  anchored: boolean;
};

const ANCHORS = new Set(["order", "orders"]);
const FILLERS = new Set(["number", "no", "num", "is", "it's", "its", "was", "id", "the", "uh", "um", "like"]);
/** Words that make a number a duration, price, size or time rather than an order number. */
const UNITS = /^(days?|business|working|weeks?|months?|years?|hours?|minutes?|mins?|seconds?|dollars?|bucks?|cents?|percent|gb|gigs?|tb|inch(es)?|am|pm|o'clock|units?|times?|items?|pieces?)$/;
/** Words recognition writes instead of a digit. */
const SOUND_ALIKES: Record<string, string> = { to: "2", too: "2", for: "4", ate: "8", won: "1", oh: "0" };

type Piece = { word: string; options: string[]; real: boolean; soundAlike: boolean; span: number };

/** Reads one numeric-ish word (or a tens + unit pair such as "twenty seven") at `i`. */
function piece(tokens: string[], i: number): Piece | null {
  const word = tokens[i];
  if (word === undefined) return null;
  if (/^\d+$/.test(word)) return { word, options: [word], real: true, soundAlike: false, span: 1 };
  const value = numberWord(word);
  if (value !== null) {
    const next = tokens[i + 1] !== undefined ? numberWord(tokens[i + 1]) : null;
    if (isTens(word) && next !== null && next > 0 && next < 10) {
      return { word: `${word} ${tokens[i + 1]}`, options: [String(value + next)], real: true, soundAlike: false, span: 2 };
    }
    return { word, options: [String(value)], real: true, soundAlike: false, span: 1 };
  }
  if (word in SOUND_ALIKES) return { word, options: [SOUND_ALIKES[word], ""], real: false, soundAlike: true, span: 1 };
  return null;
}

/** All digit strings a run of pieces can spell, keeping the given lengths. */
function spell(pieces: Piece[], lengths: Set<number>): string[] {
  let out = [""];
  for (const p of pieces) out = out.flatMap((prefix) => p.options.map((o) => prefix + o));
  // Prefer readings that use every sound-alike as a digit ("4 to 7" → 427 before 47).
  return [...new Set(out)].filter((s) => lengths.has(s.length)).sort((a, b) => b.length - a.length);
}

/**
 * Finds order-number mentions in one line. `idLengths` are the lengths of the client's
 * order numbers. `expectingOrder` is true right after the agent asked for the order
 * number, which is the only time an un-anchored "4 to 7" is read as an order.
 */
export function findOrderMentions(text: string, idLengths: number[], expectingOrder = false): OrderMention[] {
  const tokens = words(text);
  const lengths = new Set(idLengths.flatMap((n) => [n - 1, n, n + 1]).filter((n) => n > 0));
  const exactLengths = new Set(idLengths);
  const mentions: OrderMention[] = [];
  const used = new Set<number>();

  const readRun = (start: number) => {
    const pieces: Piece[] = [];
    let i = start;
    while (pieces.length < 4) {
      const p = piece(tokens, i);
      if (!p) break;
      pieces.push(p);
      i += p.span;
    }
    // A trailing sound-alike is just the next word ("427 for my son").
    while (pieces.length && !pieces[pieces.length - 1].real) {
      pieces.pop();
      i -= 1;
    }
    return { pieces, end: i };
  };

  const accept = (start: number, pieces: Piece[], end: number, anchored: boolean) => {
    if (!pieces.some((p) => p.real)) return;
    if (tokens[end] !== undefined && UNITS.test(tokens[end])) return;
    if (tokens[start - 1] === "$" || tokens[start]?.startsWith("$")) return;
    const soundAlike = pieces.some((p) => p.soundAlike);
    const digitsOnly = pieces.length === 1 && /^\d+$/.test(pieces[0].word);
    const candidates = spell(pieces, anchored ? lengths : exactLengths);
    if (!candidates.length) return;
    // Un-anchored numbers are only order numbers when they look exactly like one.
    if (!anchored && (soundAlike ? !expectingOrder : !exactLengths.has(candidates[0].length))) return;
    for (let k = start; k < end; k++) used.add(k);
    mentions.push({
      heard: pieces.map((p) => p.word).join(" "),
      candidates,
      method: soundAlike ? "sound-alike" : digitsOnly ? "exact" : "spoken",
      anchored,
    });
  };

  // Anchored: "order 427", "order number is 4 to 7", "order for 27".
  tokens.forEach((token, a) => {
    if (!ANCHORS.has(token)) return;
    let start = a + 1;
    for (let skipped = 0; skipped < 3 && FILLERS.has(tokens[start]) && !piece(tokens, start)?.real; skipped++) start++;
    const { pieces, end } = readRun(start);
    accept(start, pieces, end, true);
  });

  // Un-anchored: "It's 427", "four two seven".
  for (let i = 0; i < tokens.length; i++) {
    if (used.has(i) || !piece(tokens, i)?.real) continue;
    // Start a run at a sound-alike just before the number ("for 27") when an order is expected.
    const start = expectingOrder && i > 0 && tokens[i - 1] in SOUND_ALIKES && !used.has(i - 1) ? i - 1 : i;
    const { pieces, end } = readRun(start);
    if (pieces.length) accept(start, pieces, end, false);
    i = Math.max(i, end - 1);
  }
  return mentions;
}

export type OrderMatch = {
  order: Order;
  /** exact/spoken/sound-alike come from the mention; "closest" and "only-recent" are guesses from the customer's orders. */
  method: MentionMethod | "closest" | "only-recent";
  mention: OrderMention | null;
  needsConfirmation: boolean;
  /** Plain-language explanation for the panel. */
  note: string;
};

/**
 * Matches mentions against ONE customer's orders. Callers pass only the verified
 * customer's orders, so another customer's order (a mis-heard "527") can never match.
 */
export function matchOrder(mentions: OrderMention[], customerOrders: Order[], claimWindowDays: number): OrderMatch | null {
  const byId = new Map(customerOrders.map((o) => [o.id, o]));
  for (const m of mentions) {
    const hit = m.candidates.find((c) => byId.has(c));
    if (hit) {
      const fuzzy = m.method === "sound-alike";
      return {
        order: byId.get(hit)!,
        method: m.method,
        mention: m,
        needsConfirmation: fuzzy,
        note: fuzzy ? `Matched from "${m.heard}". Confirm with the caller.` : `Heard "${m.heard}".`,
      };
    }
  }
  for (const m of mentions) {
    // Nearest of the customer's own orders, one digit away; a tie means ask, not guess.
    const scored = customerOrders
      .map((o) => ({ o, d: Math.min(...m.candidates.map((c) => editDistance(c, o.id))) }))
      .filter((x) => x.d <= 1)
      .sort((a, b) => a.d - b.d);
    if (scored.length === 1 || (scored.length > 1 && scored[0].d < scored[1].d)) {
      return {
        order: scored[0].o,
        method: "closest",
        mention: m,
        needsConfirmation: true,
        note: `The customer has no order ${m.candidates[0]}. Closest of their orders is ${scored[0].o.id}. Confirm with the caller.`,
      };
    }
  }
  if (!mentions.length) {
    const recent = customerOrders.filter((o) => o.deliveredDaysAgo !== null && o.deliveredDaysAgo <= claimWindowDays);
    if (recent.length === 1) {
      return {
        order: recent[0],
        method: "only-recent",
        mention: null,
        needsConfirmation: true,
        note: `No order number heard. ${recent[0].id} is the customer's only order delivered in the last ${claimWindowDays} days. Confirm with the caller.`,
      };
    }
  }
  return null;
}
