import { agentCommits } from "./signals";
import { normalize } from "./text";
import type { ClientPack, TranscriptEvent } from "./types";

/*
  Optional local language model (the engine's /assist, on the Mac only). It has two
  small jobs and decides nothing:
    1. reword the rules' suggested reply so it answers the caller's last words;
    2. read a caller line the rules could not classify.
  Every reworded reply is checked against the rules' draft: if a number, name, offer,
  status, condition or approval phrase changes, the draft is kept. Only neutral lines
  (no amounts, outcomes or order facts) are sent for rewording at all (Call 11, I-21).
*/

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const transcriptTail = (lines: TranscriptEvent[], n = 4) =>
  lines
    .slice(-n)
    .map((l) => `${l.side === "agent" ? "Agent" : "Caller"}: ${l.text}`)
    .join("\n");

export function replyMessages(pack: ClientPack, lines: TranscriptEvent[], draft: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        `You help a phone support agent at ${pack.company.name}. Rewrite the draft reply so it sounds natural and follows on from the caller's last words. ` +
        "Keep every fact, number, name and offer in the draft exactly: if the draft offers two options, keep both, and keep words such as today, free, no cost, refund and replacement. " +
        "Do not add offers, amounts, dates, times, policies or questions that are not in the draft. " +
        "Do not address the caller by name and do not add any name: use a name only where the draft has it. " +
        "At most three short sentences. Answer with the rewritten reply only.",
    },
    { role: "user", content: `Call so far:\n${transcriptTail(lines)}\n\nDraft reply:\n${draft}` },
  ];
}

