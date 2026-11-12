import { editDistance, numberWord, skeleton, soundsLike, words } from "./text";
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

/** `strict`: an answer that has every word of the record and says more than it is asked again (see strictFlags). */
export type MatchOptions = { strict?: boolean };

export function matchName(text: string, customer: Customer, opts: MatchOptions = {}): FactorResult {
  const tokens = answerWords(text);
  const parts = words(customer.name);
  const framed = frame(tokens, parts, [], capitalised(text));
  if (framed) return framed;
  const heard = parts.map((p) => heardAs(tokens, p));
  const all = allHeard(heard);
  if (all === "match" && opts.strict && strictFlags("name", text, customer).length) return "ambiguous";
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

export function matchAddress(text: string, customer: Customer, opts: MatchOptions = {}): FactorResult {
  const result = matchAddressAsHeard(text, customer);
  return result === "match" && opts.strict && strictFlags("address", text, customer).length ? "ambiguous" : result;
}

function matchAddressAsHeard(text: string, customer: Customer): FactorResult {
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

/*
  Stricter matching (dev console only, behind Policy.strictMatch; his "Stricter matching", 12 Nov). The match above
  looks only for the record's words, so "Church Hill Road in Dallas", "It's for my husband, Sam Miller" and "Sam
  Miller, M E L L O R" all match today (register I-54). strictFlags lists what else such an answer says that could
  change who or where it means. With the switch on, a match with any flag is asked again: never a match, never a
  failed attempt. A flag never makes any other answer a match.
*/

/** Hesitation sounds, dropped before the checks ("Hill, um, Road" is still "Hill Road"). */
const HESITATION = /^(um|uh|er|erm|hmm|hm|ah|eh|mm|mhm)$/;
/** Words that make the answer about someone else: a relative, a carer, a suffix that names another person, a death. */
const PROXY =
  /^(husband|wife|spouse|partner|son|daughter|father|mother|dad|daddy|mum|mom|mommy|mummy|brother|sister|grandson|granddaughter|grandmother|grandfather|grandma|grandpa|grandad|granny|nephew|niece|uncle|aunt|auntie|cousin|boyfriend|girlfriend|fiance|fiancee|fiancé|fiancée|stepson|stepdaughter|stepmother|stepfather|stepmom|stepmum|stepdad|stepbrother|stepsister|parents|child|children|kid|kids|godson|goddaughter|behalf|carer|caregiver|caretaker|nurse|assistant|secretary|attorney|lawyer|guardian|executor|landlord|landlady|tenant|roommate|flatmate|neighbour|neighbor|junior|jr|senior|sr|ii|iii|iv|deceased|passed|died|estate|widow|widower)$/;
/**
 * After "my", "our", "his", "her" or "their", someone else: "my friend, Sam Miller", "my boss", "my client", "my baba" (not
 * "Sam Miller, mate", not "Ya baba, Sam Miller"). Not "family" ("My family name is Miller").
 */
const KNOWN_TO =
  /^(friend|friends|boss|colleague|colleagues|coworker|coworkers|employer|employee|manager|client|clients|ex|buddy|mate|pal|hubby|wifey|bro|sis|mama|papa|baba|baby|inlaws|relative|relatives|patient|student|teacher)$/;
const WHOSE = /^(my|our|his|her|their)$/;
/** "his name", "her address", "their account": the detail is someone else's. */
const THIRD_PERSON = /^(his|her|their)$/;
const THEIRS = /^(name|address|place|house|home|email|account|order|number|phone|details)$/;
/** Said straight before the name, these make it someone the caller is calling about ("for Sam Miller", "for Mr. Sam Miller"). */
const FOR_SOMEONE = /^(for|about|regarding)$/;
const TITLES = /^(mr|mrs|ms|miss|mister|missus|dr|doctor|prof|professor|sir|madam|ma'am|maam)$/;
/** Street types; a different one in the answer is a different street ("Hill Road ... Main Street"). */
const STREET_TYPE_ALL = /^(road|rd|street|st|avenue|ave|drive|dr|lane|ln|court|ct|way|place|pl|boulevard|blvd|circle|cir|parkway|pkwy|highway|hwy|trail|terrace|row|rise|crescent|close|extension|ext)$/;
/** After the street, a flat or unit ("Hill Road, apartment 4", "house number 12", "third floor") is part of the same address. */
const UNIT = /^(apartment|apt|unit|suite|flat|floor|building|bldg|number|no|house|villa|block|tower)$/;
const ORDINAL = /^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|ground|top|\d+(st|nd|rd|th))$/;
/** Words that change which street is meant, before it ("Old Hill Road", "North Hill Road") or after it ("Hill Road East"). */
const STREET_BEFORE = /^(new|old|north|south|east|west|upper|lower|little|great|big)$/;
/**
 * Everyday words that also name streets: written straight before it they make another street ("Red Hill Road", "Box Hill
 * Road", review of C10, 12 Nov), though "Red, Hill Road" or "Yes, good, Hill Road" stay everyday words.
 */
const STREET_NAMING = /^(red|blue|green|black|white|silver|grey|gray|brown|golden|gold|good|nice|fair|other|back|box|over|up|down|high|low|long|morning|evening|cool|lovely|true|same|day)$/;
const STREET_AFTER = /^(north|south|east|west|extension|ext)$/;
/** Anywhere in an address answer, these make it somewhere near the record's city, not in it. */
const PLACE_NEAR = /^(area|county|metro|suburb|suburbs|outskirts)$/;
/** These do too, said before the city or another place ("near Dallas", "outside Fort Worth"), not before a landmark ("near the school"). */
const NEAR = /^(near|outside|nearby|close)$/;
/** Beside the city, these make it another place ("North Dallas", "Lake Dallas", "Dallas Fort Worth"). */
const PLACE_NEXT = /^(center|centre|city|town|township|village|lake|fort|north|south|east|west|old|new|upper|lower)$/;
const COUNTRY = /^(usa|us|america|united|states|zip|code|postcode)$/;
const US_STATES: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado", ct: "connecticut", de: "delaware", fl: "florida",
  ga: "georgia", hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine",
  md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska",
  nv: "nevada", nh: "new hampshire", nj: "new jersey", nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota", oh: "ohio",
  ok: "oklahoma", or: "oregon", pa: "pennsylvania", ri: "rhode island", sc: "south carolina", sd: "south dakota", tn: "tennessee", tx: "texas",
  ut: "utah", vt: "vermont", va: "virginia", wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming", dc: "district of columbia",
};
/** Around an email: "It's s dot miller at example mail dot com, thanks." */
const EMAIL_LEAD = /^(it's|its|it|is|my|the|email|e|mail|address|yes|yeah|sure|ok|okay|so|that's|thats)$/;
const EMAIL_TAIL = /^(please|thanks|thank|you|yes|yeah)$/;
/** How a caller describes the email's letters or the account: "all small letters", "lower case", "my personal email". */
const EMAIL_ABOUT = /^(all|small|lower|lowercase|upper|uppercase|capital|capitals|caps|case|letters|letter|personal|private|main|usual|primary|work)$/;
/** How a caller says the marks between an email's words. */
const EMAIL_SEPARATOR: Record<string, string> = { dot: ".", dash: "-", hyphen: "-", underscore: "_" };
/** After the name, these make it another person of the same name: "Sam Miller the Third", "Sam Miller, the younger". */
const GENERATION = /^(second|third|fourth|fifth|2nd|3rd|4th|5th|younger|elder|older)$/;
/** Words that put the answer in the past: "my previous address", "formerly", "my maiden name" ("used to" and "moved from" too). */
const PAST = /^(formerly|previously|former|previous|maiden|nee|née)$/;
/** "my old address", "the old house": an old detail, not the current one ("Old Hill Road" is another street). */
const OLD_THING = /^(address|house|place|home|apartment|flat|street|email|number|name|one)$/;
/** After a name said with "'s", these make it "is", not someone's: "Sam Miller's my name", "Sam Miller's speaking". */
const IS_AFTER = /^(my|the|me|here|speaking|calling|it|this|right|correct|fine|ok|okay|yes|yeah|on|in|at|a|an|also|again|too|and)$/;
/** Things a caller says belong to someone: "the account is Sam's". */
const OWNED = /^(account|number|phone|order|line|card|house|home|place|email|address|package|tablet|item)$/;

/** Every place the words of `run` are said together, in order; `fits` decides when a said word stands for a run word. */
const runsAt = (tokens: string[], run: string[], fits = (said: string, w: string) => said === w): number[] =>
  run.length ? tokens.flatMap((_, i) => (run.every((w, j) => i + j < tokens.length && fits(tokens[i + j], w)) ? [i] : [])) : [];

/**
 * How many words after a spelled letter only give its example ("M as in Mary", "S for Sam", "L like Lima"): the example
 * starts with the letter and names nothing else. 0 when there is none.
 */
const exampleLength = (tokens: string[], i: number): number => {
  const letter = tokens[i - 1] ?? "";
  if (!/^[a-z]$/.test(letter)) return 0;
  const [a, b, c] = [tokens[i], tokens[i + 1] ?? "", tokens[i + 2] ?? ""];
  if (a === "as" && b === "in" && c.length > 1 && c.startsWith(letter)) return 3;
  if ((a === "for" || a === "like") && b.length > 1 && b.startsWith(letter)) return 2;
  return 0;
};
/** The words with each spelled letter's example dropped ("M as in Mary, I" is "m i"). */
export function withoutExamples(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const skip = exampleLength(tokens, i);
    if (skip) i += skip - 1;
    else out.push(tokens[i]);
  }
  return out;
}
/**
 * Letters spelled one by one, `min` or more, run together, and where each run is in `tokens`: "M I L L E R", "M I double
 * L E R", "M, I, two Ls, E, R", "M as in Mary, I, double L, E, R". A count ("two", "3") doubles a letter only inside a
 * run already started, so "apartment 3 C" spells nothing (review of C10, 12 Nov: "two L" and "as in Mary" broke the run,
 * so the record's own spelling read as another name).
 */
