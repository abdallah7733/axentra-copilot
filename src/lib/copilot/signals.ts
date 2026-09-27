import { findPhrase, normalize } from "./text";

/*
  Rules that read meaning from one line of recognised speech. Each rule returns the
  phrase that triggered it, so every suggestion can show its evidence. Patterns run
  on normalised text (lower case, no punctuation) and include the mis-hearings seen
  on real calls ("track screen", "arards").
*/

export type Hit = { phrase: string; weight: number };

type Rule = { pattern: RegExp; weight: number };

function hits(text: string, rules: Rule[]): Hit[] {
  const out: Hit[] = [];
  for (const rule of rules) {
    const found = findPhrase(text, rule.pattern);
    if (found && !found.negated) out.push({ phrase: found.phrase, weight: rule.weight });
  }
  return out;
}

const DAMAGE: Rule[] = [
  { pattern: /\b(screen|glass|display)( is| was|s|'s| has| got)? (a )?(cracked|crack|broken|shattered|smashed|damaged|scratched)\b/, weight: 1 },
  { pattern: /\b(cracked|broken|shattered|smashed|damaged) (screen|glass|display|tablet|box|laptop|device|item)\b/, weight: 1 },
  { pattern: /\b(came|arrived|arrive|arrives|showed up|got here|was delivered|delivered) (damaged|broken|cracked|smashed)\b/, weight: 1 },
  { pattern: /\b(tablet|laptop|device|it|item)( is|'s| was| came| arrived)? (damaged|broken|cracked|smashed|dented)\b/, weight: 0.9 },
  { pattern: /\bcrack(ed|s)?\b/, weight: 0.8 },
  { pattern: /\b(damaged|damage|broken|shattered|smashed|dented|crushed)\b/, weight: 0.6 },
  // "cracked screen" heard as "track screen" on a real call.
  { pattern: /\b(track(ed)? screen|screen( is| was)? track(ed)?)\b/, weight: 0.5 },
];

/** Words that support a damaged-delivery reading but are not enough on their own. */
const DELIVERY_CONTEXT: Rule[] = [
  { pattern: /\b(came|arrived|arrive|arards|arised|delivered|got it|showed up)( yesterday| today| this morning)?\b/, weight: 0.15 },
  { pattern: /\b(screen|box|package|tablet)\b/, weight: 0.1 },
];

const ORDER_STATUS: Rule[] = [
  { pattern: /\b(where('s| is) my (order|package|tablet)|has ?n'?t (arrived|come)|has not (arrived|come)|did ?n'?t (arrive|come)|never (arrived|came)|still waiting|tracking( number)?)\b/, weight: 1 },
];

export type Intent = { id: "damaged" | "order-status"; score: number; evidence: string[] };

/** Scores a caller line for each intent the Sunlake pack knows about. */
export function readIntent(text: string): Intent[] {
  const out: Intent[] = [];
  const damage = hits(text, DAMAGE);
  if (damage.length) {
    const context = hits(text, DELIVERY_CONTEXT);
    const score = Math.min(0.97, Math.max(...damage.map((h) => h.weight)) + context.reduce((s, h) => s + h.weight, 0));
    out.push({ id: "damaged", score, evidence: [...damage, ...context].map((h) => h.phrase) });
  }
  const status = hits(text, ORDER_STATUS);
  if (status.length) out.push({ id: "order-status", score: 0.9, evidence: status.map((h) => h.phrase) });
  return out;
}

const WANTS_REPLACEMENT: Rule[] = [
  { pattern: /\b((a|the) new one|another one|new (tablet|one|device|unit)|replace( it| the \w+)?|replacement|exchange( it)?|swap( it)?)\b/, weight: 1 },
];
const WANTS_REFUND: Rule[] = [
  { pattern: /\b(money back|refund(ed)?|pay me back|cancel( it| the order)?|reimburse(d|ment)?)\b/, weight: 1 },
];

export type Choice = "replacement" | "refund" | "both";

/** What the caller asks for. Both in one line ("a new one, or my money back?") is a question, not a choice. */
export function readChoice(text: string): { choice: Choice; phrases: string[] } | null {
  const replacement = hits(text, WANTS_REPLACEMENT);
  const refund = hits(text, WANTS_REFUND);
  if (replacement.length && refund.length) return { choice: "both", phrases: [...replacement, ...refund].map((h) => h.phrase) };
  if (replacement.length) return { choice: "replacement", phrases: replacement.map((h) => h.phrase) };
  if (refund.length) return { choice: "refund", phrases: refund.map((h) => h.phrase) };
  return null;
}

const ESCALATION: Rule[] = [
  { pattern: /\b(charge ?backs?|dispute (it|the charge|this) with (my|the) (bank|card))\b/, weight: 1 },
  { pattern: /\b(my|the) bank\b/, weight: 1 },
  { pattern: /\b(lawyers?|attorneys?|sue|suing|legal action|small claims)\b/, weight: 1 },
  { pattern: /\b(fraud|scam(med)?)\b/, weight: 1 },
  { pattern: /\b(second|third) time\b|\bhappened (before|again)\b/, weight: 1 },
];

const SAFETY: Rule[] = [
  { pattern: /\b(very |really |so |too |getting |gets |got |is |was )?(hot|overheat(ing|s|ed)?|heat(ing)? up)\b/, weight: 1 },
  { pattern: /\b(smoke|smoking|smoky)\b/, weight: 1 },
  { pattern: /\b(burning|burnt|burned|burn) ?(smell)?\b|\bsmells? (like )?burn(ing|t)?\b/, weight: 1 },
  { pattern: /\b(swollen|swelling|bulging|puffed up)\b/, weight: 1 },
  { pattern: /\bbattery\b/, weight: 1 },
  { pattern: /\b(hurt|injur(y|ed|ies)|cut (my|his|her) (hand|finger))\b/, weight: 1 },
  { pattern: /\b(fire|flames?|sparks?|sparking|melt(ed|ing)?|explod(e|ed|ing))\b/, weight: 1 },
];

/** Words that trigger Scenario C (chargeback, lawyer, fraud, second claim). */
export const escalationWords = (text: string) => hits(text, ESCALATION).map((h) => h.phrase);
/** Safety words (heat, smoke, burning smell, swelling, battery, injury). */
export const safetyWords = (text: string) => hits(text, SAFETY).map((h) => h.phrase);

/* ---------- Agent-side patterns ---------- */

const OFFER = [
  /\b(i can|i could|i'll|i will|we can|we could|we'll|we will|let me|i'm going to|i am going to|i'd like to)\b( \w+){0,3} (send|ship|replace|refund|give|issue|get you|process|arrange|set up|swap|exchange)\b/,
  /\bwould you like( me to)?( \w+){0,3} (replacement|refund|new one|replace|send|a new)\b/,
  /\b(you can have|you'll get|you will get)\b/,
  /\b(replacement|refund|new one|new tablet)\b( \w+){0,5} (today|right away|right now|now)\b/,
  /\bships? (today|tomorrow|right away)\b/,
];

/** The agent offers or promises a replacement or refund. */
export function agentOffers(text: string): string | null {
  for (const pattern of OFFER) {
    const found = findPhrase(text, pattern);
    if (found && !found.negated) return found.phrase;
  }
  return null;
}

/** The agent says the resolution is done ("Done. The new tablet ships today."). */
export function agentCommits(text: string): string | null {
  const found = findPhrase(
    text,
    /\b(done|all set|i've (sent|set up|arranged|processed|placed|created|issued|booked)|it's on (its|the) way|(has|have) been (sent|processed|arranged|issued)|ships? today|is on its way)\b/
  );
  return found && !found.negated ? found.phrase : null;
}

/** Which verification factor the agent is asking for, if any. */
export function agentAsksFor(text: string): "name" | "address" | "order" | null {
  const norm = normalize(text);
  const asking = /\b(can i have|may i have|could i have|can you (give|tell|confirm)|could you (give|tell|confirm)|what('s| is)|please|confirm)\b|\?/.test(text.toLowerCase()) || /\b(can i have|may i have|what is|whats)\b/.test(norm);
  if (!asking) return null;
  if (/\b(full name|your name|the name|name on the order)\b/.test(norm)) return "name";
  if (/\b(street|city|address|zip|postcode|post code|email|e mail)\b/.test(norm)) return "address";
  if (/\border number\b/.test(norm)) return "order";
  return null;
}

/** The agent says which verification detail failed, which the SOP forbids. */
export function agentDisclosesFactor(text: string): string | null {
  const found = findPhrase(
    text,
    /\b(name|email|e mail|street|city|address)( \w+){0,3} (does ?n'?t|does not|did ?n'?t|did not|do ?n'?t|isn'?t|is not) (match|right|correct)\b|\bwrong (name|email|street|city|address)\b|\b(name|email|street|city|address) (is|was) (wrong|incorrect)\b/
  );
  return found ? found.phrase : null;
}