const numbers = (text: string) => (text.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", "")).sort();
/** Words that change what is being offered or promised. */
const COMMITMENTS = /\b(refund|replace(ment)?|new (one|tablet)|money back|escalat\w*|transfer\w*|call (you )?back|return label|no cost|free|today|tomorrow)\b/gi;
/** Same offer, different words: "a new tablet" and "a replacement" are one commitment. */
const CANONICAL: [RegExp, string][] = [
  [/^(replace(ment)?|new (one|tablet))$/, "replacement"],
  [/^(refund|money back)$/, "refund"],
  [/^(free|no cost)$/, "free"],
  [/^(escalat\w*|transfer\w*)$/, "escalate"],
];
const commitments = (text: string) =>
  [
    ...new Set(
      (text.toLowerCase().match(COMMITMENTS) ?? []).map((w) => {
        const word = w.replace(/\s+/g, " ");
        return CANONICAL.find(([p]) => p.test(word))?.[1] ?? word;
      })
    ),
  ].sort();

const wordsOf = (text: string) => text.toLowerCase().match(/[a-z0-9]+(?:['’][a-z]+)?/g) ?? [];
/** Words that may end a clause after a comma without being a name: "…, too." "…, please." */
const CLOSERS = new Set(["too", "please", "then", "now", "today", "again", "though", "okay", "ok", "either", "instead", "anyway", "already", "still", "yet", "first", "here", "there", "right", "thanks", "you"]);
/** Words that may open a sentence before a comma: "Sure, …" "Of course, …" */
const OPENERS = new Set(["sure", "okay", "ok", "alright", "right", "yes", "no", "well", "so", "now", "great", "perfect", "thanks", "thank", "sorry", "absolutely", "certainly", "unfortunately", "first", "also", "course", "understood", "got", "of", "and", "but", "then", "otherwise", "meanwhile", "good", "lovely", "oh"]);
/**
 * Words that say what has already happened, or fix a condition, a unit, a payment method or a negation.
 * A rewording must keep exactly the draft's set of them: it may not add "processed", "has been placed",
 * "already", "on its way", "prepaid", "hours", or drop "when the carrier scans" (Call 11: "We've processed the
 * return for the damaged tablet and a replacement order for the new tablet has been placed").
 */
const STATUS =
  /\b(process(ed|ing)|placed|sent|shipped|dispatched|issued|refunded|credit(ed)?|completed?|confirmed|arranged|approved|verified|done|all set|already|received|collected|e-?mailed|arriv\w*|deliver\w*|cancell?ed|booked|scheduled|set up|taken care|on (its|the|their) way|been|was|were|prepaid|courier|pick ?up|discount\w*|voucher\w*|gift|keep|upgrad\w*|overnight|express|photos?|scan\w*|label|minutes?|hours?|days?|weeks?|months?|business|visa|mastercard|amex|card|cash|not|never|no|\w+n['’]t|cannot)\b/gi;
const STATUS_CANON: [RegExp, string][] = [
  [/^(arriv|deliver)/, "delivered"],
  [/^scan/, "scan"],
  [/n't$|^(not|never|cannot)$/, "not"],
  [/^(minute|hour|day|week|month)s$/, ""],
  [/^e-?mailed$/, "emailed"],
  [/^pick ?up$/, "pickup"],
];
const statusOf = (text: string) =>
  [
    ...new Set(
      (text.toLowerCase().match(STATUS) ?? []).map((w) => {
        const word = w.replace(/\s+/g, " ").replace(/’/g, "'");
        const c = STATUS_CANON.find(([p]) => p.test(word));
        return c ? c[1] || word.slice(0, -1) : word;
      })
    ),
  ].sort();

/** Words a reworded neutral line may add: politeness and plain function words only, never a name or a claim. */
const POLITE = new Set(
  (
    "a an the and or but so of to for with at on in into from by about before after first then now just also too please thanks thank you your " +
    "i i'm i'll i'd we we'll we're me my us our it it's that this there here can could would will may might need have has get give tell say " +
    "let let's help check look see take make sure course okay ok alright right great perfect sorry really very truly terribly apologies " +
    "apologise apologize understand understood certainly absolutely happy glad again once more one moment quick quickly kindly mind what " +
    "which how is are be do go ahead name full last details order address email street city delivery spell repeat oh no problem hear that's " +
    "if anything else"
  ).split(" ")
);

const I_FORMS = /^I(['’](m|ll|ve|d))?$/;

/**
 * A name the model put into the reply that isn't in the draft. Names come from the verified record in
 * the rules' draft, never from the model (call 10: "I'm sorry to hear that, Afzata."). Checked: any
 * known person's name, a capitalised word mid-sentence, and a word in a place where a name goes
 * (", Afzata." at the end of a clause, "Afzata, …" at the start, "Hi Afzata"), in any capitalisation.
 */
function addedName(draft: string, text: string, people: string[]): string | null {
  const inDraft = new Set(wordsOf(draft));
  const added = (w: string) => !inDraft.has(w.toLowerCase().replace(/’/g, "'"));
  const known = new Set(people.flatMap(wordsOf));
  for (const w of wordsOf(text)) if (known.has(w) && added(w)) return w;
  // Capitalised words that don't start a sentence.
  for (const m of text.matchAll(/[A-Za-z][\w'’-]*/g)) {
    const before = text.slice(0, m.index).trimEnd();
    const startsSentence = before === "" || /[.!?:"“]$/.test(before);
    if (/^[A-Z]/.test(m[0]) && !startsSentence && !I_FORMS.test(m[0]) && added(m[0])) return m[0];
  }
  for (const m of text.matchAll(/,\s*([A-Za-z][\w'’-]*)\s*(?=[.!?]|$)/g)) if (added(m[1]) && !CLOSERS.has(m[1].toLowerCase())) return m[1];
  for (const m of text.matchAll(/(?:^|[.!?]\s+)([A-Za-z][\w'’-]*)\s*,/g)) if (added(m[1]) && !OPENERS.has(m[1].toLowerCase())) return m[1];
  for (const m of text.matchAll(/\b(?:hi|hello|hey|dear)\s+([A-Za-z][\w'’-]*)/gi)) if (added(m[1]) && !["there", "again"].includes(m[1].toLowerCase())) return m[1];
  return null;
}

/**
 * Why the model's wording can't be shown, or null if it can: it changed a number, an offer, a status,
 * condition, unit, card or negation word, or an approval phrase, dropped a name the draft has, or added a
 * name (then the draft stays). `names`: names in the draft that must survive (the customer's first name,
 * the product). `people`: every person the client pack knows, none of whom may be added. `neutral`: the
 * draft has no order facts, so the wording may add only politeness and function words.
 */
export function wordingProblem(draft: string, worded: string, names: string[], people: string[] = [], neutral = false): string | null {
  const text = cleanWording(worded);
  if (!text) return "empty";
  if (text.length > draft.length * 2 + 80 || /\n\s*[-*\d]/.test(text)) return "too long or a list";
  if (numbers(text).join() !== numbers(draft).join()) return "a number changed";
  if (commitments(text).join() !== commitments(draft).join()) return "an offer changed";
  for (const name of names) if (draft.includes(name) && !text.includes(name)) return `dropped "${name}"`;
  const added = addedName(draft, text, people);
  if (added) return `added the name "${added}"`;
  if (statusOf(text).join() !== statusOf(draft).join()) return "a status, condition, unit or card word changed";
  // Reading the line aloud must approve exactly what reading the draft would (Call 11 at video 110 s dropped "Done").
  if (!!agentCommits(normalize(text)) !== !!agentCommits(normalize(draft))) return "approval words added or dropped";
  if (neutral) {
    const inDraft = new Set(wordsOf(draft).map((w) => w.replace(/’/g, "'")));
    const extra = wordsOf(text).find((w) => !inDraft.has(w.replace(/’/g, "'")) && !POLITE.has(w.replace(/’/g, "'")));
    if (extra) return `added "${extra}" to a neutral line`;
  }
  return null;
}

const cleanWording = (worded: string) => worded.trim().replace(/^["“]|["”]$/g, "").trim();

/** The model gave the draft back unchanged (Call 12 at 00:21: labelled "Reworded" with the same words). */
export function sameWording(draft: string, worded: string): boolean {
  const flat = (s: string) => cleanWording(s).replace(/’/g, "'").replace(/\s+/g, " ").toLowerCase();
  return flat(draft) === flat(worded);
}

/** The model's wording, or null if `wordingProblem` finds one (then the draft stays). */
export function checkWording(draft: string, worded: string, names: string[], people: string[] = [], neutral = false): string | null {
  return wordingProblem(draft, worded, names, people, neutral) ? null : cleanWording(worded);
}

export const INTENT_LABELS = ["damaged", "order_status", "other"] as const;

export function classifyMessages(text: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "Classify what a caller says to an electronics store. Labels: damaged (the item arrived broken, cracked or damaged), order_status (asking where an order is, or it has not arrived), other. " +
        "Speech recognition makes mistakes, so read for meaning. Answer with one label only.",
    },
    { role: "user", content: text },
  ];
}

export function parseIntentLabel(answer: string): "damaged" | "order-status" | null {
  const a = answer.toLowerCase();
  if (/\bdamaged\b/.test(a)) return "damaged";
  if (/order[_ ]status/.test(a)) return "order-status";
  return null;
}