export function spelledRunsAt(tokens: string[], min = 3): { from: number; to: number; run: string }[] {
  const runs: { from: number; to: number; run: string }[] = [];
  const letterOf = (t: string | undefined) => (!t ? null : /^[a-z]$/.test(t) ? t : /^[a-z]s$/.test(t) && !/^(is|as|us)$/.test(t) ? t[0] : null);
  let [run, from, to] = ["", -1, -1];
  for (let i = 0; i <= tokens.length; i++) {
    const t = tokens[i] ?? "";
    const count = /^(double|two|2)$/.test(t) ? 2 : /^(triple|three|3)$/.test(t) ? 3 : 0;
    const doubled = count && letterOf(tokens[i + 1]) && (run || /^(double|triple)$/.test(t)) ? letterOf(tokens[i + 1])! : null;
    const skip = run ? exampleLength(tokens, i) : 0;
    if (skip) i += skip - 1;
    else if (/^[a-z]$/.test(t) || doubled) {
      if (!run) from = i;
      run += doubled ? doubled.repeat(count) : t;
      if (doubled) i++;
      to = i;
    } else {
      if (run.length >= min) runs.push({ from, to, run });
      run = "";
    }
  }
  return runs;
}
/** The spelled runs alone ("miller" for "M I double L E R"), three letters or more unless `min` says otherwise. */
export const spelledLetters = (tokens: string[], min = 3): string[] => spelledRunsAt(tokens, min).map((r) => r.run);

