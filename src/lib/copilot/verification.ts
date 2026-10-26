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
/** Words a caller corrects themselves with: "Sam Miller. No wait, it's Tom Baker.", "Sorry, I meant Tom Baker." */
const CORRECTION = /^(no|wait|actually|mean|meant|correction|sorry|oops|scratch|mistake|rather)$/;
/** Words passed over between a correction word and what it corrects to ("No wait, it was Tom Baker"). */
const BRIDGE = /^(was|be|said|its|i'd|i'll|i've|that's|thats|um|uh|like|so|oh)$/;
/**
 * Everyday words that are not a name, a street or a city, so they are never a second candidate after a correction word
 * even when written with a capital ("Sam Miller. Sorry, the Tablet is cracked.").
 */
export const COMMON = new Set(
  (
    "about after again ago all also an any anything are around as ask asked back be because been before being but by card change check code come " +
    "could day days deliver delivering did do does doing done dont don't double each else every for get give go going good got had has have he " +
    "help her here him his how if instead just know last let let's like look make many may me mine more much need needed new not now number numbers " +
    "off office ok okay only order orders other our out over phone right same see send she should so some something spell spelled spelling " +
    "sure tablet screen cracked broken damaged arrived came box package item refund replacement money then there these they thing think " +
    "those through time today too two three four five six seven eight nine ten zip up us use want wanted was way we well were what when where " +
    "which who why will with without work would yes yet yesterday your you're both two " +
    "great perfect fine alright cool awesome correct exactly absolutely nope yep yup lovely nice wonderful brilliant indeed " +
    "certainly definitely course really true wow oh ah bye goodbye cheers hey morning afternoon evening sorry excellent " +
    "brand model colour color black white silver grey gray blue red"
  ).split(" "),
);
/** The words capitalised inside a sentence (proper names, as the speech models write them), lower case. */
function capitalised(text: string): Set<string> {
  const caps = new Set<string>();
  for (const sentence of text.split(/[.!?]+\s*/))
    for (const [i, w] of (sentence.match(/[A-Za-z][A-Za-z']*/g) ?? []).entries())
      if (i > 0 && w.length > 1 && /^[A-Z]/.test(w) && !/^I('m|'d|'ll|'ve)?$/.test(w)) caps.add(w.toLowerCase().replace(/'s$/, ""));
  return caps;
}
const denies = (tokens: string[]) => tokens.some((t) => DENIAL.test(t));

export const deniesIdentity = (text: string) => denies(answerWords(text));

/**
 * How the answer is framed, before its words are compared with the record:
 * - "I am not Sam Miller", "Not Hill Road in Dallas": the record itself denied, a wrong answer.
 *   A leading "No," is left alone: "No, it's Sam Miller" corrects the agent.
 * - "My name is Sam Miller, not John Smith", "Not Boston, Hill Road in Dallas": something
 *   else denied. Rather than guess the scope, ask again.
 * - "Sam Miller or John Smith": two candidates. Ask again.
 * - "Sam Miller. No wait, it's Tom Baker." (or the other way round): the caller corrected themselves from the record's
 *   words to another candidate, so their own answer conflicts. Ask again (his rule, 23 Oct). The first record word or
 *   candidate after the correction word decides (everyday and lower-case words between are passed over): "Sam Miller,
 *   no, M I L L E R." and "Sam Miller. Wait, do you need my order number?" still match.
 */
function frame(tokens: string[], expected: string[], recordWords: string[] = [], caps = new Set<string>()): FactorResult | null {
  const isExpected = (t: string | undefined) => !!t && expected.some((e) => soundsLike(t, e));
  const denials = tokens.flatMap((t, i) => (DENIAL.test(t) ? [i] : []));
  if (denials.some((i) => isExpected(tokens[i + 1]))) return "mismatch";
  const anyExpected = tokens.some((t) => isExpected(t));
  if (!anyExpected) return null;
  if (denials.length) return "ambiguous";
  const other = (t: string) => t !== "or" && !NOT_AN_ANSWER.test(t) && !isExpected(t) && !recordWords.includes(t);
  if (tokens.includes("or") && tokens.some((t) => other(t) && !CORRECTION.test(t))) return "ambiguous";
  // A second candidate: a word written as a name, street or city is (capitalised inside a sentence, as the speech models
  // write names). Not a number, a spelled letter ("M I L L E R", "two Ls") or an everyday word: "Sam Miller. Sorry, I'm
  // driving." and "Good morning. Sorry, it's Sam Miller." still match (second review of C7, 23 Oct).
  const candidate = (t: string | undefined) =>
    !!t && other(t) && !CORRECTION.test(t) && !BRIDGE.test(t) && t.length > 1 && !/^\d/.test(t) && !/^[a-z]s$/.test(t) && caps.has(t) && !COMMON.has(t);
  // A correction to a sound-alike of the record ("Sam Miller, sorry, Muller.", "Hill Road in Dallas. Sorry, Hall Road."):
  // the caller's last word on it is only a sound-alike, so it never verifies on its own (second review of C7, 23 Oct).
  const soundAlike = (t: string | undefined) => !!t && t.length > 1 && caps.has(t) && isExpected(t) && !expected.includes(t);
  const skip = (t: string) => NOT_AN_ANSWER.test(t) || CORRECTION.test(t) || BRIDGE.test(t);
  let corrected = false;
  for (const [m, t] of tokens.entries()) {
    if (!CORRECTION.test(t)) continue;
    let [n, p] = [m + 1, m - 1];
    // Forward, everyday and lower-case words are passed over to the first word that is the record's or another
    // candidate: "Wait, I think it's Tom Baker.", "Actually, we moved, it's Elm Street in Austin now." (second review of
    // C7, 23 Oct: only the one word after the correction was looked at).
    while (n < tokens.length && !isExpected(tokens[n]) && !candidate(tokens[n])) n++;
    while (p >= 0 && skip(tokens[p])) p--;
    // The record's words, then a correction to another candidate; or another candidate corrected to the record's words.
    if ((tokens.slice(0, m).some(isExpected) && candidate(tokens[n])) || (candidate(tokens[p]) && isExpected(tokens[n]))) return "ambiguous";
    if (tokens.slice(0, m).some(isExpected) && soundAlike(tokens[n])) corrected = true;
  }
  return corrected ? "close" : null;
}

export function matchName(text: string, customer: Customer): FactorResult {
  const tokens = answerWords(text);
  const parts = words(customer.name);
  const framed = frame(tokens, parts, [], capitalised(text));
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
  const framed = frame(tokens, record.filter((w) => !shared.includes(w)), shared, capitalised(text));
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

/**
 * The line names someone other than the record's name, as an answer about the name would: a word written as a name
 * that isn't the record's (by sound), its street or city, or an everyday word. In a short line any such word counts
 * ("Jones.", "Tom Baker."); in a longer one only straight after "it's", "this is", "my name is" or a correction word
 * ("Actually it's Tom Baker.", "Sorry, Pam Miller."), so "Yes, it's the Samsung one." and "It's a Galaxy tablet." don't
 * (second review of C7, 23 Oct).
 */
export function namesAnother(text: string, customer: Customer): boolean {
  const expected = words(customer.name);
  const notName = new Set([...words(customer.address.street), ...words(customer.address.city), ...words(customer.address.state), ...Object.values(STREET_TYPES).flat(), ...Object.values(STATE_NAMES).flat()]);
  const isCandidate = (w: string) => {
    const t = w.toLowerCase().replace(/['’]s$/, "");
    return t.length > 1 && !/^i(['’](m|d|ll|ve))?$/.test(t) && !expected.some((e) => soundsLike(t, e)) && !notName.has(t) && !COMMON.has(t) && !NOT_AN_ANSWER.test(t) && !CORRECTION.test(t) && !BRIDGE.test(t);
  };
  // A short line counts only if it is written as a name, every word capitalised ("Tom Baker.", not "Great, thank you.").
  const all = text.match(/\p{L}[\p{L}'’-]*/gu) ?? [];
  const short = all.length <= 3 && all.every((w) => /^\p{Lu}/u.test(w));
  for (const m of text.matchAll(/\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*)*/gu)) {
    if (!m[0].split(/\s+/).some(isCandidate)) continue;
    if (short) return true;
    if (/(?:^|[^\p{L}])(?:my name is|my name's|name is|name's|it's|its|it is|this is|i'm|i am|sorry|actually|no|wait|meant|mean)[\s,]*$/u.test(text.slice(0, m.index).toLowerCase())) return true;
  }
  return false;
}
