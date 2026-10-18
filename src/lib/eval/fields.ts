/*
  Critical fields read from text (scoring file, section 3), for L1 (first pass) and L2 (checked).
  Exact by rule: no fuzzy matching against the expected answer, and nothing looked up in the
  records. A sound-alike is a field error, labelled so it's clear why (3.1).

  Intent and choice are read here only as "are the deciding words still in the text"; what the
  copilot made of them is L3 (workflow.ts).
*/

import type { DevCase, ExpectedFields } from "./cases";
import { collapsedTokens, MEASURE, normalizeText, sameNumber, type NumToken, type Token } from "./normalize";

export type FieldCode = "OK" | "SPLIT" | "PARTIAL" | "WRONG" | "AMBIGUOUS" | "MISSING" | "INVENTED" | "FROM_RECORD";
export type FieldName = keyof ExpectedFields | "address";
export type FieldResult = { code: FieldCode; note?: string };
export type FieldCodes = Partial<Record<FieldName, FieldResult>>;

const NEGATORS = /^(not|no|never|without|don't|dont|doesn't|didn't|isn't|wasn't)$/;
const DAMAGE = /^(damaged?|broken|cracked|smashed|shattered|scratched|dented|crushed)$/;

/** The fields a case scores, in a fixed order. */
export function fieldsOf(c: DevCase): FieldName[] {
  const order: FieldName[] = ["intent", "choice", "refund_wanted", "order_id", "name", "house_no", "street", "city", "address"];
  const keys = new Set<FieldName>(Object.keys(c.expected) as FieldName[]);
  if (keys.has("street")) keys.add("address");
  return order.filter((k) => keys.has(k));
}

const orderLike = (tokens: Token[]) =>
  tokens.flatMap((t, i): NumToken[] => {
    if (t.kind !== "num") return [];
    const after = tokens[i + 1];
    return after?.kind === "word" && MEASURE.test(after.word) ? [] : [t];
  });

/** "four to seven" with no unit after it: a number with two readings (3.2, AMBIGUOUS). */
const ambiguousTo = (tokens: Token[]) =>
  tokens.some((t, i) => t.kind === "num" && tokens[i + 1]?.kind === "word" && (tokens[i + 1] as { word: string }).word === "to" && tokens[i + 2]?.kind === "num");

/** The order number: the last one said (the final value after a correction), every digit, leading zeros kept. */
export function orderCode(text: string, expected: string): FieldResult {
  const tokens = collapsedTokens(text);
  const candidates = orderLike(tokens);
  const ref: NumToken = { kind: "num", digits: expected, value: null, form: "digits", text: expected, tag: "ORDER_ID" };
  const last = candidates[candidates.length - 1];
  if (last && sameNumber(ref, last)) return { code: "OK" };
  if (ambiguousTo(tokens)) return { code: "AMBIGUOUS", note: "number words joined by \"to\"" };
  if (!last) return { code: "MISSING" };
  if (last.digits.length < expected.length && expected.includes(last.digits)) return { code: "PARTIAL", note: `heard ${last.digits}` };
  return { code: "WRONG", note: `heard ${last.digits}${last.digits === expected ? ` said as a value ("${last.text}")` : ""}` };
}

/** No order number expected (D03): any number that isn't a duration or amount is invented. */
export function noOrderCode(text: string): FieldResult {
  const found = orderLike(collapsedTokens(text));
  return found.length ? { code: "INVENTED", note: `number ${found.map((t) => t.digits).join(", ")}` } : { code: "OK" };
}

const NAME_FILLER = /^(it|is|its|my|name|the|this|i|am|yes|yeah|sorry|that's|thats|called|full|hi|hello|speaking|here)$/;

function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

const consonants = (w: string) => w.replace(/[aeiouy']/g, "").replace(/(.)\1+/g, "$1");

/** Only a label for a substitution ("Whitford" for "Whitfield"): same first letter, and close in letters or in consonants. */
const soundAlike = (a: string, b: string) => a[0] === b[0] && (distance(a, b) <= 2 || distance(consonants(a), consonants(b)) <= 1);

/** Full name: given name and surname, exactly, after case and punctuation normalization. */
export function nameCode(text: string, expected: string): FieldResult {
  const words = normalizeText(text).words.map((w) => w.replace(/'s$/, ""));
  const parts = normalizeText(expected).words;
  const present = parts.filter((p) => words.includes(p));
  if (present.length === parts.length) return { code: "OK" };
  const others = words.filter((w) => !NAME_FILLER.test(w) && !parts.includes(w));
  const missing = parts.filter((p) => !words.includes(p));
  if (!others.length) return present.length ? { code: "PARTIAL", note: `missing ${missing.join(" ")}` } : { code: "MISSING" };
  const alike = others.flatMap((o) => missing.filter((m) => soundAlike(o, m)).map((m) => `"${o}" for "${m}"`));
  return { code: "WRONG", note: alike.length ? `sound-alike: ${alike.join(", ")}` : `heard "${others.join(" ")}"` };
}

const STREET_TYPES: Record<string, string[]> = { lane: ["lane", "ln"], road: ["road", "rd"], street: ["street", "st"], avenue: ["avenue", "ave"], drive: ["drive", "dr"], court: ["court", "ct"] };

/** House number (a value, "48" or "forty-eight"), street name and type ("Lane" = "Ln"), and city. */
export function addressCodes(text: string, expected: { house_no: string; street: string; city: string }): Pick<FieldCodes, "house_no" | "street" | "city" | "address"> {
  const tokens = collapsedTokens(text);
  const words = normalizeText(text).words;
  const firstNumber = tokens.find((t): t is NumToken => t.kind === "num");
  const ref: NumToken = { kind: "num", digits: expected.house_no, value: Number(expected.house_no), form: "numeral", text: expected.house_no, tag: "HOUSE_NO" };
  const house: FieldResult = !firstNumber
    ? { code: "MISSING" }
    : sameNumber(ref, firstNumber)
      ? { code: "OK" }
      : { code: "WRONG", note: `heard "${firstNumber.text}"` };
  const [streetName, streetType] = normalizeText(expected.street).words;
  const types = STREET_TYPES[streetType] ?? [streetType];
  const at = words.indexOf(streetName);
  const street: FieldResult =
    at < 0
      ? words.some((w) => types.includes(w))
        ? { code: "PARTIAL", note: `street type without "${streetName}"` }
        : { code: "MISSING" }
      : types.includes(words[at + 1])
        ? { code: "OK" }
        : words[at + 1] !== undefined && !/^(in|and)$/.test(words[at + 1])
          ? { code: "WRONG", note: `heard "${streetName} ${words[at + 1]}"` }
          : { code: "PARTIAL", note: "street type missing" };
  const cityWords = normalizeText(expected.city).words;
  const cityAt = words.findIndex((w, i) => cityWords.every((c, k) => words[i + k] === c));
  const afterIn = words[words.lastIndexOf("in") + 1];
  const city: FieldResult = cityAt >= 0 ? { code: "OK" } : words.includes("in") && afterIn !== undefined ? { code: "WRONG", note: `heard "${afterIn}"` } : { code: "MISSING" };
  const all = [house, street, city];
  const address: FieldResult = all.every((r) => r.code === "OK")
    ? { code: "OK" }
    : all.some((r) => r.code === "WRONG")
      ? { code: "WRONG" }
      : all.some((r) => r.code === "OK" || r.code === "PARTIAL")
        ? { code: "PARTIAL" }
        : { code: "MISSING" };
  return { house_no: house, street, city, address };
}

/** A word negated by one of the three words before it. */
const negated = (words: string[], i: number) => words.slice(Math.max(0, i - 3), i).some((w) => NEGATORS.test(w));

/** All the fields a case scores, from one layer's text (the case's caller lines joined, in order). */
export function textFieldCodes(c: DevCase, lines: string[]): FieldCodes {
  const text = lines.join(" ");
  const words = normalizeText(text).words;
  const codes: FieldCodes = {};
  const e = c.expected;
  for (const field of fieldsOf(c)) {
    if (field === "order_id") codes.order_id = e.order_id ? orderCode(text, e.order_id) : noOrderCode(text);
    else if (field === "name") codes.name = nameCode(text, e.name!);
    else if (field === "intent") codes.intent = words.some((w) => DAMAGE.test(w)) ? { code: "OK" } : { code: "MISSING", note: "no damage word" };
    else if (field === "choice" && e.choice === "replacement") {
      const at = words.findIndex((w) => /^(replacement|replace|new|exchange)$/.test(w));
      codes.choice = at < 0 ? { code: "MISSING" } : negated(words, at) ? { code: "WRONG", note: "replacement negated" } : { code: "OK" };
    } else if (field === "choice") {
      const chosen = words.filter((w) => /^(replacement|replace|refund|exchange)$/.test(w));
      codes.choice = chosen.length ? { code: "INVENTED", note: `"${chosen.join(" ")}"` } : { code: "OK" };
    } else if (field === "refund_wanted") {
      const refunds = words.flatMap((w, i) => (w === "refund" ? [i] : []));
      codes.refund_wanted = refunds.some((i) => !negated(words, i)) ? { code: "WRONG", note: "refund not negated" } : { code: "OK" };
    }
  }
  if (e.street) Object.assign(codes, addressCodes(text, { house_no: e.house_no!, street: e.street, city: e.city! }));
  return codes;
}