const escaped = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A word as the answer wrote it ("Church", not "church"), for the flags' wording. */
const asWritten = (text: string, word: string): string =>
  new RegExp(`(?<![\\p{L}'])${escaped(word)}(?![\\p{L}])`, "iu").exec(text)?.[0] ?? word;
/** Two words written one straight after the other, with no punctuation between ("Main Street", not "Dallas. Street:"). */
const writtenTogether = (text: string, first: string, second: string) =>
  new RegExp(`(?<![\\p{L}'])${escaped(first)}(?:'s)?[\\s-]+${escaped(second)}(?![\\p{L}])`, "iu").test(text);

/**
 * What an answer that matches the record also says, each in plain words (empty: nothing). Only consulted for a match.
 * - Name and address: another spelling of a record word beside it ("Sam Miller, Mellor"); words that make it someone
 *   else's ("my husband", "on behalf of", "Junior"); a spelled word that isn't the record's ("M E L L O R"); a correction
 *   followed by another name or place ("Sam Miller. Sorry, Sam Baker.", sentence-initial capitals and lower-case
 *   sound-alikes included); the past ("It used to be Hill Road", "my previous address", "moved from").
 * - Name: "for", "about" or "regarding" straight before the name; another capitalised name beside the record's
 *   ("Laura Anderson Smith", "Mary Laura Anderson", "Sam and Jane Miller"); "the Third", "the younger" after it; the
 *   name as someone's ("Sam Miller's house", "the account is Sam's"); an email given for the name.
 * - Address: the street's words apart, or another word straight before or after the street ("Church Hill Road",
 *   "Hill Road Extension"; a house number, filler, the city and, after it, a flat or unit are fine); another street
 *   type; another state ("Oklahoma", or "Dallas, OK" written as a code); a place word ("near", "North Dallas",
 *   "Lake Dallas", a capitalised word beside the city).
 * - Email: anything but the record's email between the usual lead-in and thanks ("... dot com dot uk"); a mark said
 *   where the order has another ("s underscore miller", "example dot mail") or after it ("dot com dot"); a number in it.
 * `readBack`: for deciding whether a read-back may repeat the answer (readBackFits). A sound-alike of the record is what a
 * read-back is for, so it isn't flagged, and the record's words are found by sound too ("Church Hil Road").
 */
