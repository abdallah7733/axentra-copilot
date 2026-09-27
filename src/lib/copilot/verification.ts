import { editDistance, skeleton, soundsLike, words } from "./text";
import type { Customer } from "./types";

/*
  Identity factors, matched against the customer record the caller ID points to.
  Factor 1: full name. Factor 2: the email on the order, or the delivery street and city.
  A match needs every part (first and last name; street and city); one part alone
  asks for the rest rather than counting as a failure.
*/

export type FactorResult = "match" | "partial" | "mismatch" | "none";

/** Words that mean the caller did not answer (so a line of them is not a failed attempt). */
const NOT_AN_ANSWER = /^(sorry|what|pardon|hello|hi|yes|yeah|no|okay|ok|sure|one|second|moment|hold|on|um|uh|hmm|can|you|repeat|that|please|say|again|it|is|its|it's|the|a|of|my|i|am|i'm|this|name|in|at|and|on|to|for|from|full|speaking|calling|here|called|thanks|thank|street|city|address|delivery|delivered|email|e|mail)$/;

const has = (tokens: string[], expected: string) => tokens.some((t) => soundsLike(t, expected));

export function matchName(text: string, customer: Customer): FactorResult {
  const tokens = words(text);
  const parts = words(customer.name);
  const found = parts.filter((p) => has(tokens, p)).length;
  if (found === parts.length) return "match";
  return judge(found > 0, leftover(tokens, parts));
}

/** Answer words that are neither filler nor part of what was expected. */
const leftover = (tokens: string[], expected: string[]) =>
  tokens.filter((t) => !NOT_AN_ANSWER.test(t) && !expected.some((e) => soundsLike(t, e)));

/** Some parts right and nothing else said: ask for the rest. Anything else said: a wrong answer. */
const judge = (someRight: boolean, extra: string[]): FactorResult => (extra.length ? "mismatch" : someRight ? "partial" : "none");

const STATE_NAMES: Record<string, string[]> = { tx: ["texas"], ca: ["california"], ny: ["new", "york"], fl: ["florida"] };
const STREET_TYPES: Record<string, string[]> = { road: ["road", "rd"], street: ["street", "st"], avenue: ["avenue", "ave"], drive: ["drive", "dr"], lane: ["lane", "ln"] };

export function matchAddress(text: string, customer: Customer): FactorResult {
  const tokens = words(text);
  // Email: "s dot miller at example mail dot com".
  if (tokens.includes("at") && (tokens.includes("com") || tokens.includes("mail") || tokens.some((t) => t.includes("@")))) {
    const local = words(customer.emailFull.split("@")[0]);
    const domain = words(customer.emailFull.split("@")[1]).filter((w) => w !== "dot" && w !== "com");
    const ok = local.filter((w) => w.length > 1).every((w) => has(tokens, w)) && domain.every((w) => has(tokens, w));
    return ok ? "match" : "mismatch";
  }
  const [streetName, ...streetRest] = words(customer.address.street);
  const typeWords = streetRest.flatMap((w) => STREET_TYPES[w] ?? [w]);
  const street = has(tokens, streetName) && (typeWords.length === 0 || tokens.some((t) => typeWords.includes(t)));
  const city = words(customer.address.city).every((w) => has(tokens, w));
  if (street && city) return "match";
  const state = words(customer.address.state);
  const expected = [streetName, ...typeWords, ...words(customer.address.city), ...state, ...state.flatMap((w) => STATE_NAMES[w] ?? [])];
  // A different street type right after the name ("Hill Street") is a wrong answer, not a missing one.
  const otherTypes = Object.values(STREET_TYPES).flat().filter((t) => !typeWords.includes(t));
  const wrongType = tokens.some((t, i) => i > 0 && soundsLike(tokens[i - 1], streetName) && otherTypes.includes(t));
  return judge(street || city, [...leftover(tokens, expected), ...(wrongType ? ["street type"] : [])]);
}

/** Words around an answer that carry no identity ("it's", "the street is"). */
const FILLER = /^(it's|its|it|is|the|um|uh|yeah|yes|my|and|street|city|address|name|full|called|this|i'm|am|i|sorry)$/;

/**
 * The answer, run together and reduced to consonants, is close to the record: "Helrout
 * Indalis" or "Elroad indale" for "Hill Road in Dallas". Only ever a reason to ask the
 * agent to confirm, never a match on its own.
 */
export function soundsLikeRecord(which: "name" | "address", text: string, customer: Customer): boolean {
  const heard = skeleton(words(text).filter((w) => !FILLER.test(w)).join(""));
  if (heard.length < 3) return false;
  const { street, city } = customer.address;
  const records = which === "name" ? [customer.name] : [`${street} in ${city}`, `${street} ${city}`];
  return records.some((record) => {
    const expected = skeleton(words(record).join(""));
    return 1 - editDistance(heard, expected) / Math.max(heard.length, expected.length) >= 0.7;
  });
}
