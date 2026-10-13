import type { ClientPack, TranscriptEvent } from "./types";

/*
  Optional local language model (the engine's /assist, on the Mac only). It has two
  small jobs and decides nothing:
    1. reword the rules' suggested reply so it answers the caller's last words;
    2. read a caller line the rules could not classify.
  Every reworded reply is checked against the rules' draft: if a number, name or
  offer changes, the draft is kept.
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
 * The model's wording, or null if it changed a number or an offer, dropped a name the draft has, or
 * added a name (then the draft stays). `names`: names in the draft that must survive (the customer's
 * first name, the product). `people`: every person the client pack knows, none of whom may be added.
 */
export function checkWording(draft: string, worded: string, names: string[], people: string[] = []): string | null {
  const text = worded.trim().replace(/^["“]|["”]$/g, "").trim();
  if (!text || text.length > draft.length * 2 + 80 || /\n\s*[-*\d]/.test(text)) return null;
  if (numbers(text).join() !== numbers(draft).join()) return null;
  if (commitments(text).join() !== commitments(draft).join()) return null;
  for (const name of names) if (draft.includes(name) && !text.includes(name)) return null;
  if (addedName(draft, text, people)) return null;
  return text;
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