export function strictFlags(which: "name" | "address", raw: string, customer: Customer, { readBack = false } = {}): string[] {
  // Marks in brackets ("[pause 1.0 s]", "[unclear]") are notes about the audio, not words the caller said. A typographic
  // apostrophe is the plain one ("Sam Miller’s house", review of C10, 12 Nov).
  const text = raw.replace(/\[[^\]]*\]/g, " ").replace(/[\u2018\u2019\u02BC`]/g, "'");
  const tokens = answerWords(text).filter((t) => !HESITATION.test(t));
  const flags = new Set<string>();
  const nameWords = words(customer.name);
  const streetWords = words(customer.address.street);
  const cityWords = words(customer.address.city);
  const stateCode = words(customer.address.state).join(" ");
  const stateWords = [...words(customer.address.state), ...words(US_STATES[stateCode] ?? "")];
  const typeWords = streetWords.slice(1).flatMap((w) => STREET_TYPES[w] ?? [w]);
  const recordWords = new Set([...nameWords, ...streetWords, ...typeWords, ...cityWords, ...stateWords]);
  const caps = new Set(
    (text.match(/(?<![\p{L}'])\p{Lu}[\p{L}']*/gu) ?? []).map((w) => w.toLowerCase().replace(/'s$/, "")).filter((w) => !/^i('m|'d|'ll|'ve)?$/.test(w)),
  );
  const shown = (w: string) => asWritten(text, w);
  // The speech models capitalise every sentence's first word, so a capital there alone names nothing ("Sam Miller. Quick
  // question.", "Howdy, Sam Miller."); written straight beside the record's word it still does ("Mary Sam Miller."). As
  // the plain matcher's capitalised() (review of C10, 12 Nov).
  const midCaps = new Set(
    text
      .split(/[.!?]+\s*/)
      .flatMap((x) => (x.match(/\p{L}[\p{L}']*/gu) ?? []).slice(1))
      .filter((w) => /^\p{Lu}/u.test(w))
      .map((w) => w.toLowerCase().replace(/'s$/, "")),
  );
  const namedBeside = (n: string, t: string) => caps.has(n) && (midCaps.has(n) || writtenTogether(text, n, t) || writtenTogether(text, t, n));

  if (which === "address" && tokens.includes("at") && (tokens.includes("com") || tokens.includes("mail") || tokens.some((t) => t.includes("@")))) {
    // An email: the record's, said in one run, word for word, with nothing else that could change it ("... dot uk").
    // A repeat of part of it ("Sorry, that's example dash mail dot com.") and everyday words around it are fine.
    const drop = (ws: string[]) => ws.filter((w) => !/^(dot|dash|hyphen|underscore)$/.test(w));
    const email = drop(words(customer.emailFull.replace("@", " at ")));
    // A letter's example ("S for Sam") and the email's own words spelled out ("dot com, M I L L E R") are the email too.
    const plainSaid = withoutExamples(answerWords(text.replace(/@/g, " at ")).filter((t) => !HESITATION.test(t)));
    const spelledOwn = new Set(spelledRunsAt(plainSaid).filter((r) => email.includes(r.run)).flatMap((r) => plainSaid.slice(r.from, r.to + 1).map((_, k) => r.from + k)));
    const said = drop(plainSaid.filter((_, k) => !spelledOwn.has(k)));
    const fits = (s: string, w: string) => s === w || (w.length === 1 && (LETTER_NAMES[w] ?? []).includes(s));
    const fine = (s: string) =>
      EMAIL_LEAD.test(s) || EMAIL_TAIL.test(s) || EMAIL_ABOUT.test(s) || TITLES.test(s) || isFiller(s) || COMMON.has(s) || CORRECTION.test(s) || BRIDGE.test(s) || email.some((w) => fits(s, w));
    const extra = said.filter((s) => !fine(s));
    if (extra.length) flags.add(`other words with the email: ${extra.map(shown).join(", ")}`);
    else if (!runsAt(said, email, fits).length) flags.add("the email isn't said in one run, as on the order");
    // A mark said between two of its words must be the order's ("s dot miller", "example dash mail"). One said where the
    // order has another, or after the last word, is another email ("s underscore miller", "example dot mail", "dot com
    // dot"). A mark not said at all may only be how it was written ("example-mail"), so it isn't counted. Nor is a number
    // said inside it ("s dot miller one at ...").
    const all = answerWords(text.replace(/@/g, " at ")).filter((t) => !HESITATION.test(t));
    const order = customer.emailFull.toLowerCase().split(/([.\-_@])/).filter(Boolean);
    const inEmail = (s: string | undefined) => !!s && email.some((w) => fits(s, w));
    all.forEach((s, k) => {
      const [a, b] = [all[k - 1], all[k + 1]];
      if (s in EMAIL_SEPARATOR && inEmail(a)) {
        if (!inEmail(b)) flags.add(`a mark after the email: ${shown(s)}`);
        else if (!order.some((w, p) => fits(a, w) && order[p + 1] === EMAIL_SEPARATOR[s] && order[p + 2] !== undefined && fits(b, order[p + 2])))
          flags.add(`another mark in the email: ${shown(s)}`);
      }
      const number = /^\d/.test(s) || numberWord(s) !== null;
      const beside = (x: string | undefined) => inEmail(x) || (!!x && x in EMAIL_SEPARATOR);
      if (number && !email.includes(s) && beside(a) && (b === undefined || beside(b))) flags.add(`a number in the email: ${shown(s)}`);
    });
    return [...flags];
  }

  // The words the record is checked on: the name, or the street name and the city (types and the state are said with
  // every address).
  const core = which === "name" ? nameWords : [...streetWords.filter((w) => !typeWords.includes(w)), ...cityWords];
  const isCore = (t: string) => core.some((p) => t === p || soundsLike(t, p));
  const variants = tokens.filter((t) => !recordWords.has(t) && !COMMON.has(t) && !isFiller(t) && t.length > 1 && core.some((p) => soundsLike(t, p)));
  if (!readBack) for (const v of variants) flags.add(`another spelling: ${shown(v)}`);
  // A word of the record, word for word or by sound (the sound-alikes are flagged above).
  const like = (said: string, w: string) => said === w || (said.length > 1 && !isFiller(said) && !COMMON.has(said) && soundsLike(said, w));
  // Spelling examples are not people ("M as in Mother"); "co-worker" and "in-laws" are one word each.
  const people = withoutExamples(tokens)
    .join(" ")
    .replace(/\bco worker(s?)\b/g, "coworker$1")
    .replace(/\bin laws\b/g, "inlaws")
    .split(" ")
    .filter(Boolean);
  for (const p of people.filter((t) => PROXY.test(t))) flags.add(`said for someone else: ${shown(p)}`);
  // "my friend", "our client", "his name", "her address", "a friend of Sam Miller" (review of C10, 12 Nov).
  people.forEach((t, i) => {
    const before = people[i - 1] ?? "";
    // Not said to the agent: "Hello my friend", "Thank you, my friend".
    const toAgent = /^(hello|hi|hey|thanks|thank|you|yes|yeah|okay|ok|sure|morning|afternoon|evening|dear|oh|well)$/.test(people[i - 2] ?? "");
    const shownAs = (w: string) => (w === "coworker" || w === "coworkers" || w === "inlaws" ? w : shown(w));
    if ((KNOWN_TO.test(t) && WHOSE.test(before) && !toAgent) || (THEIRS.test(t) && THIRD_PERSON.test(before))) flags.add(`said for someone else: ${shown(before)} ${shownAs(t)}`);
    // "a friend of Sam Miller", not "a client of yours".
    else if (KNOWN_TO.test(t) && !/^clients?$/.test(t) && people[i + 1] === "of" && !/^(yours|your|you|us|ours)$/.test(people[i + 2] ?? ""))
      flags.add(`said for someone else: ${shownAs(t)} of`);
  });
  // Said as the past: "It used to be Hill Road", "my previous address", "we moved from Hill Road", "my maiden name", "my
  // old address", "but we've moved." (not "We just moved to Hill Road").
  tokens.forEach((t, i) => {
    const next = tokens[i + 1] ?? "";
    if (PAST.test(t) || (t === "used" && next === "to") || (t === "moved" && /^(from|out|away|)$/.test(next)) || (t === "old" && OLD_THING.test(next) && !writtenTogether(text, t, streetWords[0] ?? "")))
      flags.add(`said as the past: ${t === "used" || t === "old" || (t === "moved" && next) ? `${shown(t)} ${shown(next)}` : shown(t)}`);
  });
  const recordRuns = [...recordWords, nameWords.join(""), streetWords.join(""), cityWords.join(""), "usa"];
  for (const run of spelledLetters(tokens)) if (!recordRuns.includes(run)) flags.add(`spelled out: ${run.toUpperCase()}`);

  // A correction after the record's words, then another name or place: a capitalised word that isn't everyday, or
  // (outside a read-back) a sound-alike of the record ("Sam Miller. Sorry, Sam muller."). Everyday words after it
  // ("Sorry, bad line. Sam Miller.") are not another name. In a read-back the caller's sound-alike is what is being
  // checked, so it is not counted here either (as "another spelling" above).
  for (const [m, t] of tokens.entries()) {
    if (!CORRECTION.test(t) || !tokens.slice(0, m).some(isCore)) continue;
    const rest = tokens.slice(m + 1).filter((x) => !isFiller(x) && !CORRECTION.test(x) && !/^[a-z]$/.test(x) && !/^(ls|two|double|with)$/.test(x));
    const variant = (x: string) => isCore(x) && !recordWords.has(x);
    const other = rest.filter((x) => !recordWords.has(x) && !COMMON.has(x) && !BRIDGE.test(x) && !/^\d/.test(x) && (readBack ? caps.has(x) && !variant(x) : caps.has(x) || variant(x)));
    if (other.length) {
      flags.add(`a correction, then: ${other.map(shown).join(", ")}`);
      break;
    }
  }

  const everyday = (t: string) => isFiller(t) || COMMON.has(t) || CORRECTION.test(t) || BRIDGE.test(t) || recordWords.has(t);
  if (which === "name") {
    const isName = (t: string) => nameWords.some((w) => like(t, w));
    const first = tokens.findIndex(isName);
    // Straight before the name, a title passed over: "for Sam Miller", "for Mr. Sam Miller", "the late Sam Miller", "He's
    // Sam Miller", "His name is Sam Miller" (review of C10, 12 Nov).
    let b = first - 1;
    while (b >= 0 && TITLES.test(tokens[b])) b--;
    if (b >= 0 && (FOR_SOMEONE.test(tokens[b]) || tokens[b] === "late")) flags.add(`said for someone else: ${shown(tokens[b])}`);
    if (b >= 1 && tokens[b] === "of" && tokens[b - 1] === "instead") flags.add("said for someone else: instead of");
    const lead = tokens.slice(Math.max(0, b - 2), b + 1);
    const pronoun = lead.find((t) => /^(he|she|his|her)$/.test(t));
    // Once is enough: "His name is Sam Miller" already says "his name".
    if (first > 0 && pronoun && ![...flags].some((f) => f.startsWith(`said for someone else: ${shown(pronoun)} `)))
      flags.add(`said for someone else: ${shown(pronoun)}`);
    tokens.forEach((t, i) => {
      if (t === "for" && /^(him|her|them)$/.test(tokens[i + 1] ?? "")) flags.add(`said for someone else: for ${shown(tokens[i + 1])}`);
    });
    // An email for the name ("sam miller at example mail dot com") is not the name.
    if (tokens.includes("at") && (tokens.includes("com") || tokens.includes("dot") || text.includes("@"))) flags.add("an email, not a name");
    // Another person of the same name: "Sam Miller the Third", "Sam Miller, the younger"; not "Sam Miller. The second
    // time I've called."
    tokens.forEach((t, i) => {
      const suffix = tokens[i + 2] ?? "";
      if (isName(t) && tokens[i + 1] === "the" && GENERATION.test(suffix) && new RegExp(`(?<![\\p{L}'])${escaped(t)}(?:'s)?[\\s,]+the\\s+${escaped(suffix)}(?![\\p{L}])`, "iu").test(text))
        flags.add(`said for someone else: the ${shown(suffix)}`);
    });
    // Someone else's: the name said with "'s" straight before another word ("Sam Miller's house"), or after "be" or "was"
    // ("used to be Sam Miller's"), or after "the account is" ("the account is Sam's"). Not "Sam Miller's." alone, heard
    // for "Sam Miller." on 10 Oct, nor "Sam Miller's my name", where it means "is".
    const asWrittenWords = words(text).filter((w) => !HESITATION.test(w.replace(/'s$/, "")));
    tokens.forEach((t, i) => {
      const said = asWrittenWords[i] ?? "";
      if (!isName(t) || !said.endsWith("'s")) return;
      let j = i - 1;
      while (j >= 0 && isName(tokens[j])) j--;
      const [before, after] = [tokens[j], tokens[i + 1]];
      const owned =
        (after !== undefined && !IS_AFTER.test(after) && writtenTogether(text, said, after)) ||
        (before !== undefined && /^(be|been|was|were)$/.test(before)) ||
        (before === "is" && OWNED.test(tokens[j - 1] ?? ""));
      if (owned) flags.add(`said as someone else's: ${shown(said)}`);
    });
    // Another name beside the record's, "and" passed over: written with a capital, not a title or an everyday word. Only
    // when the rest already says the whole name: in "Sam Millerius." the word is the misheard surname itself, a
    // sound-alike the agent confirms or reads back, not more (review of C10, 12 Nov).
    // Joined to it by "and", a capital names someone even at a sentence's start ("Pam and Sam Miller.").
    const restSaysName = (n: string) => nameWords.every((w) => tokens.some((x) => x !== n && like(x, w)));
    tokens.forEach((t, i) => {
      if (!isName(t)) return;
      for (const step of [-1, 1]) {
        const viaAnd = tokens[i + step] === "and";
        const n = viaAnd ? tokens[i + 2 * step] : tokens[i + step];
        if (n && n.length > 1 && (namedBeside(n, t) || (viaAnd && caps.has(n))) && !everyday(n) && !isName(n) && !TITLES.test(n) && !/^\d/.test(n) && restSaysName(n))
          flags.add(`another name beside it: ${shown(n)}`);
      }
    });
    return [...flags];
  }

  // The street: its words together, with nothing but a number, filler, the city or (after it) a flat beside it.
  // In a read-back the street type may be a sound-alike too ("Church Hill Rode"): the words around it still count.
  const fitsStreet = (said: string, w: string) => (STREET_TYPES[w] ? STREET_TYPES[w].includes(said) || (readBack && like(said, w)) : like(said, w));
  const streets = runsAt(tokens, streetWords, fitsStreet);
  if (!streets.length && !readBack) flags.add("the street's words are apart");
  const number = (t: string) => /^\d/.test(t) || numberWord(t) !== null || /^(hundred|thousand)$/.test(t);
  // The record's own words spelled out beside it are the same street or city ("Hill Road, H I L L, Dallas").
  const spelledOwn = new Set(spelledRunsAt(tokens).filter((r) => recordRuns.includes(r.run)).flatMap((r) => tokens.slice(r.from, r.to + 1).map((_, k) => r.from + k)));
  const fineBeside = (t: string, after: boolean, at: number, street: number) => {
    if ((after ? STREET_AFTER : STREET_BEFORE).test(t)) return false;
    if (!after && (STREET_NAMING.test(t) || ORDINAL.test(t)) && writtenTogether(text, t, tokens[street])) return false;
    // "house number 12", "third floor", "Third floor, Hill Road", "12 B Hill Road", a spelled street.
    if (after && ORDINAL.test(t) && UNIT.test(tokens[at + 1] ?? "")) return true;
    if (!after && UNIT.test(t) && !writtenTogether(text, t, tokens[street])) return true;
    if (!after && /^[a-z]$/.test(t) && number(tokens[at - 1] ?? "")) return true;
    return spelledOwn.has(at) || everyday(t) || number(t) || (after && UNIT.test(t));
  };
  for (const s of streets) {
    const [b4, af] = [s - 1, s + streetWords.length];
    const [before, after] = [tokens[b4], tokens[af]];
    if (before && !fineBeside(before, false, b4, s)) flags.add(`a word before the street: ${shown(before)}`);
    if (after && !fineBeside(after, true, af, s)) flags.add(`a word after the street: ${shown(after)}`);
  }
  const ownTypes = new Set([...typeWords, ...typeWords.flatMap((w) => STREET_TYPES[w] ?? [])]);
  tokens.forEach((t, i) => {
    // Only straight after a word that could name it: "Main Street", not "the street is" or "Dallas. Street: Hill Road".
    const prev = tokens[i - 1];
    if (i > 0 && STREET_TYPE_ALL.test(t) && !ownTypes.has(t) && !isFiller(prev) && !/^(which|whats|what's)$/.test(prev) && writtenTogether(text, prev, t))
      flags.add(`another street type: ${shown(t)}`);
  });

  // Another state, by name ("Oklahoma", "New Mexico") or by its code written after the city ("Dallas, OK").
  const stateNameWords = new Set(Object.values(US_STATES).flatMap((n) => n.split(" ")));
  for (const [code, name] of Object.entries(US_STATES)) {
    if (code === stateCode || cityWords.join(" ") === name || streetWords.join(" ") === name) continue;
    const own = runsAt(tokens, words(US_STATES[stateCode] ?? ""));
    const at = runsAt(tokens, name.split(" ")).filter((p) => !own.some((o) => p >= o && p < o + words(US_STATES[stateCode] ?? "").length));
    if (at.length) flags.add(`another state: ${name.split(" ").map(shown).join(" ")}`);
  }
  const cityAt = text.toLowerCase().indexOf(customer.address.city.toLowerCase());
  if (cityAt >= 0) {
    const code = /^[\s,.]*([A-Z]{2})(?![\p{L}])/u.exec(text.slice(cityAt + customer.address.city.length))?.[1]?.toLowerCase();
    if (code && code in US_STATES && code !== stateCode && code !== "ok") flags.add(`another state: ${code.toUpperCase()}`);
  }

  // Somewhere near the city, not in it: "Dallas area", "Dallas County", or "near" or "outside" before the city or another
  // place ("near Dallas", "outside Fort Worth"); not before a landmark ("near the school", review of C10, 12 Nov).
  for (const p of tokens.filter((t) => PLACE_NEAR.test(t))) flags.add(`a place word: ${shown(p)}`);
  tokens.forEach((t, i) => {
    if (!NEAR.test(t)) return;
    let j = i + 1;
    while (/^(the|to|by|of)$/.test(tokens[j] ?? "")) j++;
    const n = tokens[j];
    if (n && (cityWords.some((w) => like(n, w)) || (caps.has(n) && !everyday(n)))) flags.add(`a place word: ${shown(t)}`);
  });
  for (const c of runsAt(tokens, cityWords, like)) {
    for (const [n, after] of [[tokens[c - 1], false], [tokens[c + cityWords.length], true]] as const) {
      if (!n) continue;
      const place = PLACE_NEXT.test(n) && (n !== "city" || after);
      const named = namedBeside(n, tokens[after ? c + cityWords.length - 1 : c]) && n.length > 1 && !everyday(n) && !stateNameWords.has(n) && !(n in US_STATES) && !COUNTRY.test(n) && !number(n);
      if (place || named) flags.add(`a word beside the city: ${shown(n)}`);
    }
  }
  return [...flags];
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
export function readBackFits(which: "name" | "address", text: string, customer: Customer, opts: MatchOptions = {}): boolean {
  if (deniesIdentity(text)) return false;
  // An email answer is never followed by the street and city: that would say words the caller never gave.
  const said = answerWords(text);
  if (which === "address" && said.includes("at") && (said.includes("com") || said.includes("mail") || said.some((t) => t.includes("@")))) return false;
  // With stricter matching, an answer that says more than the record ("Church Hill Road") is asked again, never read back.
  const result = which === "name" ? matchName(text, customer, opts) : matchAddress(text, customer, opts);
  // Nor one that says more than the record, even by sound ("Church Hil Road in Dallas", "for my husband, Sam Mellor").
  if (opts.strict && strictFlags(which, text, customer, { readBack: true }).length) return false;
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
