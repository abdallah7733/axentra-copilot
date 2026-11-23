import { words } from "./text";

/*
  C12 (his "Build C12", 23 Nov 2026): for a name or address answer, the check model hears the agent's question and the
  answer together. The question goes in front only when the fast model's words for it closely match one of his usual
  questions below. It is a list of allowed questions, not a screen for names: before the clip is sent, the console has
  only the fast model's words for the line, and those can mishear a name. A line that isn't on the list (a read-back, a
  question with the caller's name in it, an echo of the caller on the agent's microphone, a line the fast model garbled)
  never goes in front, and that answer keeps today's check. Safer than screening, not absolute: the fast model can drop a
  word that was said.

  The questions are the ones he asks on the test calls and in the scripts. On the 11 Nov calls the fast model wrote his
  address question as "and the street and city for delivery.", "and street and city for delivery.", "And a street and
  city for the delivery." and "and the city for delivery.", so articles and "please" don't count, and a question may be
  missing up to two of its words, or have one word changed or added; every word must still be one of his questions' own.
*/

export type IdentityDetail = "name" | "address";

/** Said before the question itself: "I'm sorry to hear that. First, …", "Thank you. And …". Only at the start. */
const LEAD_INS = [
  "i'm sorry to hear that",
  "i am sorry to hear that",
  "sorry",
  "thank you",
  "thanks",
  "okay",
  "ok",
  "great",
  "perfect",
  "alright",
  "and",
  "first",
  "now",
  "next",
  "also",
].map((lead) => lead.split(" "));

/** Dropped before comparing: the fast model drops or swaps them. */
const IGNORED = new Set(["the", "a", "an", "please"]);

/** His usual questions for each detail, and their re-asks. */
export const USUAL_QUESTIONS: Record<IdentityDetail, readonly string[]> = {
  name: [
    "Can I have your full name, please?",
    "Could I have your full name, please?",
    "May I have your full name, please?",
    "Can I have the full name on the account?",
    "Could I have the full name on the account?",
    "May I have the full name on the account?",
    "What's your full name?",
    "What is your full name?",
    "What's the full name on the account?",
    "What is the full name on the account?",
    "Your full name, please?",
    "The full name on the account?",
    "Could you repeat your full name?",
    "Can you repeat your full name?",
    "Could you repeat the full name on the account?",
    "Can you repeat the full name on the account?",
    "Could you say your full name again?",
    "Can you say your full name again?",
  ],
  address: [
    "The street and city for the delivery?",
    "The street and city?",
    "Can I have the street and city for the delivery?",
    "Could I have the street and city for the delivery?",
    "May I have the street and city for the delivery?",
    "What's the street and city for the delivery?",
    "What is the street and city for the delivery?",
    "Could you repeat the street and city?",
    "Can you repeat the street and city?",
    "Could you repeat the street and city for the delivery?",
    "Can you repeat the street and city for the delivery?",
  ],
};

const core = (text: string) => words(text).filter((w) => !IGNORED.has(w));
const TEMPLATES: Record<IdentityDetail, string[][]> = {
  name: USUAL_QUESTIONS.name.map(core),
  address: USUAL_QUESTIONS.address.map(core),
};
/** Every word a question may have once its lead-in is gone. */
export const QUESTION_WORDS: ReadonlySet<string> = new Set([...TEMPLATES.name, ...TEMPLATES.address].flat());
const NAMES_IT = (w: string[]) => w.includes("name");
const PLACES_IT = (w: string[]) => w.includes("street") || w.includes("city");

/** Word-level edit distance (insert, delete or change one word). */
function distance(a: readonly string[], b: readonly string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** `a` is `b` with some of its words left out, in order. */
function within(a: readonly string[], b: readonly string[]): boolean {
  let j = 0;
  for (const w of a) {
    while (j < b.length && b[j] !== w) j++;
    if (j++ >= b.length) return false;
  }
  return true;
}

/** A line's words without articles and "please", and without the lead-ins said before the question itself. */
function questionWords(text: string): string[] {
  let w = core(text);
  for (let found = true; found; ) {
    found = false;
    for (const lead of LEAD_INS)
      if (lead.length <= w.length && lead.every((word, i) => w[i] === word)) {
        w = w.slice(lead.length);
        found = true;
        break;
      }
  }
  return w;
}

/**
 * The fast model's words for an agent line closely match one of his usual questions for this detail. `avoid`: words of
 * the customer records (names, streets, cities); a line with any of them never matches, even where the word is also an
 * ordinary one ("May"), or one of the words dropped before comparing ("An").
 */
export function usualQuestion(text: string, detail: IdentityDetail, avoid: ReadonlySet<string> = new Set()): boolean {
  if (words(text).some((word) => avoid.has(word))) return false;
  const w = questionWords(text);
  if (w.length < 2 || w.some((word) => !QUESTION_WORDS.has(word))) return false;
  if (detail === "name" ? !NAMES_IT(w) || PLACES_IT(w) : !PLACES_IT(w) || NAMES_IT(w)) return false;
  return TEMPLATES[detail].some((t) => distance(w, t) <= 1 || (within(w, t) && t.length - w.length <= 2));
}

/** The detail a line asks for, when it is one of his usual questions. */
export const usualDetail = (text: string): IdentityDetail | null => (usualQuestion(text, "name") ? "name" : usualQuestion(text, "address") ? "address" : null);

/**
 * Words found after a line are the rest of one of his usual questions for this detail: for one of them, each of those
 * words takes away exactly one word of the line's distance to it, and the line ends no further from his usual questions
 * than it was. An echo of his question ("Name?") or a word of the caller's that is also one of his ("May.") only stands
 * in for a missing word, or adds one, so it never counts (check of the C12 fixes, 23 Nov). Articles and "please" don't
 * count as words here; on their own, only "please" is his.
 */
export function fillsGap(text: string, added: string, detail: IdentityDetail): boolean {
  const own = core(added);
  if (!own.length) return words(added).includes("please");
  const before = questionWords(text);
  const after = questionWords(`${text} ${added}`);
  const closest = Math.min(...TEMPLATES[detail].map((t) => distance(before, t)));
  return TEMPLATES[detail].some((t) => distance(after, t) <= closest && distance(before, t) - distance(after, t) === own.length);
}

/** A word of his usual questions, articles and "please" included. */
export const isQuestionWord = (word: string): boolean => QUESTION_WORDS.has(word) || IGNORED.has(word);
