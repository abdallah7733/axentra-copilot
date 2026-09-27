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

/** The model's wording, or null if it changed a number or an offer (then the draft stays). */
export function checkWording(draft: string, worded: string, names: string[]): string | null {
  const text = worded.trim().replace(/^["“]|["”]$/g, "").trim();
  if (!text || text.length > draft.length * 2 + 80 || /\n\s*[-*\d]/.test(text)) return null;
  if (numbers(text).join() !== numbers(draft).join()) return null;
  if (commitments(text).join() !== commitments(draft).join()) return null;
  // Names in the draft (customer, product) must survive; no other capitalised name may appear from nowhere.
  for (const name of names) if (draft.includes(name) && !text.includes(name)) return null;
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
