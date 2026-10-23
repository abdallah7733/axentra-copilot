import { editDistance, skeleton, soundsLike, words } from "./text";
import type { Customer } from "./types";

/*
  Identity factors, matched against the customer record the caller ID points to.
  Factor 1: full name. Factor 2: the email on the order, or the delivery street and city.
  A match needs every part (first and last name; street and city); one part alone
  asks for the rest rather than counting as a failure. Every part has to be heard word
  for word: a part heard only by sound ("Will Road" for "Hill Road") makes the answer
  "close", which the agent confirms and which never verifies on its own. An answer that
  names two candidates or denies something else is "ambiguous": asked again, never a
  match and never a failed attempt.
*/

export type FactorResult = "match" | "close" | "partial" | "mismatch" | "none" | "ambiguous";

/** Words that mean the caller did not answer (so a line of them is not a failed attempt). */
const NOT_AN_ANSWER = /^(sorry|what|pardon|hello|hi|yes|yeah|no|okay|ok|sure|one|second|moment|hold|on|um|uh|hmm|can|you|repeat|that|please|say|again|it|is|its|it's|the|a|of|my|i|am|i'm|this|name|in|at|and|on|to|for|from|full|speaking|calling|here|called|thanks|thank|street|city|address|delivery|delivered|email|e|mail)$/;
/** A word that carries no identity on its own ("my", "name", "is", "the"). */
export const isFiller = (word: string) => NOT_AN_ANSWER.test(word);

/** How one part of the record was heard: word for word, only by sound, or not at all. */
type Heard = "exact" | "close" | null;
const heardAs = (tokens: string[], expected: string): Heard =>
  tokens.includes(expected) ? "exact" : tokens.some((t) => soundsLike(t, expected)) ? "close" : null;
/** Every part heard: a match only if each was heard word for word. */
const allHeard = (parts: Heard[]): "match" | "close" | null => (!parts.every(Boolean) ? null : parts.every((p) => p === "exact") ? "match" : "close");
const has = (tokens: string[], expected: string) => heardAs(tokens, expected) !== null;

/** The answer's words, with a possessive "'s" dropped: "Sam Miller's." was heard for "Sam Miller." on 10 Oct. */
const answerWords = (text: string) => words(text).map((w) => w.replace(/'s$/, ""));

const DENIAL = /^(not|never|isn't|isnt|wasn't|wasnt|don't|dont|doesn't|doesnt|didn't|didnt|ain't|aint)$/;
/** Words a caller corrects themselves with: "Sam Miller. No wait, it's Tom Baker." */
const CORRECTION = /^(no|wait|actually|mean|correction)$/;
const denies = (tokens: string[]) => tokens.some((t) => DENIAL.test(t));

export const deniesIdentity = (text: string) => denies(answerWords(text));

/**
 * How the answer is framed, before its words are compared with the record:
 * - "I am not Sam Miller", "Not Hill Road in Dallas": the record itself denied, a wrong answer.
 *   A leading "No," is left alone: "No, it's Sam Miller" corrects the agent.
 * - "My name is Sam Miller, not John Smith", "Not Boston, Hill Road in Dallas": something
 *   else denied. Rather than guess the scope, ask again.
 * - "Sam Miller or John Smith": two candidates. Ask again.
 * - "Sam Miller. No wait, it's Tom Baker." (or the other way round): the caller corrected themselves between the
 *   record's words and others, so their own answer conflicts. Ask again (his rule, 23 Oct).
 */
function frame(tokens: string[], expected: string[], recordWords: string[] = []): FactorResult | null {
  const isExpected = (t: string | undefined) => !!t && expected.some((e) => soundsLike(t, e));
  const denials = tokens.flatMap((t, i) => (DENIAL.test(t) ? [i] : []));
  if (denials.some((i) => isExpected(tokens[i + 1]))) return "mismatch";
  const anyExpected = tokens.some((t) => isExpected(t));
  if (!anyExpected) return null;
  if (denials.length) return "ambiguous";
  const other = (t: string) => t !== "or" && !CORRECTION.test(t) && !NOT_AN_ANSWER.test(t) && !isExpected(t) && !recordWords.includes(t);
  const others = tokens.filter(other);
  if (tokens.includes("or") && others.length) return "ambiguous";
  const at = (test: (t: string) => boolean) => tokens.flatMap((t, i) => (test(t) ? [i] : []));
  const [expectedAt, otherAt] = [at(isExpected), at(other)];
  const between = (m: number, before: number[], after: number[]) => before.some((i) => i < m) && after.some((i) => i > m);
  if (at((t) => CORRECTION.test(t)).some((m) => between(m, expectedAt, otherAt) || between(m, otherAt, expectedAt))) return "ambiguous";
  return null;
}

export function matchName(text: string, customer: Customer): FactorResult {
  const tokens = answerWords(text);
  const parts = words(customer.name);
  const framed = frame(tokens, parts);
  if (framed) return framed;
  const heard = parts.map((p) => heardAs(tokens, p));
  const all = allHeard(heard);
  if (all) return all;
  return judge(heard.some(Boolean), leftover(tokens, parts));
}

/** Answer words that are neither filler nor part of what was expected. */
const leftover = (tokens: string[], expected: string[]) =>
  tokens.filter((t) => !NOT_AN_ANSWER.test(t) && !expected.some((e) => soundsLike(t, e)));

/** Some parts right and nothing else said: ask for the rest. Anything else said: a wrong answer. */
const judge = (someRight: boolean, extra: string[]): FactorResult => (extra.length ? "mismatch" : someRight ? "partial" : "none");

/** How a single letter of an email is said aloud. */
const LETTER_NAMES: Record<string, string[]> = {
  a: ["ay"], b: ["bee", "be"], c: ["see", "sea", "cee"], d: ["dee"], e: ["ee"], f: ["ef", "eff"], g: ["gee"], h: ["aitch", "h"], i: ["eye"], j: ["jay"],
  k: ["kay"], l: ["el", "ell"], m: ["em"], n: ["en"], o: ["oh"], p: ["pee"], q: ["queue", "cue"], r: ["ar", "are"], s: ["es", "ess"], t: ["tee", "tea"],
  u: ["you"], v: ["vee"], w: ["double"], x: ["ex"], y: ["why"], z: ["zee", "zed"],
};

const STATE_NAMES: Record<string, string[]> = { tx: ["texas"], ca: ["california"], ny: ["new", "york"], fl: ["florida"] };
const STREET_TYPES: Record<string, string[]> = { road: ["road", "rd"], street: ["street", "st"], avenue: ["avenue", "ave"], drive: ["drive", "dr"], lane: ["lane", "ln"] };

export function matchAddress(text: string, customer: Customer): FactorResult {
  const tokens = answerWords(text);
  // Street types ("road") and the state ("Texas") are said with every address, so they don't tell two candidates apart.
  const record = [...words(customer.address.street), ...words(customer.address.city), ...words(customer.emailFull.split("@")[0])];
  const shared = [...Object.values(STREET_TYPES).flat(), ...words(customer.address.state), ...Object.values(STATE_NAMES).flat()];
  const framed = frame(tokens, record.filter((w) => !shared.includes(w)), shared);
  if (framed) return framed;
  // Email: "s dot miller at example mail dot com".
  if (tokens.includes("at") && (tokens.includes("com") || tokens.includes("mail") || tokens.some((t) => t.includes("@")))) {
    const local = words(customer.emailFull.split("@")[0]);
    const domain = words(customer.emailFull.split("@")[1]).filter((w) => w !== "dot" && w !== "com");
    // A single letter ("s" in s.miller) can be said as its name ("es"). Every part counts: "miller at
    // example mail dot com" leaves out the "s" and is only part of the email (plan Step 5, action 6).
    const letter = (w: string): Heard => (tokens.includes(w) || (LETTER_NAMES[w] ?? []).some((n) => tokens.includes(n)) ? "exact" : null);
    const localHeard = local.map((w) => (w.length === 1 ? letter(w) : heardAs(tokens, w)));
    const domainHeard = domain.map((w) => heardAs(tokens, w));
    const all = allHeard([...localHeard, ...domainHeard]);
    if (all) return all;
    // The domain right and the rest of the address missing, with nothing else said: ask for the rest.
    const unexpected = tokens.filter((t) => !NOT_AN_ANSWER.test(t) && !/^(dot|com|@)$/.test(t) && ![...local, ...domain].some((w) => t === w || soundsLike(t, w) || (LETTER_NAMES[w] ?? []).includes(t)));
    return domainHeard.every(Boolean) && !unexpected.length ? "partial" : "mismatch";
  }
  const [streetName, ...streetRest] = words(customer.address.street);
  const typeWords = streetRest.flatMap((w) => STREET_TYPES[w] ?? [w]);
  // The street type may only sound alike too ("Hail Rode in Dallas" on the 10 Oct retest): close, not a match.
  const type: Heard =
    !typeWords.length || typeWords.some((w) => tokens.includes(w)) ? "exact" : tokens.some((t) => typeWords.some((w) => soundsLike(t, w))) ? "close" : null;
  const cityHeard = words(customer.address.city).map((w) => heardAs(tokens, w));
  const all = allHeard([heardAs(tokens, streetName), type, ...cityHeard]);
  if (all) return all;
  const street = has(tokens, streetName) && type !== null;
  const city = cityHeard.every(Boolean);
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

/**
 * For the read-back only (his rule, 23 Oct): whether saying the detail back can be repeating what the caller said, not
 * filling in what they didn't. Every part heard, word for word or by sound, fits. So does an answer with none of the
 * record's parts in it ("Sandler.", "Helrout Indalis."): a recognition error the agent may have heard right. But a part
 * that was heard never carries the rest on its own: the rest of the answer, run together, must still sound like the
 * rest of the record ("Helrout in Dallas" fits; "Sam Jones", "Pam Miller", "Elm Road in Dallas" and "Hill Road in
 * Dalton" don't). A different street type ("Hill Street in Dallas") is a different answer, not a mishearing.
 */
export function readBackFits(which: "name" | "address", text: string, customer: Customer): boolean {
  if (deniesIdentity(text)) return false;
  // An email answer is never followed by the street and city: that would say words the caller never gave.
  const said = answerWords(text);
  if (which === "address" && said.includes("at") && (said.includes("com") || said.includes("mail") || said.some((t) => t.includes("@")))) return false;
  const result = which === "name" ? matchName(text, customer) : matchAddress(text, customer);
  if (result === "match" || result === "close") return true;
  if (result !== "mismatch") return false;
  const { street, city, state } = customer.address;
  const [streetName, ...streetRest] = words(street);
  const recordTypes = streetRest.flatMap((w) => STREET_TYPES[w] ?? [w]);
  const stateWords = [...words(state), ...words(state).flatMap((w) => STATE_NAMES[w] ?? [])];
  // Street types, "in" and the state are said with every address, so they carry nothing either way.
  const generic = which === "address" ? [...recordTypes, "in", ...stateWords] : [];
  const otherTypes = Object.values(STREET_TYPES).flat().filter((t) => !recordTypes.includes(t));
  if (which === "address" && answerWords(text).some((t) => otherTypes.includes(t))) return false;
  const tokens = answerWords(text).filter((w) => !FILLER.test(w) && !generic.includes(w));
  const parts = which === "name" ? words(customer.name) : [streetName, ...words(city)];
  const heard = parts.filter((p) => has(tokens, p));
  if (!heard.length) return true;
  const rest = parts.filter((p) => !heard.includes(p));
  if (!rest.length) return true;
  const restHeard = skeleton(tokens.filter((t) => !heard.some((p) => t === p || soundsLike(t, p))).join(""));
  if (restHeard.length < 2) return false;
  // The street name and its type can run together ("Helrout" for "Hill Road").
  const expected = [rest, rest.flatMap((p) => (p === streetName && which === "address" ? [p, ...streetRest] : [p]))].map((r) => skeleton(r.join("")));
  return expected.some((e) => 1 - editDistance(restHeard, e) / Math.max(restHeard.length, e.length) >= 0.7);
}
