import { findOrderMentions, findSplitOrder, matchOrder, type MentionMethod, type OrderMention } from "./orders";
import { agentAsksChoice, agentAsksFor, agentCommits, agentDisclosesFactor, agentOffers, escalationWords, readChoice, readIntent, safetyWords, type Choice } from "./signals";
import { findAffirmed, normalize, repeatsItself, soundsLike, words as textWords } from "./text";
import type { AgentAction, AuthorityBand, ClientPack, Customer, Order, Side, TranscriptEvent } from "./types";
import { COMMON, deniesIdentity, isFiller, matchAddress, matchName, namesAnother, readBackFits, soundsLikeRecord } from "./verification";

/*
  The copilot's rules layer. `analyze` rebuilds the whole copilot view from the
  call's final transcript lines and the agent's panel actions, every time a new one
  arrives. It is a pure function, so the same lines always give the same view.

  Business decisions (identity, eligibility, amounts, escalation) come only from the
  client's SOP rules and order data. A language model may later reword the suggested
  reply; it never decides anything here. Nothing is executed: the copilot suggests,
  the agent decides.
*/

/** Recognition confidence below this is "low confidence", as shown in the transcript. */
export const LOW_CONFIDENCE = 0.6;
/** A sentence that restates a term on purpose, superseding a wrong number said before it (normalised text). */
const CORRECTION = /^((okay|ok|so|oh|sorry|i'm sorry|i am sorry) )*(just )?(to be clear|to confirm|correction|i mean|i meant|i misspoke|let me correct( that)?|to correct that)\b/;

/**
 * A pause can split one identity answer into two lines ("Hill Road, in Dallas" came out as
 * "Helrout." and "Indalis." on the accuracy read). Caller lines after the agent's question
 * are one answer until the agent speaks again or the caller has been silent this long.
 */
export const ANSWER_GAP_MS = 2000;

export type Evidence = {
  key: string;
  seq: number;
  side: Side;
  text: string;
  /** When it was said. */
  at: number;
  /** When the copilot could first use it: the line's arrival or check result, or the agent's typing, whichever is later. */
  knownAt: number;
  lowConfidence: boolean;
  /** The agent typed this text; speech recognition heard this instead. */
  typedFrom?: string;
  /** What the fast speech model heard, when the second model's check replaced it. */
  firstHeard?: string;
};

export type FactorState = "idle" | "asking" | "partial" | "confirm" | "ok" | "failed";
export type Factor = {
  id: "name" | "address";
  label: string;
  state: FactorState;
  attempts: number;
  method?: string;
  evidence?: Evidence;
  /** The answer as heard so far, across lines. */
  heard?: string;
  /** The same answer as the fast speech model heard it, where the second model's check replaced its words. */
  heardFirst?: string;
  /** When the factor was verified, by when its evidence was usable (see Evidence.knownAt). */
  knownAt?: number;
  /**
   * Why the agent is asked to confirm: a doubtful line, a garbled one, or an answer that only sounds
   * like the record. "disagree": a wrong answer the two speech models heard differently; the agent
   * asks again or types the caller's words, and can't just confirm it. "ambiguous": the answer names
   * two candidates or denies something else; asked again, never confirmed.
   */
  confirmReason?: "low-confidence" | "garbled" | "sounds-like" | "disagree" | "ambiguous" | "after-read-back";
  /** The caller's yes to the agent's read-back of the name (see Policy.nameReadBack). */
  confirmedBy?: Evidence;
  /** When the caller finished their first answer for this factor (all its lines): with knownAt, how long accepting it took. */
  answeredAt?: number;
};

export type OrderView = Order & { deliveredLabel: string; deliveredDate: string | null };

export type Check = { id: "window" | "stock" | "value" | "claims" | "photo"; label: string; pass: boolean; detail: string; sopRef: string };

export type StepStatus = "pending" | "active" | "done" | "attention" | "blocked" | "skipped";
export type SopStep = { id: string; label: string; status: StepStatus; detail?: string; evidence?: Evidence; sopRef: string };

export type Alert = {
  id: string;
  level: "warning" | "danger";
  title: string;
  detail: string;
  sopRef: string;
  evidence: Evidence[];
  /** Set once the problem is dealt with, e.g. identity verified after an early offer. */
  resolved?: string;
};

export type ConfirmPrompt = {
  target: "issue" | "name" | "address" | "order" | "choice";
  text: string;
  evidence?: Evidence;
  /** Nothing to confirm: the agent has to ask the caller again (an answer no rule could read). */
  askAgain?: boolean;
};

export type Recommendation = {
  scenario: "A" | "B" | "C";
  /** Scenario B is also open (the customer asked about both). */
  alsoAllowed?: "B";
  title: string;
  action: string;
  reasons: string[];
  sopRef: string;
  evidence: Evidence[];
  approver: string;
  agentCanApprove: boolean;
  authorityRow?: number;
  prepared?: { kind: "replacement" | "refund"; reference: string; lines: string[] };
  approval: { state: "not-ready" | "awaiting" | "approved"; by?: string; at?: number; via?: "call" | "panel"; evidence?: Evidence };
  /**
   * An earlier approval that doesn't cover this recommendation: given before what it needed was
   * known, or for a different outcome or order. Kept so the history shows it; a fresh approval is needed.
   */
  staleApproval?: {
    at: number;
    via: "call" | "panel";
    evidence?: Evidence;
    reason: string;
    /** Approval words that never counted (the line named the other outcome): not an approval to give "again". */
    refused?: boolean;
  };
  /**
   * The agent's line about this outcome, while it waits for approval, with no approval heard in it:
   * "offset a full refund…" for "I've set up a full refund…" (call 7). Never approves; the agent decides.
   */
  unheardApproval?: Evidence;
  /** The approval is on hold while a caller line that may change the choice is being checked. */
  suspended?: { at: number; via: "call" | "panel"; evidence: Evidence; reason: string; /** The line the held approval was heard in. */ heard?: Evidence };
  /**
   * A caller line that may change the choice is still being checked: nothing can be approved until it
   * settles, whether or not an approval was given (Call 11 review, I-22).
   */
  checkingChoice?: Evidence;
  /**
   * The caller's reply to the agent's read-back of a detail already verified is still being checked: it may reject the
   * read-back (his decision, 23 Oct 12:35), so nothing can be approved until it settles.
   */
  checkingIdentity?: Evidence;
  /** Every approval given for this call, in order: whether it counted, and why not. */
  history?: { at: number; via: "call" | "panel"; evidence?: Evidence; counted: boolean; reason?: string }[];
};

export type CopilotView = {
  callId: string | null;
  lineCount: number;
  intent: {
    /** "other": the agent heard a problem this SOP doesn't cover. */
    id: "damaged" | "order-status" | "other";
    label: string;
    category: string;
    sopId: string | null;
    certainty: "high" | "low";
    confidence: number;
    phrases: string[];
    evidence: Evidence[];
    /** "model" when only the local model could read the line (always low certainty); "agent" when the agent chose the issue. */
    source: "rules" | "model" | "agent";
  } | null;
  verification: {
    factors: Factor[];
    verified: boolean;
    verifiedAt?: Evidence;
    /** When verification was complete on the evidence the copilot had: a correction typed later verifies later. */
    verifiedKnownAt?: number;
    locked: boolean;
    attemptsLeft: number;
  };
  order: {
    state: "none" | "heard" | "matched" | "unmatched";
    /** Before verification only what was heard is shown, never order details. */
    heard?: { text: string; reading: string; method: MentionMethod; evidence: Evidence };
    match?: { order: OrderView; method: MentionMethod | "closest" | "only-recent"; note: string; needsConfirmation: boolean; confirmed: boolean; confirmedBy?: Evidence | "panel"; evidence?: Evidence; /** The Confirm press that counts, kept even once a read-back carries the confirmation (I-25). */ pressedAt?: number; readBack?: Evidence };
  };
  checks: Check[];
  choice: { value: Choice; evidence: Evidence } | null;
  recommendation: Recommendation | null;
  /** `rewordable`: the line has no amounts, outcomes, order facts or status, so the local model may reword it (I-21). */
  suggestedReply: { text: string; sopRef: string; basis: "rules"; rewordable: boolean } | null;
  alerts: Alert[];
  prompts: ConfirmPrompt[];
  steps: SopStep[];
  documentation: { label: string; value: string | null }[];
  /**
   * The key answer the copilot is waiting for: the caller's next line gets the second speech model's
   * check. "issue": no problem heard yet. On 11 Oct the small model cut the opening line off after
   * "order 427" and the damage sentence was lost; the second model heard all of it.
   */
  awaiting: "issue" | "name" | "address" | "choice" | null;
  /** `awaiting` comes from a name or address question lingering over hold lines ("One moment."), and lapses at this time. */
  awaitingUntil?: number;
  /**
   * Caller lines that answer a key question, judged in speech order: the problem (until one is heard),
   * the name, the address and the choice. Each gets the second model's check once, even when the
   * agent's question reached the console after the answer (the two sides are transcribed separately).
   */
  keyAnswers: string[];
  /**
   * Agent lines that may be the name read-back misheard: each is heard again by the second model once, without
   * being held back (see TranscriptEvent.reheard).
   */
  readBackChecks: string[];
  /**
   * Each agent line after the customer chose: whether it goes to the second speech model's check, and why
   * or why not (outside review 14 Oct, 5.6). Lines before the choice are never checked.
   */
  agentChecks: { key: string; check: boolean; reason: string }[];
  /** The agent's Confirm presses still in effect for the name, address and item: each can be undone. */
  undoable: ("name" | "address" | "order")[];
  /**
   * Where the agent types the caller's name: the caller's answer to the name question, from the moment its
   * line arrives (stage call, 21 Oct: about 10 s went on reaching a field that appeared only once both speech
   * models had finished). `checking`: the second model is still checking the line. `readBack`: whether saying
   * the name back counts ("waiting": said back, waiting for the caller's yes; "expired": no reply within
   * READ_BACK_REPLY_MS; "refused": the caller's reply wasn't a clear, checked yes, so read-back is over for this call).
   * Null once the name is verified.
   */
  nameEntry: {
    key: string;
    checking: boolean;
    readBack: ReadBackState;
    /** While waiting: epoch ms after which the caller's yes no longer counts (the field shows the expiry itself). */
    readBackUntil?: number;
    /** After a refusal: ask for the full name again, or type the name (only for a yes the system couldn't confirm). */
    readBackRecovery?: "ask" | "type";
    /** The caller only asked to hear the read-back again ("Sorry?"): the same read-back may be said once more. */
    readBackRepeat?: true;
    /** While waiting: the second model is hearing the agent's line again in case it was the read-back, either the
     * agent's last line or an earlier one the agent has said something after. */
    readBackProbe?: "last" | "earlier";
  } | null;
  /**
   * Where the agent types the caller's street and city, the same way as the name: from the moment the caller's
   * answer to the address question arrives, while the second speech model still checks it (22 Oct call: about
   * 20 s went on the address, typed into a card that came only after both models had heard it wrong). Shown once
   * the name is verified; null once the address is. Typed words are checked against the order as before.
   */
  /** When the earliest read-back still waiting for a reply runs out, whether or not its field is shown: the store looks again then. */
  readBackUntil?: number;
  addressEntry: {
    key: string;
    checking: boolean;
    /** Only when the build allows the address read-back (Policy.addressReadBack): the same states as the name's. */
    readBack?: ReadBackState;
    readBackUntil?: number;
    readBackRecovery?: "ask" | "type";
    readBackRepeat?: true;
  } | null;
};

/**
 * Whether saying a detail back counts: "waiting": said back, waiting for the caller's yes; "expired": no reply within
 * READ_BACK_REPLY_MS; "refused": the caller's reply wasn't a clear, checked yes, so read-back is over for this call.
 */
export type ReadBackState = "off" | "available" | "waiting" | "expired" | "refused";

const DAY = 86_400_000;

const evidenceOf = (l: TranscriptEvent): Evidence => ({
  key: l.key,
  seq: l.seq,
  side: l.side,
  text: l.text,
  at: l.startedAt,
  // Typed words count from when they were typed: a check result that lands later can't move that (review, 22 Oct).
  knownAt: l.typedAt !== undefined ? Math.max(l.typedAt, l.endedAt) : (l.availableAt ?? l.endedAt),
  lowConfidence: (l.confidence !== null && l.confidence < LOW_CONFIDENCE) || !!l.checkFailed,
  typedFrom: l.typedFrom,
  firstHeard: l.firstHeard,
});

/**
 * The two speech models heard different answers ("Sen bilir." then "Send me." for "Sam Miller" on
 * 11 Oct): a recognition problem, not the caller's wrong answer. Only the words that carry the answer
 * are compared, so "My name is Sam Miller" and "My name is John Smith" disagree, and so do "Hill Road
 * in Dallas" and "Hill Road in Boston". Words that only sound alike ("Jon", "John") agree.
 */
const modelsDisagree = (ev: Evidence) => {
  if (ev.firstHeard === undefined || ev.typedFrom !== undefined) return false;
  const answer = (text: string) => textWords(text).filter((w) => !isFiller(w));
  const [first, checked] = [answer(ev.firstHeard), answer(ev.text)];
  const within = (xs: string[], ys: string[]) => xs.every((x) => ys.some((y) => soundsLike(x, y) || soundsLike(y, x)));
  return !(within(first, checked) && within(checked, first));
};

/**
 * Only an acknowledgement ("Checked", "Confirmed", "OK"), not the caller's words. On the 11 Oct
 * call the agent typed "Checked" into the name field; it must never stand in for an answer.
 */
export const isAcknowledgement = (text: string) => {
  const w = textWords(text);
  return w.length > 0 && w.every((t) => /^(checked|check|confirmed|confirm|ok|okay|yes|yeah|yep|correct|right|done|verified|matched|match|fine|good|same)$/.test(t));
};

/**
 * The agent's typed corrections, applied to the caller lines they replace. What the agent
 * typed is clear text: it is never low confidence, and it is judged word for word.
 */
function applyCorrections(lines: TranscriptEvent[], actions: AgentAction[]): TranscriptEvent[] {
  const typed = new Map<string, { text: string; at: number }>();
  for (const a of actions) if (a.type === "correct" && a.text.trim() && !isAcknowledgement(a.text)) typed.set(a.key, { text: a.text.trim(), at: a.at });
  if (!typed.size) return lines;
  return lines.map((l) => {
    const t = l.side === "caller" ? typed.get(l.key) : undefined;
    // The line keeps its place in the conversation, but the typed words only count from when they were typed.
    return t === undefined ? l : { ...l, text: t.text, typedFrom: l.text, typedAt: t.at, confidence: null, checking: false, checkFailed: false };
  });
}

/** A Confirm press the agent took back: when it was pressed and when it was undone. */
type Undone = { target: "name" | "address" | "order"; confirmedAt: number; undoneAt: number };

/**
 * Each undo removes the agent's latest earlier Confirm press for that target that is still standing.
 * An undo with nothing to take back does nothing.
 */
function applyUndos(actions: AgentAction[]): { kept: AgentAction[]; undone: Undone[] } {
  const removed = new Set<AgentAction>();
  const undone: Undone[] = [];
  const byTime = [...actions].sort((a, b) => a.at - b.at);
  for (const u of byTime) {
    if (u.type !== "undo") continue;
    const press = byTime.filter((a) => a.type === "confirm" && a.target === u.target && a.at <= u.at && !removed.has(a)).pop();
    if (!press) continue;
    removed.add(press);
    undone.push({ target: u.target, confirmedAt: press.at, undoneAt: u.at });
  }
  return { kept: actions.filter((a) => a.type !== "undo" && !removed.has(a)), undone };
}

export function orderView(order: Order, now: number): OrderView {
  const d = order.deliveredDaysAgo;
  const deliveredLabel = d === null ? "Not delivered yet" : d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
  const deliveredDate = d === null ? null : new Date(now - d * DAY).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return { ...order, deliveredLabel, deliveredDate };
}

export const bandFor = (bands: AuthorityBand[], amount: number) => bands.find((b) => b.upTo === null || amount <= b.upTo) ?? bands[bands.length - 1];

const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
/**
 * Clock time with seconds, so each record entry can be found in the recording (I-28). A line is always
 * shown at its start; an approval heard on the call at the start of its line, though it counts from the end.
 */
const clock = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** How a factor was verified, as a step detail: "Confirmed by the agent", not "By confirmed by the agent" (I-27). */
const byMethod = (method: string) => (/^(confirmed|typed|name read back) by/.test(method) ? method[0].toUpperCase() + method.slice(1) : `By ${method}`);

/** What the optional local model read in lines the rules could not. It never ticks a step. */
export type ModelHints = { intent?: { id: "damaged" | "order-status"; key: string } };

const DAMAGED_LABEL = "Order issue: damaged on arrival";

const DAMAGE_WORD = /\b(damage[ds]?|cracked|crack|broken|scratched|shattered|smashed|dented)\b/i;

/**
 * What the agent's damage question asks, if the line has one. Recognition drops question marks, so a
 * sentence starting with a question word counts as well.
 * - "arrival": whether it arrived damaged ("Did the tablet arrive damaged?"). A yes establishes it.
 * - "extent": where or how bad ("Is the damage only on the screen?"). A yes confirms damage the caller
 *   described; on its own it doesn't say the item arrived that way.
 * A question about a photo, or a negated one ("Is the screen not damaged?"), confirms nothing.
 */
function damageQuestion(text: string): "arrival" | "extent" | null {
  for (const sentence of text.split(/(?<=[.?!])\s+/)) {
    if (!DAMAGE_WORD.test(sentence)) continue;
    const question = /\?\s*$/.test(sentence) || /^(so |and |just to confirm,? )?(is|was|are|were|did|does|do|has|have|can you|could you)\b/i.test(sentence.trim());
    if (!question || /\b(photo|photos|picture|pictures|pic|image|images)\b/i.test(sentence) || /\b(not|never|no)\b|n't\b/i.test(sentence)) continue;
    return /\b(arriv\w*|came|come|deliver\w*|receiv\w*|out of the box|opened)\b/i.test(sentence) ? "arrival" : "extent";
  }
  return null;
}

/** A plain yes ("Yes, only the screen."): nothing in the answer denies or qualifies it ("Yes, but it is not damaged."). */
const saysYes = (text: string) =>
  /^(yes|yeah|yep|yup|correct|that's right|that is right|right|exactly|it is|it was|it did)\b/i.test(text.trim()) &&
  !/\b(not|no|never|but|although|though|except)\b|n't\b/i.test(text.replace(/^\W*\w+/, ""));

/** How a name verified by read-back is labelled: never as recognition of the caller's own words (his wording, 22 Oct). */
export const NAME_READ_BACK = "name read back by agent, confirmed by caller";

/** Words that may lead into a read-back ("Okay, thank you. Just to confirm, that's …"): none of them asks anything else. */
const READ_BACK_LEAD = new Set(
  "okay ok alright all right great perfect thanks thank you so and just to confirm let me confirming that's that is it's it i have i've got heard said your name full the you're are mr mrs ms miss mister".split(" ")
);
/** The question that follows the name; "" when the name itself is asked ("Is that Sam Miller?", "…Sam Miller?"). */
const READ_BACK_TAGS = new Set(["", "is that right", "is that correct", "is that your full name", "did i get that right", "have i got that right", "right", "correct"]);

/**
 * The agent says the caller's full name back as one question and nothing else: "That's Sam Miller, is that right?".
 * Every word of the record's name, in order and word for word; no sound-alike counts, because the point is the agent's
 * clean mic, not the caller's phone audio. Only lead-in words before it and only the confirming question after it, so
 * a yes can't be answering another question ("Is it only the screen, Sam Miller?"). Recognition drops question marks,
 * so a tag question or "Is that …" counts without one. A negated line never counts.
 */
const readsBackName = (text: string, customer: Customer) => {
  if (/\b(not|no|never)\b|n't\b/i.test(text)) return false;
  const said = textWords(text);
  const name = textWords(customer.name);
  const at = said.findIndex((_, i) => name.every((w, j) => said[i + j] === w));
  if (at < 0) return false;
  const before = said.slice(0, at);
  const after = said.slice(at + name.length).join(" ");
  const found = text.search(new RegExp(name.map((w) => w.replace(/[^a-z0-9]/g, "\\W*")).join("\\W+"), "i"));
  if (found < 0 || /\?/.test(text.slice(0, found)) || !before.every((w) => READ_BACK_LEAD.has(w)) || !READ_BACK_TAGS.has(after)) return false;
  return after !== "" || /\?/.test(text.slice(found)) || before[0] === "is";
};

/** How an address verified by read-back is labelled: the same as the name (his yes, 23 Oct). */
export const ADDRESS_READ_BACK = "address read back by agent, confirmed by caller";
/** Lead-in words for the address read-back too ("So the delivery address is …"): none of them asks anything else. */
const ADDRESS_LEAD = new Set([...READ_BACK_LEAD, ..."address delivery deliver delivering ship shipping street city and to for in at on we we're".split(" ")]);
const ADDRESS_TAGS = new Set([...READ_BACK_TAGS, "is that your address", "is that the right address", "is that the address"]);
const STATE_SPOKEN: Record<string, string[]> = { tx: ["texas"], ca: ["california"], ny: ["new", "york"], fl: ["florida"] };

/**
 * The agent says the caller's street and city back as one question and nothing else: "So that's Hill Road, Dallas, is
 * that right?". Every word of the order's street, then "in" or nothing, then every word of its city, word for word, then
 * the state if said; the same lead-in and tag rules as the name read-back. No sound-alike counts.
 */
const readsBackAddress = (text: string, customer: Customer) => {
  if (/\b(not|no|never)\b|n't\b/i.test(text)) return false;
  const said = textWords(text);
  const street = textWords(customer.address.street);
  const city = textWords(customer.address.city);
  const at = said.findIndex((_, i) => street.length > 0 && street.every((w, j) => said[i + j] === w));
  if (at < 0) return false;
  let i = at + street.length;
  if (said[i] === "in") i++;
  if (!city.length || !city.every((w, j) => said[i + j] === w)) return false;
  i += city.length;
  const state = textWords(customer.address.state);
  for (const form of [state, ...state.map((w) => STATE_SPOKEN[w] ?? [])]) {
    if (form.length && form.every((w, j) => said[i + j] === w)) {
      i += form.length;
      break;
    }
  }
  const before = said.slice(0, at);
  const after = said.slice(i).join(" ");
  const found = text.search(new RegExp(street.map((w) => w.replace(/[^a-z0-9]/g, "\\W*")).join("\\W+"), "i"));
  if (found < 0 || /\?/.test(text.slice(0, found)) || !before.every((w) => ADDRESS_LEAD.has(w)) || !ADDRESS_TAGS.has(after)) return false;
  return after !== "" || /\?/.test(text.slice(found)) || before[0] === "is";
};

/** A reply that only asks to hear it again ("Sorry?", "Pardon?", "Can you say that again?"), and nothing else. */
/**
 * A reply that only asks to hear the read-back again, as a whole phrase: "Sorry?", "Pardon?", "Can you say that again?",
 * "I didn't catch that." Matched against a short list of phrases, not a bag of words, so "Sorry, I didn't say that." (a
 * dispute) isn't one (review, 23 Oct).
 */
const AGAIN_POLITE = new Set("please sir madam ma'am".split(" "));
const AGAIN_PHRASE = new RegExp(
  "^(?:(?:i'm )?sorry|pardon(?: me)?|excuse me|what|huh)?\\s*" +
    "(?:(?:can|could|would) you (?:say|repeat) (?:that|it)(?: again)?(?: one more time)?|(?:say|repeat) (?:that|it)(?: again)?(?: one more time)?|" +
    "come again|one more time|i didn't (?:catch|hear) (?:that|it|you)|what was that|what did you say)?$"
);
const saysAgain = (text: string) => {
  const said = textWords(text).filter((w) => !AGAIN_POLITE.has(w)).join(" ");
  return said.length > 0 && AGAIN_PHRASE.test(said);
};

const STREET_TYPE_WORDS = new Set("road rd street st avenue ave drive dr lane ln".split(" "));
const READ_BACK_TAGS_LONGEST = [...READ_BACK_TAGS].filter((t) => t).sort((a, b) => b.split(" ").length - a.split(" ").length);
/** Everyday words a misheard name doesn't come out as only: "Sorry?", "Are you still there?", "And your first name?". */
const NOT_A_NAME = new Set(
  "sorry pardon excuse me hello hi hey there still here hear can could would will you repeat say said again what what's was were that this with a an of for first last second surname spell spelling name names please one moment minute bear wait hold on check checking yes no okay ok thanks thank how do does is are am".split(" ")
);
/** A capitalised word inside a sentence, as recognition writes a name ("So it's Samuel Wright."); "I" doesn't count. */
const namesSomeone = (text: string) =>
  [...text.matchAll(/\p{Lu}[\p{L}'’-]*/gu)].some((m) => m[0] !== "I" && !/^I['’]/.test(m[0]) && !/(^|[.!?]\s*)$/.test(text.slice(0, m.index)));
/**
 * An agent line that could be the name read-back misheard (23 Oct: "So it's Samuel Wright." for "So it's Sam Miller,
 * right?"): read-back lead-in words, one to four other words, and a question, a confirming tag or a name-like word.
 * "Great, thank you.", "One moment, please." or "Sorry?" isn't, and neither is a negated line. It only decides which lines are
 * heard again; what counts as a read-back is still readsBackName, on what the second model heard.
 */
const shapedLikeReadBack = (text: string) => {
  if (/\b(not|no|never)\b|n't\b/i.test(text)) return false;
  let w = textWords(text);
  while (w.length && READ_BACK_LEAD.has(w[0])) w = w.slice(1);
  const tag = READ_BACK_TAGS_LONGEST.find((t) => w.slice(-t.split(" ").length).join(" ") === t);
  if (tag) w = w.slice(0, -tag.split(" ").length);
  if (w.every((x) => NOT_A_NAME.has(x) || x.length === 1)) return false;
  return w.length >= 1 && w.length <= 4 && (!!tag || /\?/.test(text) || namesSomeone(text));
};

/**
 * An agent line that only holds or acknowledges ("One moment.", "Okay.", "Thank you.", "Let me
 * check that."): no question mark and every word from a short list, so it asks nothing, names nobody and moves to no
 * other topic. The identity question it follows stays open through it, for LINGER_MS.
 */
const HOLD_WORDS = new Set(
  "okay ok alright all great perfect sure thanks thank you one moment minute second sec please just a bit bear with me hold on let check checking see got it sorry mhm uh um hmm so and while i pull look that up".split(" ")
);
const onlyHolds = (text: string) => {
  const w = textWords(text);
  return !/\?/.test(text) && w.length > 0 && w.every((x) => HOLD_WORDS.has(x));
};
export const LINGER_MS = 10_000;

/** A reply that is a plain yes and nothing more ("Yes, that's right, thank you."): a correction, a "yes, but", a question back or anything else isn't. */
const CONFIRM_START = /^(yes|yeah|yep|yup|correct|exactly|absolutely|right|that's (right|correct|it|me)|that is (right|correct|it|me))\b/;
const CONFIRM_WORDS = new Set("yes yeah yep yup correct right exactly absolutely that's that is it it's me thank thanks you please sir madam ma'am indeed".split(" "));
/** Thanks and nothing more ("Great, thank you so much."): after a plain yes, it doesn't change the reply. */
const THANKS_WORDS = new Set("great perfect lovely brilliant wonderful awesome cheers thanks thank you so much very appreciate it that's thats good fine alright cool ok okay".split(" "));
const thanksOnly = (text: string) => {
  const w = textWords(text);
  return !/\?/.test(text) && w.length > 0 && w.some((x) => x === "thanks" || x === "thank" || x === "cheers" || x === "appreciate") && w.every((x) => THANKS_WORDS.has(x));
};
const confirmsOnly = (text: string) => {
  const w = textWords(text);
  return !/\?/.test(text) && w.length > 0 && CONFIRM_START.test(w.join(" ")) && w.every((x) => CONFIRM_WORDS.has(x));
};
/**
 * The record's full name word for word, once, with nothing else but confirming words ("It's Sam Miller.", "Sam Miller,
 * that's right."): his decision of 23 Oct 12:35 ("Count it") lets the caller's yes to the name read-back say the name too.
 */
const NAME_YES_WORDS = new Set([...CONFIRM_WORDS, ..."my name is i'm im this speaking".split(" ")]);
const saysExactName = (text: string, name: string[]) => {
  const w = textWords(text);
  const at = w.findIndex((_, i) => name.every((n, j) => w[i + j] === n));
  return !/\?/.test(text) && at >= 0 && [...w.slice(0, at), ...w.slice(at + name.length)].every((x) => NAME_YES_WORDS.has(x));
};
/** A yes that also says the record's full name, exactly the name the read-back said: "Yes, Sam Miller.", "Yes, that's Sam Miller, thank you." */
const yesWithName = (text: string, name: string[]) => CONFIRM_START.test(textWords(text).join(" ")) && saysExactName(text, name);

/**
 * The caller rejects or corrects the agent's read-back of a detail (his decision, 23 Oct 12:35), judged on the whole
 * reply, sentence by sentence, after sounds and softeners ("Um,", "Oh, sorry,", "Hang on,", "I'm afraid") are set aside.
 * One that starts with a rejection is one ("No.", "Sorry, no.", "Not quite, it's Millar.", "You've got it wrong.", "No, we
 * moved."), unless the no is said for yes ("No, that's fine, thanks.", "Nope, that's right."). One that starts with a yes
 * is one only when it also corrects this detail: another name or place ("Yes. Hang on, no, it's Millar."), someone else's
 * ("That's my husband's name.") or an old one ("That's my old one."), a no next to the record's own words ("Not Sam,
 * Pam."), a word about the read-back being wrong ("Yes. Not quite."), a spelling ("It's with an A."), or a bare no in a
 * later sentence ("Yes. Hmm, no."). A no about something else after a yes isn't ("Yes, but the box isn't here.", "Mm-hmm,
 * Dallas, not Fort Worth."), nor are everyday phrases ("No problem."), backchannels ("Mm-hmm.") or a "No" about something
 * else followed by a yes ("No." then "And yes, that's me.") (independent reviews, 23 Oct).
 */
const REJECT_HEAD =
  /^(no|nope|nah|not|wrong|incorrect|close|almost|nearly|that's (not|wrong|incorrect|my old)|that is (not|wrong|incorrect|my old)|that isn't|that was (not|wrong|my old)|that wasn't|it's not|it is not|it isn't|(you've|you have|you) got (it |that |the |my )?wrong|you have (the |my )?wrong|uh uh|mm mm|nuh uh|negative|that's a negative|afraid not|fraid not|(definitely|absolutely|certainly|of course|hell) (not|no)\b|god no|(i )?(don't|do not) think so|no way|(yeah|yes) no$)\b/;
const YES_HEAD =
  /^(yes|yeah|yep|yup|yah|correct|exactly|absolutely|definitely|indeed|right|sure|okay|ok|alright|all right|mm hmm|uh huh|mhm|speaking|spot on|perfect|that's (right|correct|it|me|true|the one)|that is (right|correct|it|me|true|the one)|it is|it's me|you got it)\b/;
/** A no said for yes: "No, that's fine, thanks.", "No, no, that's right.", "Nope, all good." */
const NO_FOR_YES =
  /^(no|nope|nah)( no)* ((that's|that is|it's|it is|you're|you are) )?((all )?(right|correct|fine|good|me|it|perfect|okay|ok|alright|spot on)|(you've|you have|you) got it( right)?|you're right)(( thanks| thank you| very much| cheers| go ahead| please| carry on))*$/;
/** Also "No, that's exactly right.", "No, yeah, that's right.", "No no, that's me, Sam Miller.": a yes after the no, and no other no. */
const noForYes = (x: string) => {
  if (NO_FOR_YES.test(x)) return true;
  const m = /^(no|nope|nah)( no)* /.exec(x);
  if (!m) return false;
  const rest = x.slice(m[0].length).replace(/^(yeah|yes|yep) /, "");
  const yes = /^((that's|that is|it's|it is) (absolutely |exactly |quite |totally |all |just )?(right|correct|fine|good|great|perfect|me|it|the one|spot on)|(yeah|yes|yep))\b/.exec(rest);
  return !!yes && !NEGATION.test(rest.slice(yes[0].length));
};
const BARE_NO = /^(no|nope|nah)( (no|nope|wait|sorry|hang on|hold on|actually))*$/;
const EVERYDAY_NO = /\b(no (problem|problems|worries|bother|rush|hurry|need|doubt)|not a problem)\b/g;
/** Sounds and softeners before the answer itself. "Mm-hmm" and "Uh-huh" are answers, so they stay. */
const LEAD = /^(um|uh|er|erm|oh|ah|well|hmm|hm|mm|so|sorry|actually|look|listen|hang on|hold on|wait|i'm afraid|i am afraid)( |$)/;
const NEGATION = /\b(no|not|nope|wrong|incorrect|isn't|wasn't|never)\b/;
/** The read-back itself called wrong: "not quite", "that's not right", "you got my name wrong", "the address is wrong". */
const REFERS_BACK =
  /\b((that's|that is|it's|it is|that was|it was) not|that isn't|it isn't|that wasn't|not) (right|correct|quite|exactly|it|me|mine|true|my (name|address)|the right (one|name|address))\b|\b(that's|that is|it's|it is|that was|it was) (wrong|incorrect)\b|\bgot (it|that|me|my name|the name|my address|the address) wrong\b|\bwrong (name|address|person|one|surname|street|city)\b|\b(name|surname|address|street|city|spelling|that|it|this|one) (is|was) (wrong|incorrect)\b|\b(that's|that is|it's|it is) not$|\b(it|that) (isn't|wasn't|is not|was not)$/;
/**
 * After a yes, the read-back called wrong only where a sentence (or the rest of the yes) starts with it: "Yes. Not quite.",
 * "Yeah. Wait, no, it's not.". "Yes. The screen's not right." or "Yes. Not quite sure what happened." is about something
 * else (third check, 23 Oct).
 */
const REFERS_BACK_START =
  /^((that's|that is|it's|it is|that was) not|that isn't|it isn't|that wasn't|not) (right|correct|quite|exactly|it|me|mine|true|my (name|address))\b(?! (sure|happy|certain|clear|what|how|when|why|who|the|about|that|with|to|for|in|on|at))|^(that's|that is|it's|it is) (wrong|incorrect)\b|^(that's|that is|it's|it is) not$|^(it|that) (isn't|wasn't|is not|was not)$|^(you've|you have|you) got (it|that|me|my name|the name|my address|the address) wrong\b|^wrong (name|address|person|surname|street|city)\b/;
const RELATIVE = "husband|wife|partner|dad|father|mum|mom|mother|parents|son|daughter|brother|sister|boss|friend|colleague|flatmate|roommate|grandma|gran|nan|grandmother|grandfather|granddad|aunt|uncle|in laws";
/** The name read back belongs to someone else: "That's my husband.", "I'm Sam's mum.", "That was my maiden name.", "Not me." */
const SOMEONE_ELSE = new RegExp(
  `\\b(that's|that is|it's|it is|that was|it was|he's|she's|you mean|no) (my|his|her|our|their) (${RELATIVE}|ex)\\b|\\b(my|his|her|our|their) (${RELATIVE})'s name\\b|\\bi'm (his|her|their|[a-z]+'s) (${RELATIVE})\\b|\\b(isn't|is not|not|wasn't) me\\b(?! (who|that|personally|but|though))|\\bnot (my|our) name\\b|\\b(maiden|old|previous) name\\b|\\bcalling (for|on behalf of) (him|her|them)\\b|\\b(that'd be|that would be|you're thinking of|you are thinking of|you mean|you want) (my|his|her|our|their) (${RELATIVE})\\b|\\b(i'm|i am) not (him|her|them)\\b|\\bain't me\\b|\\bnever heard of (him|her|them|that name|that person)\\b`,
);
/** The address read back is an old one or someone else's: "We moved.", "That's my old one.", "We don't live there anymore." */
const PLACE_GONE = new RegExp(
  `(?<!(not|never|haven't|hasn't|havent|hasnt|didn't|didnt|we've not|i've not) )\\bmoved\\b(?! (in|here|from)\\b)|\\b(that's|that is|it's|it is|that was|it was|this is) (just )?(my |our |the |an |a |his |her |their )?(old|previous|work|office|business) (address|one|house|place|flat|home|apartment)\\b|\\b(my|our) (old|previous) (address|house|place|flat|home|apartment)\\b(?! is still)|\\bthat (was|is) (years|ages|a while|a long time) ago\\b|\\b(not anymore|not any more|no longer|used to (live|be)|(don't|doesn't|do not|does not) live there|not there anymore)\\b|\\b(my|his|her|our|their) (${RELATIVE})('s)? (place|house|flat|home|address|apartment)\\b`,
);
/** Street types are too general to show the caller saying no to the record's own words ("there's no road sign"). */
const STREET_TYPES = new Set("road rd street st avenue ave drive dr lane ln way boulevard blvd court ct place pl".split(" "));
const NOT_ANOTHER = new Set([...CONFIRM_WORDS, ...COMMON, ..."no nah not wrong incorrect close almost actually wait i i'm i'll i'd name address street road avenue drive lane city".split(" ")]);
/** Words that introduce another name or place: "it's Millar", "no, Tom Baker", "but it's Elm Road", "we're on Elm Road now". */
const INTRODUCES =
  /(?:^|[^\p{L}'])(?:my name is|my name's|name is|name's|(?:sur|last |first )name is|(?:sur|last |first )name's|it's|its|it is|this is|i'm|i am|sorry|actually|no|nope|wait|but|meant|mean|close|almost|(?:we're|we are|i'm|i am|live|living|we live|i live)(?: actually| now| still)? (?:at|on|in)|moved to|now at|now on|now in)[\s,]*$/u;

/**
 * Timestamps can put the start of a reply slightly before the end of the question; up to this much is tolerated. A yes
 * that starts earlier is speech overlapping the question, not an answer to it.
 */
export const READ_BACK_OVERLAP_MS = 250;
/** A reply that starts this long after the read-back ended isn't taken as its answer; the field shows the wait ending. */
export const READ_BACK_REPLY_MS = 8000;
/**
 * Read-backs that can count per detail per call (outside review, Amendment 7): the first, and one more, whether it
 * follows "Sorry?" or silence. Asking again doesn't reset it; a reply that isn't a plain yes still ends it at once.
 */
export const READ_BACKS_PER_DETAIL = 2;

/** Refusals where the caller did say a plain yes and only the system couldn't confirm it: typing the name is allowed. */
const NOT_CHECKED = "the second speech model didn't finish checking it";
const UNCLEAR = "it was unclear";

/**
 * Why the caller's next line after a read-back doesn't confirm it, or null when it does: a plain yes and nothing else,
 * started after the question ended, checked by the second speech model with both models hearing a yes, and heard
 * clearly. "No", corrections, "yes, but…", unclear speech and a yes to anything else never verify the name.
 */
function whyNotConfirmed(line: TranscriptEvent, ev: Evidence, askedEnd: number, nameYes?: { exact: (t: string) => boolean; heard: (t: string) => boolean }): string | null {
  if (line.typedFrom !== undefined) return "the agent typed over it";
  if (line.startedAt < askedEnd - READ_BACK_OVERLAP_MS) return "it started before the question ended";
  if (line.startedAt > askedEnd + READ_BACK_REPLY_MS) return "it came too long after the question";
  // For the name, a yes with the exact full name in it counts too (his decision, 23 Oct 12:35); the fast model must have
  // heard a yes as well, with nothing in it but that yes and the name, however it heard the name.
  if (!confirmsOnly(line.text) && !nameYes?.exact(line.text)) return "it isn't a plain yes";
  if (line.checkFailed || !line.checked) return NOT_CHECKED;
  if (line.firstHeard !== undefined && !confirmsOnly(line.firstHeard) && !nameYes?.heard(line.firstHeard)) return `the fast model heard "${line.firstHeard}"`;
  if (ev.lowConfidence) return UNCLEAR;
  return null;
}

/** The caller says they or someone else damaged it after it arrived: not damage on arrival. */
const CAUSED_AFTER =
  /\b((i|we|he|she|they|my (son|daughter|kid|kids|child|dog|cat|husband|wife|brother|sister)) (accidentally |just )?(dropped|broke|sat on|stepped on|knocked)( it)?|dropped it|it fell|fell off|fell on)\b/i;

/** The rules in one pass over the call. `now` fixes "delivered yesterday" and approval times for tests. */
export function analyze(pack: ClientPack, lines: TranscriptEvent[], actions: AgentAction[] = [], now = Date.now(), hints: ModelHints = {}): CopilotView {
  return rules(pack, lines, actions, now, hints, false);
}

/** Why an approval given when the copilot showed `then` doesn't cover the current outcome. */
function notCovered(then: CopilotView, kind: "replacement" | "refund", orderId: string): string {
  const r = then.recommendation;
  if (!then.verification.verified) return "identity wasn't verified yet";
  if (!then.order.match) return "the order wasn't found yet";
  if (then.order.match.order.id !== orderId) return `it was for order ${then.order.match.order.id}`;
  if (!(then.intent?.id === "damaged" && then.intent.certainty === "high")) return "the damage wasn't established yet";
  if (!then.choice || then.choice.value === "both") return "the customer's choice wasn't known yet";
  if (r?.prepared && r.prepared.kind !== kind) return `it was for a ${r.prepared.kind}`;
  if (!r?.prepared) return then.order.match.confirmed ? "the customer's choice wasn't known yet" : "the item wasn't confirmed with the caller yet";
  return "the outcome has changed since";
}

/** Why an approval doesn't count when identity was verified only after it. */
const IDENTITY_LATER = "identity wasn't verified when it was given, or the check it relied on didn't hold; it was verified only after it";

/** An approval as given: by the agent's commitment on the call, or in the panel. */
type GivenApproval = { at: number; via: "call" | "panel"; evidence?: Evidence };
/** Approval words in a line that named the other outcome: never counted, but kept in the history. */
type RefusedApproval = GivenApproval & { reason: string };
/** The approvals each pass heard, so a later pass can find the ones an undo took away. */
const givenIn = new WeakMap<CopilotView, GivenApproval[]>();

/**
 * The lines as the copilot had them at `at`, for a pass that rebuilds that moment: a line that hadn't arrived is left
 * out, one whose held check finished later was still being checked (with what the fast model heard), and one held only
 * later was then plainly heard. A line held from its arrival used to drop out of these passes altogether, so a Confirm
 * press the panel was still holding for it counted there (third review, 23 Oct). `before`: strictly before `at`.
 */
function asOf(lines: TranscriptEvent[], at: number, before = false): TranscriptEvent[] {
  const by = (t: number) => (before ? t < at : t <= at);
  return lines.flatMap((l): TranscriptEvent[] => {
    const usable = l.availableAt ?? l.endedAt;
    if (!by(l.first?.at ?? usable)) return [];
    const held = l.heldAt !== undefined && by(l.heldAt);
    if (by(usable)) return [l.checking && l.heldAt !== undefined && !held ? { ...l, checking: undefined } : l];
    const first = l.first ?? { text: l.firstHeard ?? l.text, confidence: l.confidence, at: usable };
    return [{ ...l, text: first.text, confidence: first.confidence, availableAt: first.at, firstHeard: undefined, checked: undefined, checkFailed: undefined, checking: held || undefined }];
  });
}

/**
 * `past`: this pass rebuilds what the copilot knew at an earlier moment, to check an approval given
 * then. It only needs the recommendation, so it doesn't look at approvals itself.
 */
function rules(pack: ClientPack, input: TranscriptEvent[], allActions: AgentAction[], now: number, hints: ModelHints, past: boolean): CopilotView {
  // An agent line heard again as a possible read-back, as the copilot knew it at `now`: plainly heard before that check
  // started, still being heard again until it finished.
  const lines = input.map((l) =>
    l.probedAt !== undefined && l.probedAt > now
      ? { ...l, probing: undefined, reheard: undefined }
      : l.reheard && l.reheard.at > now
        ? { ...l, reheard: undefined, probing: true }
        : l
  );
  const { kept: actions, undone } = applyUndos(allActions);
  const sopId = pack.sop.id;
  const ref = (section: string) => `${sopId} · ${section}`;
  const customer: Customer = pack.customers.find((c) => c.id === pack.callerCustomerId)!;
  const customerOrders = pack.orders.filter((o) => o.customerId === customer.id);
  const idLengths = [...new Set(pack.orders.map((o) => o.id.length))];
  const firstName = customer.name.split(" ")[0];
  // A reply to a refused read-back is heard as a name answer only when it says part of the name, even by sound
  // ("No, it's Sam Millar."). A no, a "yes, but…" or a question back is never a failed attempt.
  const nameParts = textWords(customer.name);
  const saysNamePart = (text: string) =>
    textWords(text)
      .map((w) => w.replace(/'s$/, ""))
      .some((w) => !isFiller(w) && nameParts.some((p) => soundsLike(w, p)));
  // His decision of 23 Oct 12:35 ("Count it"): the caller's yes to the name read-back may say the name too, the record's
  // full name word for word as the second model heard it (yesWithName). The fast model only has to hear a yes, and words
  // that sound like the name, and nothing else.
  /** As the fast model heard it: words that sound like every part of the name, and nothing else but yes words. */
  const fastHeardName = (t: string) => {
    const rest = textWords(t).filter((x) => !NAME_YES_WORDS.has(x));
    return (
      !/\?/.test(t) &&
      rest.length === nameParts.length &&
      rest.every((x) => !isFiller(x) && nameParts.some((p) => soundsLike(x, p))) &&
      nameParts.every((p) => rest.some((x) => soundsLike(x, p))) &&
      !namesAnother(t, customer)
    );
  };
  const nameYes = {
    exact: (t: string) => yesWithName(t, nameParts),
    heard: (t: string) => CONFIRM_START.test(textWords(t).join(" ")) && fastHeardName(t),
  };

  // Speech order, not arrival order: the two sides are recognised separately. A line still
  // being checked by the second speech model is left out until its checked text arrives.
  const corrected = applyCorrections(lines, actions);
  const ordered = corrected
    .filter((l) => !l.checking)
    .sort((a, b) => a.startedAt - b.startedAt || a.seq - b.seq);
  const timeline: ({ kind: "line"; at: number; line: TranscriptEvent } | { kind: "action"; at: number; action: AgentAction })[] = [
    ...ordered.map((line) => ({ kind: "line" as const, at: line.startedAt, line })),
    ...actions.map((action) => ({ kind: "action" as const, at: action.at, action })),
  ].sort((a, b) => a.at - b.at);

  let intent: CopilotView["intent"] = null;
  const name: Factor = { id: "name", label: "Full name", state: "idle", attempts: 0 };
  const address: Factor = { id: "address", label: "Email, or street and city", state: "idle", attempts: 0 };
  let verifiedAt: Evidence | undefined;
  let locked = false;
  let expecting: "name" | "address" | "order" | null = null;
  // The name or address question carried over agent lines that only held or acknowledged, until this time.
  let lingerUntil: number | null = null;
  // The agent's latest question for the name, and their read-back of it still waiting for the caller's answer.
  let nameAsk: Evidence | null = null;
  // The agent's latest question for the street and city (or email).
  let addressAsk: Evidence | null = null;
  // When the agent's next question, or a name read-back, took over from each question: until then the typing field
  // stays on the caller's answer while the agent says anything else ("Thank you, one moment"), and keeps what was typed.
  let nameAskEnds = Infinity;
  let addressAskEnds = Infinity;
  // The agent's read-back waiting for the caller's reply, and the reply that ended read-back for this call.
  let readBack: { ev: Evidence; endedAt: number } | null = null;
  let readBackRefused: { ev: Evidence; why: string; recovery: "ask" | "type" } | null = null;
  // Everything the caller says before the agent's next line is one reply to the read-back (review, 22 Oct: "Yes." then
  // "But no, that's not right." as two lines). `held`: part of it is still being checked, so nothing is decided yet.
  let replyOpen = false;
  let readBackHeld = false;
  // The read-back expired with no reply: until the agent speaks again, the caller's lines are heard as while the question
  // lingers, so "Hello?" or "Sorry?" changes nothing and only a line about the name counts (second review of C7, 23 Oct).
  let nameExpiredOpen = false;
  let addrExpiredOpen = false;
  // An agent line being heard again as a possible read-back: until that check finishes, nothing that depends on whether
  // it was one (a later read-back, the caller's reply, a Confirm press on the name after that reply) is decided.
  let openProbe: TranscriptEvent | null = null;
  // A line like a read-back said while the caller's name answer was still being checked, so it can't count as one yet:
  // until the caller says something, their next line may be its reply.
  let earlyReadBack: TranscriptEvent | null = null;
  // The same kind of line said while part of a caller's answer was still being checked, kept after the caller replies:
  // until that check lands, the read-back card waits instead of asking for the read-back again (Amendment 3).
  const earlySaid: { name: TranscriptEvent | null; address: TranscriptEvent | null } = { name: null, address: null };
  // The latest read-back until the caller's reply decides it: the next agent line ends the wait for a reply, but not a
  // reply already said and still being checked (second review, 23 Oct).
  let lastReadBack: { ev: Evidence; endedAt: number; line: TranscriptEvent } | null = null;
  // Read-backs and lines heard again so far, to date a name press that waited for them (pressCountsFrom).
  const readBacksSeen: TranscriptEvent[] = [];
  const probesSeen: TranscriptEvent[] = [];
  // One repeat of a read-back after a reply that only asked to hear it again ("Sorry?"), per detail (his yes, 23 Oct).
  // `Open`: that reply came, and the agent hasn't asked anything or read back since.
  const repeatUsed = { name: false, address: false };
  // Read-backs said so far that counted as one (READ_BACKS_PER_DETAIL), whatever their reply.
  const readBacksUsed = { name: 0, address: 0 };
  const readBackLeft = (id: "name" | "address") => readBacksUsed[id] < READ_BACKS_PER_DETAIL;
  let nameRepeatOpen = false;
  let addrRepeatOpen = false;
  // The same read-back for the street and city (his yes, 23 Oct), with the same conditions and the same states as the
  // name's above. The agent's line isn't heard again for it.
  let addrBack: { ev: Evidence; endedAt: number } | null = null;
  let addrRefused: { ev: Evidence; why: string; recovery: "ask" | "type" } | null = null;
  let addrReplyOpen = false;
  let addrHeld = false;
  let earlyAddrBack: TranscriptEvent | null = null;
  let lastAddrBack: { ev: Evidence; endedAt: number; line: TranscriptEvent } | null = null;
  const addrBacksSeen: TranscriptEvent[] = [];
  /**
   * The caller's lines that reply to the agent's line `said`: after it, before the agent's next line, the same lines the
   * read-back rule reads as the reply (the first one, then restOfReply), whenever they start.
   */
  const replyTo = (said: TranscriptEvent) => {
    const after = (l: TranscriptEvent) => l.startedAt > said.startedAt || (l.startedAt === said.startedAt && l.seq > said.seq);
    const nextAgent = ordered.find((l) => l.side === "agent" && l.key !== said.key && after(l));
    return corrected.filter((l) => l.side === "caller" && after(l) && (!nextAgent || l.startedAt < nextAgent.startedAt));
  };
  /**
   * The caller's own answer to the latest question for this detail, all its lines said before `before`: not a reply to a
   * read-back or to a line heard again, and not after the agent's next question.
   */
  const answerLines = (id: "name" | "address", before: number) => {
    const ask = (id === "name" ? nameAsk : addressAsk) as Evidence | null;
    const ends = id === "name" ? nameAskEnds : addressAskEnds;
    const backs = id === "name" ? [...readBacksSeen, ...probesSeen] : addrBacksSeen;
    return ask ? corrected.filter((l) => l.side === "caller" && l.startedAt > ask.at && l.startedAt < Math.min(before, ends) && !backs.some((b) => replyTo(b).includes(l))) : [];
  };
  /**
   * Part of that answer is still being checked, so it may still change: a read-back of it, or a Confirm press on it,
   * waits for that check (outside review, 23 Oct, Amendment 3: a two-line answer lost its tick and its approval).
   */
  const answerChecking = (id: "name" | "address", before: number) => answerLines(id, before).some((l) => l.checking);
  /** When a line first reached the console. */
  const arrived = (l: TranscriptEvent) => l.first?.at ?? l.availableAt ?? l.endedAt;
  /**
   * When a verification first known at `from` could show, given other lines it waited for: each line that had reached
   * the console by then delays it to its own check; one that arrived later doesn't (second review of C7, 23 Oct: a
   * harmless "That's right." arriving after the tick re-dated it, and an approval given in between stopped counting).
   */
  const shownWith = (from: number, others: TranscriptEvent[]) => {
    let at = from;
    for (const l of [...others].sort((x, y) => arrived(x) - arrived(y))) if (arrived(l) <= at) at = Math.max(at, l.availableAt ?? l.endedAt);
    return at;
  };
  /**
   * The same, for a press at `at`: only lines that had reached the console by then. A line said before the press but
   * arriving after it doesn't take back a press the panel already showed as counting (independent review of C7, 23 Oct);
   * if it conflicts, the self-correction rule withdraws the press.
   */
  const answerCheckingAt = (id: "name" | "address", at: number) => answerLines(id, at).some((l) => l.checking && arrived(l) <= at);
  /** The caller's reply to the read-back, or to the line being heard again, is said but not yet decided at `at`. */
  const nameReplyOpen = (at: number) => {
    const probe = openProbe as TranscriptEvent | null;
    const back = lastReadBack as { line: TranscriptEvent } | null;
    return (!!probe && replyTo(probe).some((l) => l.startedAt < at)) || (!!back && replyTo(back.line).some((l) => l.checking && l.startedAt < at));
  };
  /**
   * When a name press made at `at` could first count: after the second hearing, and the checks of the caller's reply,
   * that it waited for (third review, 23 Oct: the press was dated when it was made, before it counted on screen).
   */
  const addressReplyOpen = (at: number) => {
    const back = lastAddrBack as { line: TranscriptEvent } | null;
    return !!back && replyTo(back.line).some((l) => l.checking && l.startedAt < at);
  };
  const pressCountsFrom = (at: number, id: Factor["id"]) => {
    let from = at;
    if (id === "name")
      for (const p of probesSeen) {
        const done = p.reheard?.at;
        // Held only if part of the reply had reached the console before the second hearing landed (fourth review).
        if (done !== undefined && done > at && replyTo(p).some((l) => l.startedAt < at && (l.first?.at ?? l.availableAt ?? l.endedAt) < done)) from = Math.max(from, done);
      }
    for (const b of id === "name" ? readBacksSeen : addrBacksSeen)
      for (const l of replyTo(b)) if (l.startedAt < at && l.heldAt !== undefined && (l.availableAt ?? l.endedAt) > at) from = Math.max(from, l.availableAt ?? l.endedAt);
    // And the checks of the caller's own answer that it waited for.
    for (const l of answerLines(id, at)) if (l.heldAt !== undefined && arrived(l) <= at && (l.availableAt ?? l.endedAt) > at) from = Math.max(from, l.availableAt ?? l.endedAt);
    return from;
  };
  /**
   * The reply to a read-back only asks to hear it again ("Sorry?"), all of it: "again", or "wait" while a later line of
   * the same reply is still being checked. Null for anything else, which refuses the read-back as before.
   */
  const askedAgain = (line: TranscriptEvent): "again" | "wait" | null => {
    // Only a checked, clearly heard "Sorry?" (both models) allows the repeat; anything less refuses as before (review, 23 Oct).
    const clearAgain = (l: TranscriptEvent) =>
      l.checked && !evidenceOf(l).lowConfidence && saysAgain(l.text) && (l.firstHeard === undefined || saysAgain(l.firstHeard));
    if (!clearAgain(line)) return null;
    const rest = restOfReply(line);
    if (rest.some((l) => !l.checking && !clearAgain(l))) return null;
    return rest.some((l) => l.checking) ? "wait" : "again";
  };
  const addressParts = [...textWords(customer.address.street).filter((w) => !STREET_TYPE_WORDS.has(w)), ...textWords(customer.address.city)];
  const saysAddressPart = (text: string) => textWords(text).some((w) => !isFiller(w) && addressParts.some((p) => soundsLike(w, p)));
  // Every agent line that read back the record's name (as either model heard it), or its street and city, whatever it
  // could verify: the caller's reply to it can reject it (his decision, 23 Oct 12:35).
  // A read-back line still held for its own check (an agent line after an approval) counts as said meanwhile, as its fast
  // text, so a rejection in the reply applies at once (independent review, 23 Oct).
  const heldBacks = (id: "name" | "address") =>
    corrected.filter((l) => l.side === "agent" && l.checking && (id === "name" ? [l.text, l.reheard?.text].some((t) => !!t && readsBackName(t, customer)) : readsBackAddress(l.text, customer)));
  const backsSaid: Record<"name" | "address", TranscriptEvent[]> = { name: heldBacks("name"), address: heldBacks("address") };
  /** The caller's reply to such a read-back: from the first line, if it started within READ_BACK_REPLY_MS, up to the agent's next line. */
  const backReply = (b: TranscriptEvent) => {
    const r = replyTo(b).sort((x, y) => x.startedAt - y.startedAt || x.seq - y.seq);
    return r.length && r[0].startedAt <= b.endedAt + READ_BACK_REPLY_MS ? r : [];
  };
  /** The detail was verified, and showed as verified, before this caller line reached the console. */
  const verifiedBefore = (f: Factor, l: TranscriptEvent) => f.state === "ok" && (f.knownAt ?? 0) <= arrived(l);
  /**
   * The detail is ticked by the agent typing over a caller line said before this read-back: a reply that the second model
   * heard as a clear rejection still takes it back, so typing over the old answer never gets past the caller's "No, it's
   * Tom Baker." (his decision, 23 Oct 12:35: typing records what the caller supplied; type the new answer instead).
   */
  const typedOverBefore = (f: Factor, b: TranscriptEvent) => f.state === "ok" && f.evidence?.typedFrom !== undefined && f.evidence.at < b.startedAt;
  /** The record's name said to be someone else's: "Sam's my brother.", "Sam Miller is my husband.", "I'm calling for Sam." */
  const nameAlt = nameParts.map((w) => w.replace(/[^\p{L}']/gu, "")).filter(Boolean).join("|") || "\\0";
  const namedSomeoneElse = new RegExp(`\\b(${nameAlt})('s| is) (my|our|his|her|their) (${RELATIVE})\\b|\\bcalling (for|on behalf of) (${nameAlt})\\b`, "u");
  const recordWordsOf = { name: nameParts, address: [...textWords(customer.address.street), ...textWords(customer.address.city), ...textWords(customer.address.state)] };
  /** Another name or place said in place of the record's: a capitalised word not in the record, after words that introduce one. */
  const statesOther = (id: "name" | "address", text: string) => {
    for (const m of text.matchAll(/\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*)*/gu)) {
      const other = m[0].split(/\s+/).some((x) => {
        const t = normalize(x).replace(/'s$/, "");
        return t.length > 1 && !recordWordsOf[id].includes(t) && !NOT_ANOTHER.has(t) && !isFiller(t) && !/'(ve|re|ll|d|m)$/.test(t);
      });
      const before = normalize(text.slice(0, m.index));
      // "Tom Baker." or "Elm Road, Austin." as the whole start of the reply is another name or place too (third check, 23 Oct).
      const opens = m[0].split(/\s+/).length >= 2 && !before.replace(/\b(um|uh|er|erm|oh|ah|well|hmm|mm|so|sorry|actually|no|nope|nah|wait)\b/g, "").trim();
      if (other && (opens || INTRODUCES.test(before + " "))) return true;
    }
    return false;
  };
  /** The caller says no right next to the record's own words: "Not Sam, Pam.", "No, not Miller." */
  const negatesRecord = (id: "name" | "address", s: string) => {
    const w = s.split(" ");
    return w.some((x, i) => NEGATION.test(x) && w.slice(i + 1, i + 3).some((y) => recordWordsOf[id].includes(y) && !STREET_TYPES.has(y)));
  };
  /** A spelling that isn't the record's: "with an A", "M-I-L-L-A-R" (one letter at a time, not spelling a record word). */
  const spellsOther = (id: "name" | "address", s: string) => {
    if (id !== "name") return false;
    if (/\bwith (an?|two|double) [a-z](?= |$)/.test(s)) return true;
    return [...s.matchAll(/\b(?:[a-z] ){2,}[a-z]\b/g)].some((m) => !recordWordsOf.name.includes(m[0].replace(/ /g, "")));
  };
  /** The caller's whole reply to a read-back of this detail rejects or corrects it (see REJECT_HEAD): an unrelated "No" doesn't. */
  const rejectsBack = (id: "name" | "address", text: string) => {
    const lead = (t: string) => {
      let x = t;
      for (let m = LEAD.exec(x); m && !/^(mm hmm|uh huh|uh uh|mm mm|nuh uh)\b/.test(x); m = LEAD.exec(x)) x = x.slice(m[0].length);
      return x.trim();
    };
    const sentences = text
      .split(/[.!?;]+/)
      .map((x) => lead(textWords(x).join(" ").replace(EVERYDAY_NO, " ").replace(/\s+/g, " ").trim()))
      .filter(Boolean);
    if (!sentences.length) return false;
    const elsewhere = (t: string) => (id === "name" ? SOMEONE_ELSE.test(t) || namedSomeoneElse.test(t) : PLACE_GONE.test(t));
    const detail = statesOther(id, text) || sentences.some((x) => elsewhere(x) || negatesRecord(id, x) || spellsOther(id, x));
    const corrects = detail || sentences.some((x) => REFERS_BACK.test(x));
    const refuses = (x: string) => REJECT_HEAD.test(x) && !noForYes(x);
    const [head, ...later] = sentences;
    if (refuses(head)) {
      // "No." then "And yes, that's me.": the no answered something else.
      const yesAfter = later.some((x) => YES_HEAD.test(x.replace(/^(and|but) /, "")) && !NEGATION.test(x));
      return !(BARE_NO.test(head) && yesAfter && !corrects && !later.some(refuses));
    }
    // A yes, or a no said for yes: only a correction of this detail, or a bare no after it, takes it back.
    if (YES_HEAD.test(head) || noForYes(head)) {
      const startsWrong = (x: string) => REFERS_BACK_START.test(x.replace(/^((no|nope|sorry|wait|but|though) )+/, ""));
      const rest = noForYes(head) ? "" : head.replace(YES_HEAD, "").trim();
      return detail || startsWrong(rest) || later.some((x) => BARE_NO.test(x) || startsWrong(x));
    }
    if (corrects || later.some(refuses)) return true;
    const about = id === "name" ? saysNamePart(text) || /\b(name|surname|spell|spelled|spelling)\b/.test(head) : saysAddressPart(text) || /\b(address|street|road|city)\b/.test(head);
    return NEGATION.test(head) && about;
  };
  /** The caller's later lines in the same reply as `line`: after it, before the agent's next line starts. */
  const restOfReply = (line: TranscriptEvent) => {
    const after = (l: TranscriptEvent) => l.startedAt > line.startedAt || (l.startedAt === line.startedAt && l.seq > line.seq);
    const nextAgent = ordered.find((l) => l.side === "agent" && after(l));
    return corrected.filter((l) => l.side === "caller" && l.key !== line.key && after(l) && (!nextAgent || l.startedAt < nextAgent.startedAt));
  };
  /**
   * `differ`: the two speech models read different complete order numbers from this answer (or the
   * check lost one the fast model had). Both readings are kept as candidates and the order needs a
   * read-back (register I-44). `several`: one answer named different complete order numbers ("06291.
   * Sorry, no, 06294"); the later one is read, and the agent confirms it (I-43).
   */
  const callerMentions: { mention: OrderMention; ev: Evidence; differ?: { first: string; checked: string }; several?: string[] }[] = [];
  // The caller's previous line, while no agent line has come since: a pause can split one order number (I-43).
  let lastCaller: { line: TranscriptEvent; ev: Evidence; expecting: "name" | "address" | "order" | null } | null = null;
  const agentMentionsAfterVerify: { mention: OrderMention; ev: Evidence }[] = [];
  // Assigned through setChoice too, so declared wide: TypeScript doesn't follow assignments in closures.
  let choice = null as CopilotView["choice"];
  // When a different choice became known. An approval given before a change never comes back, even if
  // the customer returns to the first outcome (outside review of call 6, 12 Oct §4).
  const choiceChanges: number[] = [];
  const setChoice = (value: NonNullable<CopilotView["choice"]>["value"], evidence: Evidence, knownAt: number) => {
    if (choice && choice.value !== value) choiceChanges.push(knownAt);
    choice = { value, evidence };
  };
  let askedBoth: Evidence | null = null;
  const escalations: { kind: "words" | "safety"; phrase: string; ev: Evidence }[] = [];
  const earlyOffers: Evidence[] = [];
  const offersInEscalation: Evidence[] = [];
  const disclosures: Evidence[] = [];
  const prompts: ConfirmPrompt[] = [];
  let lowConfidenceChoice: Evidence | null = null;
  // The caller's answer to "Which do you prefer?" named neither option ("Anyone please?" for "A new one, please").
  let choiceAsked = false;
  let unreadChoice: Evidence | null = null;
  // When the agent pressed Confirm on the item; each press counts only for the order shown at that moment.
  const orderPresses: number[] = [];
  // Identity factors the agent's Confirm press verified (each can be undone).
  const confirmedByPress = new Set<Factor["id"]>();
  let issueConfirmedInPanel = false;
  // What the agent chose on the issue card; caller words that arrive later replace "other".
  let issueChoice: "damaged" | "other" | null = null;
  // The agent's damage question, and the caller's yes to it.
  let askedDamage: { ev: Evidence; kind: "arrival" | "extent" } | null = null;
  let damageAnswer: { question: Evidence; answer: Evidence; kind: "arrival" | "extent" } | null = null;
  // "I dropped it": the caller says the damage happened after delivery.
  let causedAfter: { phrase: string; ev: Evidence } | null = null;
  // Every approval given, checked against what was known at its moment once the recommendation is built.
  const given: GivenApproval[] = [];
  const refused: RefusedApproval[] = [];
  let unheardApproval: { ev: Evidence; value: "replacement" | "refund" } | null = null;
  const keyAnswers: string[] = [];
  const readBackChecks: string[] = [];
  const agentChecks: CopilotView["agentChecks"] = [];

  /**
   * The problem is one this SOP covers (damaged on arrival) and it's established: from the
   * caller's own words, their yes to the agent's damage question, or the agent's choice.
   * An unconfirmed model reading never counts (on the 11 Oct call an "Order status" reading
   * the agent confirmed still led to an approved replacement).
   */
  const issueSupported = () =>
    issueChoice === "damaged" ||
    (issueChoice === null &&
      ((intent?.id === "damaged" && (intent.certainty === "high" || issueConfirmedInPanel)) || (!intent && hints.intent?.id === "damaged" && issueConfirmedInPanel)));
  /** Everything an approval needs, at the moment it is given: a stale or early approval doesn't count. */
  // A possible change of mind heard with low confidence puts the outcome on hold until it's confirmed.
  const readyToApprove = () => verified() && !!choice && choice.value !== "both" && issueSupported() && !lowConfidenceChoice;

  const verified = () => name.state === "ok" && address.state === "ok";
  /**
   * An approval, in the panel or on the call, counts only on identity verified when it was given: a name typed later
   * doesn't bring back an approval given while the read-back it relied on was still undecided (Amendment 3 check, and
   * the independent review of C7 for the spoken one, 23 Oct).
   */
  const identityHeldAt = (at: number) => Math.max(name.knownAt ?? 0, address.knownAt ?? 0) <= at;
  const markVerified = (ev: Evidence) => {
    if (verified() && !verifiedAt) verifiedAt = ev;
  };

  /** The caller lines answering the agent's current identity question (see ANSWER_GAP_MS). */
  // `noAttempt`: heard while the question only lingered (after "One moment."): a wrong answer is asked again, not counted.
  type Pending = {
    factor: Factor;
    evs: Evidence[];
    texts: string[];
    endedAt: number;
    result: "partial" | "sounds-like" | "ambiguous" | "mismatch" | "none";
    noAttempt?: boolean;
  };
  // Cast so TypeScript doesn't narrow it to null: it changes inside hear() and closeAnswer().
  let pending = null as Pending | null;
  const firstAnswer = new Map<Factor["id"], Pending>();
  // The answer that last matched each detail (or that a Confirm press vouched for), with every caller line that joined it
  // since, until the agent speaks or the caller pauses (ANSWER_GAP_MS).
  type LastMatch = { line: TranscriptEvent; heard: string; end: number };
  const lastMatch: { name?: LastMatch; address?: LastMatch } = {};
  // Every answer the caller gave for each detail, as each speech model heard it, across re-asks and pauses: the read-back
  // is judged on all of it, so a city or first name given first can't be carried by a later answer (independent review
  // of C7, 23 Oct).
  const answerLog: Record<"name" | "address", { text: string; first: string }[]> = { name: [], address: [] };
  // When a verification was withdrawn because the caller's own answer turned out to conflict: an approval given before
  // that never comes back, even once identity is verified again (independent review of C7, 23 Oct).
  // A fall doesn't count against an approval given once the detail was verified again on a line the caller spoke after
  // the one that undid it (the answer to a re-ask): that approval relied on the new answer (third check of C7, 23 Oct).
  const identityFalls: { at: number; id: "name" | "address"; said: number; reason?: string }[] = [];

  // An email is "at" with "dot", "com" or "mail", or an "@": "Yes, we're at Hill Rd in Dallas." is a street and city, and
  // an echo of one (second review of C7, 23 Oct: any "at" without the word "road" counted as an email).
  const addressMethod = (text: string) => (/@/.test(text) || (/\bat\b/i.test(text) && /\b(dot|com|mail)\b/i.test(text)) ? "email" : "street and city");

  /** Why an answer can't be trusted as heard, if it can't. */
  const doubt = (evs: Evidence[], text: string): "low-confidence" | "garbled" | null =>
    evs.some((e) => e.lowConfidence) ? "low-confidence" : repeatsItself(text) ? "garbled" : null;

  function matched(factor: Factor, ev: Evidence, reason: "low-confidence" | "garbled" | null, method?: string, knownAt = ev.knownAt, evs: Evidence[] = [ev]) {
    factor.evidence = ev;
    factor.knownAt = knownAt;
    if (reason) {
      // A doubtful line never ticks a step on its own.
      factor.state = "confirm";
      factor.confirmReason = reason;
      return;
    }
    factor.state = "ok";
    // Typed after the agent said the detail on the call: allowed only for what the caller said first, so the record says
    // so (his rule, 23 Oct: typing records what the caller supplied, never an unlogged way past the read-back rule). Any
    // typed line of the answer makes it typed, and what the agent said counts up to the keystroke, wherever the typed
    // line sits in the call (second review of C7, 23 Oct).
    const typedEvs = evs.filter((e) => e.typedFrom !== undefined);
    const typedAt = Math.max(...typedEvs.map((e) => e.knownAt));
    const typed = typedEvs.length && agentSaidRecord(factor.id as "name" | "address", method === "email", typedAt) ? "typed by the agent, after the agent said it on the call" : "typed by the agent";
    factor.method = typedEvs.length === 0 ? method : [method, typed].filter(Boolean).join(", ");
    markVerified(ev);
  }

  /**
   * A Confirm press can only vouch for an answer that matches the record or sounds like it. Text that
   * doesn't match ("10 million" for the name on call 9) is asked again, or the agent types what the
   * caller said, which is then checked word for word (outside review 14 Oct, 5.4).
   */
  const resemblesRecord = (f: Factor) => {
    const text = f.heard ?? f.evidence?.text ?? "";
    const result = f.id === "name" ? matchName(text, customer) : matchAddress(text, customer);
    return result === "match" || result === "close" || (!deniesIdentity(text) && soundsLikeRecord(f.id, text, customer));
  };
  const confirmable = (f: Factor) =>
    f.confirmReason === "sounds-like" || ((f.confirmReason === "low-confidence" || f.confirmReason === "garbled") && resemblesRecord(f));

  /**
   * When the agent first said this detail's record words on the call: a read-back, or a leading question ("Is your name
   * Sam Miller?"). From then on the caller's spoken words may be the agent's repeated, so they never verify that detail
   * or count as recognition by themselves; the read-back's own checked plain yes (labelled as a read-back) or the
   * agent's typing (labelled as typed) still can.
   */
  const recordSaidAt: Record<"name" | "address", number | null> = { name: null, address: null };
  const recordName = textWords(customer.name);
  const recordStreet = textWords(customer.address.street).filter((w) => !STREET_TYPE_WORDS.has(w));
  const recordCity = textWords(customer.address.city);
  /** The caller said this record word themselves (as either model heard it) before `at`. */
  const callerSaid = (part: string, at: number) =>
    corrected.some((l) => l.side === "caller" && l.startedAt < at && [l.text, l.firstHeard].some((t) => !!t && textWords(t).map((w) => w.replace(/'s$/, "")).includes(part)));
  /**
   * The agent said the detail: all of it, word for word or by sound ("So your name is Sam Miler, right?" as the fast
   * model heard it), or any part the caller hadn't said themselves yet ("And is the last name Miller?" after "Sam.",
   * "And the city, Dallas?"). Either way the caller's next words may be the agent's repeated (independent review of C7,
   * 23 Oct: a leading question with only the missing part let the caller's echo count as recognition).
   */
  /**
   * A part said in the agent's line: word for word, or written as a name and only by sound, possessive or plural ("Is
   * the last name Miler?", "Mr. Miller's account", "the Millers"), or spelled out ("M I L L E R") (second review of C7,
   * 23 Oct). An everyday word that only sounds like a part ("same day") doesn't count.
   */
  const NAME_CUE = /^(name|surname|spell|spelled|spelling|mr|mrs|ms|miss|it|it's|is)$/;
  const ADDRESS_CUE = /^(street|road|avenue|drive|lane|city|address|town|it|it's|is|in|on)$/;
  const saysPart = (t: string, x: string, cue: RegExp) => {
    const w = textWords(t);
    // The word itself counts when written as a name, or said straight after a word about the detail ("And is the last
    // name miller?", "the city, dallas?") or before a street type ("hill road"). "I will just need your full name" doesn't
    // say Will Turner's first name (second review of C7, 23 Oct).
    const caps = [...t.matchAll(/\p{Lu}[\p{L}'’-]*/gu)].map((m) => normalize(m[0]).replace(/ /g, "").replace(/'s$/, ""));
    if (caps.includes(x)) return true;
    if (w.some((y, i) => y === x && (w.slice(Math.max(0, i - 3), i).some((c) => cue.test(c)) || STREET_TYPE_WORDS.has(w[i + 1] ?? "")))) return true;
    // Written as a name: capitalised inside a sentence ("Same here." at the start of one isn't, "Mr. Miller's" is), or
    // spelled with hyphens.
    const named = [...t.matchAll(/\p{Lu}[\p{L}'’-]*/gu)]
      .filter((m) => /^(\p{Lu}-)+\p{Lu}$/u.test(m[0]) || !/(^|[.!?]\s*)$/.test(t.slice(0, m.index)) || /\b(?:mr|mrs|ms|mx|dr)\.\s*$/i.test(t.slice(0, m.index)))
      .map((m) => normalize(m[0]).replace(/ /g, ""));
    if (named.some((n) => n.length > 1 && [n, n.replace(/s$/, "")].some((y) => y === x || soundsLike(y, x)))) return true;
    let spelled = "";
    for (const y of [...w, ""]) {
      if (/^[a-z]$/.test(y)) spelled += y;
      else if (spelled.length > 1 && spelled === x) return true;
      else spelled = "";
    }
    return false;
  };
  const mentionsRecordName = (t: string, at: number) => {
    const w = textWords(t);
    const run = w.some((_, i) => recordName.every((x, j) => !!w[i + j] && (w[i + j] === x || soundsLike(w[i + j], x))));
    return run || recordName.some((x) => saysPart(t, x, NAME_CUE) && !callerSaid(x, at));
  };
  const mentionsRecordAddress = (t: string, at: number) => {
    const w = textWords(t);
    const parts = [...recordStreet, ...recordCity];
    return parts.every((x) => w.some((y) => y === x || soundsLike(y, x))) || parts.some((x) => saysPart(t, x, ADDRESS_CUE) && !callerSaid(x, at));
  };
  // The email on the order said by the agent ("So that's s dot miller at example mail dot com, right?", "At example mail
  // dot com?"): the caller repeating it is the agent's words too (second review of C7, 23 Oct).
  const emailDomain = textWords(customer.emailFull.split("@")[1] ?? "").filter((w) => w !== "com" && w !== "dot");
  const mentionsRecordEmail = (t: string) => {
    const w = textWords(t);
    return w.includes("at") && (w.includes("dot") || w.includes("com")) && emailDomain.some((d) => w.some((y) => y === d || soundsLike(y, d)));
  };
  let emailSaidAt: number | null = null;
  /** The agent said this detail (or the email) on the call before `before`, as either model heard the agent. */
  const agentSaidRecord = (id: "name" | "address", email: boolean, before: number) =>
    ordered.some(
      (l) =>
        l.side === "agent" &&
        l.startedAt < before &&
        [l.text, l.reheard?.text].some((t) => !!t && (email ? mentionsRecordEmail(t) : id === "name" ? mentionsRecordName(t, l.startedAt) : mentionsRecordAddress(t, l.startedAt))),
    );
  /**
   * Spoken (not typed) after the agent said this detail's record words (or the email, for an email answer). A typed line
   * of the answer doesn't excuse a spoken line of it that carries a part of the detail (second review of C7, 23 Oct).
   */
  const spokenAfterRecordSaid = (f: Factor, evs: Evidence[], email = false) => {
    const since = email ? emailSaidAt : recordSaidAt[f.id as "name" | "address"];
    const says = (t: string) => (f.id === "name" ? saysNamePart(t) : saysAddressPart(t) || addressMethod(t) === "email");
    return since !== null && evs.some((e) => e.typedFrom === undefined && e.at > since && (evs.length === 1 || says(e.text)));
  };
  /** A word of the record's name, or of its street and city, said word for word. */
  const exactPart = (id: "name" | "address", t: string) => {
    const w = textWords(t).map((x) => x.replace(/'s$/, ""));
    return (id === "name" ? recordName : [...recordStreet, ...recordCity]).some((p) => w.includes(p));
  };
  /**
   * Everything the caller said for this detail fits a read-back (readBackFits): only then may the agent say it back,
   * repeating what was heard rather than filling in what wasn't (his rule, 23 Oct). Judged on all the caller's answers
   * for the detail, as each model heard them (independent review of C7, 23 Oct):
   * - One model hearing the whole detail word for word in the latest answer is enough.
   * - Otherwise a reading with any word of the record in it must fit as a whole: "Dallas." then "Elm Road.", or "Sam
   *   Jones." from one model and "Tom Jones." from the other, never opens it.
   * - A reading with no word of the record ("Sen nilir.", "Sandler.") can be the whole answer misheard, as on the 21 and
   *   23 Oct calls. It only gets here doubtful or with the two models disagreeing: heard clearly by both, it is a wrong
   *   answer.
   */
  const readBackOpen = (f: Factor) => {
    const id = f.id as "name" | "address";
    const match = (t: string) => (id === "name" ? matchName(t, customer) : matchAddress(t, customer));
    if ([f.heard, f.heardFirst].some((t) => t !== undefined && match(t) === "match")) return true;
    const log = answerLog[id];
    const readings = log.length ? [log.map((a) => a.text).join(" "), log.map((a) => a.first).join(" ")] : [f.heard ?? f.evidence?.text ?? ""];
    if (readings.some((t) => exactPart(id, t) && !readBackFits(id, t, customer))) return false;
    return readings.some((t) => readBackFits(id, t, customer));
  };
  /**
   * The caller's own answer fits a read-back (readBackOpen). A doubtful, garbled, disputed or sound-alike answer can
   * qualify; an ambiguous one, a wrong one (he chose "Back to before"), or one heard only after the agent said the
   * detail never does.
   */
  const providedWhole = (f: Factor) =>
    f.state === "confirm" &&
    (f.confirmReason === "low-confidence" || f.confirmReason === "garbled" || f.confirmReason === "sounds-like" || f.confirmReason === "disagree") &&
    !!f.evidence &&
    !spokenAfterRecordSaid(f, [f.evidence]) &&
    readBackOpen(f);
  /** A caller line while the agent is waiting for this factor. */
  /**
   * A caller line that would join the same answer as `line` (ANSWER_GAP_MS, before the agent speaks) is still being
   * checked. Only lines that had reached the console by `shownAt`, when the match could first show: a later one doesn't
   * take the tick away while it's checked, and if it conflicts, the self-correction rule withdraws it (second review of
   * C7, 23 Oct, as for a press).
   */
  const moreBeingChecked = (line: TranscriptEvent, shownAt = Infinity) => {
    const nextAgent = ordered.find((l) => l.side === "agent" && l.startedAt > line.startedAt);
    const prevAgent = ordered.findLast((l) => l.side === "agent" && l.startedAt < line.startedAt);
    // Before it too ("Tom Baker, no wait," still being checked, then "it's Sam Miller."): independent review of C7.
    return corrected.some(
      (l) =>
        l.checking &&
        l.side === "caller" &&
        l.key !== line.key &&
        arrived(l) <= shownAt &&
        ((l.startedAt > line.startedAt && l.startedAt - line.endedAt < ANSWER_GAP_MS && (!nextAgent || l.startedAt < nextAgent.startedAt)) ||
          (l.startedAt < line.startedAt && line.startedAt - l.endedAt < ANSWER_GAP_MS && (!prevAgent || l.startedAt > prevAgent.startedAt))),
    );
  };

  function hear(factor: Factor, line: TranscriptEvent, ev: Evidence) {
    if (factor.state === "ok" || locked) return;
    if (pending?.factor !== factor) pending = { factor, evs: [], texts: [], endedAt: 0, result: "none" };
    // The end of the first answer, all of its lines: the start point for "Name accepted" in Call details.
    if (factor.answeredAt === undefined) firstAnswer.set(factor.id, pending);
    if (firstAnswer.get(factor.id) === pending) factor.answeredAt = line.endedAt;
    pending.evs.push(ev);
    pending.texts.push(line.text);
    pending.endedAt = line.endedAt;
    answerLog[factor.id as "name" | "address"].push({ text: line.text, first: ev.typedFrom === undefined ? line.firstHeard ?? line.text : line.text });
    const heard = pending.texts.join(" ");
    const reason = doubt(pending.evs, heard);
    const result = factor.id === "name" ? matchName(heard, customer) : matchAddress(heard, customer);
    factor.heard = heard;
    factor.heardFirst = pending.evs.map((e) => (e.typedFrom === undefined ? e.firstHeard ?? e.text : e.text)).join(" ");
    factor.evidence = ev;
    // The agent saying the street and city doesn't make the email the caller gives instead an echo (independent review
    // of C7, 23 Oct: the email route after a refused read-back was the approved alternative, and stayed open).
    const email = factor.id === "address" && addressMethod(heard) === "email";
    const shownAt = Math.max(...pending.evs.map((e) => e.knownAt));
    const echoes =
      spokenAfterRecordSaid(factor, pending.evs, email) &&
      (result === "match" || ((result === "close" || result === "mismatch") && !deniesIdentity(heard) && (result === "close" || soundsLikeRecord(factor.id, heard, customer))));
    if (echoes) {
      // The caller said the detail, or something close to it, only after the agent had said it on this call: it may be
      // the agent's words repeated, so it never verifies, never opens Confirm or a read-back, and isn't a failed attempt
      // either (review and his rule, 23 Oct). The only spoken route left is a read-back's own checked plain yes;
      // otherwise the agent types what the caller said, recorded as typed.
      factor.state = "confirm";
      factor.confirmReason = "after-read-back";
      pending.result = "sounds-like";
    } else if (result === "match" && moreBeingChecked(line, shownAt)) {
      // The caller went straight on, and that line is still being checked ("Sam Miller." then "No wait, it's Tom
      // Baker."): it is part of the same answer and may change it, so nothing verifies until its check lands
      // (outside review, 23 Oct, Amendment 3).
      factor.state = "asking";
      pending.result = "none";
    } else if (result === "match") {
      matched(factor, ev, reason, factor.id === "address" ? addressMethod(heard) : undefined, shownAt, pending.evs);
      if (!reason) lastMatch[factor.id as "name" | "address"] = { line, heard, end: line.endedAt };
      pending = null;
    } else if (result === "ambiguous") {
      // "Sam Miller or John Smith", "Not Boston, Hill Road in Dallas": ask again; neither a match nor a wrong answer.
      factor.state = "confirm";
      factor.confirmReason = "ambiguous";
      pending.result = "ambiguous";
    } else if (result === "partial") {
      factor.state = "partial";
      pending.result = "partial";
    } else if (result !== "none" && pending.evs.some((e) => e.typedFrom !== undefined)) {
      // Typed by the agent: no sound-alike leniency. Anything short of a match is a wrong answer.
      factor.state = "asking";
      pending.result = "mismatch";
    } else if (!deniesIdentity(heard) && (result === "close" || soundsLikeRecord(factor.id, heard, customer))) {
      // Close to the record but not a clear match: the agent decides; never a failed attempt.
      factor.state = "confirm";
      factor.confirmReason = "sounds-like";
      pending.result = "sounds-like";
    } else {
      // More may be coming; a wrong answer counts only once the caller has finished (closeAnswer).
      factor.state = "asking";
      pending.result = result === "close" ? "mismatch" : result;
    }
  }

  /** The caller finished answering: a clear mismatch is now a failed attempt. */
  function closeAnswer() {
    if (!pending) return;
    const { factor, evs, texts, result, noAttempt } = pending;
    pending = null;
    if (result !== "mismatch" || locked) return;
    // A wrong answer from a doubtful, garbled or disputed line is the agent's call, never a failed attempt.
    const reason = doubt(evs, texts.join(" ")) ?? (evs.some(modelsDisagree) ? "disagree" : null);
    if (reason) {
      factor.state = "confirm";
      factor.confirmReason = reason;
      return;
    }
    // Said while the question only lingered: a genuinely different answer, so it is asked again (no read-back, no
    // Confirm), but it isn't counted as a failed attempt (independent review of C7, 23 Oct: it used to be dropped).
    if (noAttempt) {
      factor.state = "confirm";
      factor.confirmReason = "ambiguous";
      return;
    }
    factor.attempts++;
    factor.state = "failed";
    factor.confirmReason = undefined;
    if (factor.attempts >= pack.policy.maxVerificationAttempts) locked = true;
  }

  /**
   * The order numbers in one caller line. When the second speech model checked the line, the fast
   * model's text is read too: if the check lost a complete order number or read a different one, both
   * readings stay candidates and the answer needs a read-back, never an exact match (I-44). A line
   * that only finishes a number the caller began in the previous line, inside one answer, is read
   * together with it (I-43).
   */
  const readOrder = (line: TranscriptEvent, ev: Evidence, prev: typeof lastCaller): typeof callerMentions => {
    const expectingOrder = expecting === "order";
    const joinable = !!prev && line.startedAt - prev.line.endedAt < ANSWER_GAP_MS;
    // One model's reading: the line's own mentions, else the number it finishes from the previous line.
    const read = (text: string, prevText: string | undefined) => {
      const own = findOrderMentions(text, idLengths, expectingOrder);
      if (own.length || !joinable || prevText === undefined) return { mentions: own, joined: false };
      const split = findSplitOrder(prevText, text, idLengths, prev!.expecting === "order" || expectingOrder);
      return { mentions: split ? [split] : [], joined: !!split };
    };
    const checked = read(line.text, prev?.line.text);
    const firstText = ev.typedFrom === undefined ? line.firstHeard : undefined;
    const prevFirst = prev && (prev.ev.typedFrom === undefined ? prev.line.firstHeard ?? prev.line.text : prev.line.text);
    const first = firstText === undefined ? null : read(firstText, prevFirst ?? undefined);
    const at: Evidence =
      prev && (checked.joined || first?.joined)
        ? { ...ev, text: `${prev.line.text} ${line.text}`, lowConfidence: ev.lowConfidence || prev.ev.lowConfidence }
        : ev;

    const complete = (ms: OrderMention[]) => [...new Set(ms.flatMap((m) => m.candidates.filter((c) => idLengths.includes(c.length))))];
    const checkedNumbers = complete(checked.mentions);
    const firstNumbers = first ? complete(first.mentions) : [];
    if (!firstNumbers.length || firstNumbers.some((n) => checkedNumbers.includes(n))) {
      const said = checked.mentions.map((m) => m.candidates.find((c) => idLengths.includes(c.length))).filter((n) => n !== undefined);
      const several = new Set(said).size > 1 ? said : undefined;
      return checked.mentions.map((mention) => ({ mention, ev: at, ...(several ? { several } : {}) }));
    }
    // The models disagree: keep both readings, the checked one first, and never call it exact.
    const [c, f] = [checked.mentions[0], first!.mentions[0]];
    const mention: OrderMention = {
      ...(c ?? f),
      heard: c ? `${c.heard}" or "${f.heard}` : f.heard,
      candidates: [...new Set([...checkedNumbers, ...firstNumbers])],
      method: "sound-alike",
    };
    return [{ mention, ev: at, differ: { first: firstNumbers.join(" or "), checked: checkedNumbers.join(" or ") || "no order number" } }];
  };

  for (const item of timeline) {
    if (pending && item.at - pending.endedAt >= ANSWER_GAP_MS) closeAnswer();
    if (item.kind === "action") {
      const a = item.action;
      if (a.type === "confirm" && (a.target === "name" || a.target === "address")) {
        const factor = a.target === "name" ? name : address;
        // Once the caller hasn't confirmed a read-back, the agent can't vouch for the name (or the address) instead.
        // While the caller's reply to a read-back (or to a line being heard again as one) is still undecided, a press
        // waits: the reply may refuse it. A press before any reply counts either way.
        // Nor once the caller only asked to hear the read-back again ("Sorry?"): they haven't confirmed it either.
        // And while part of the caller's own answer is still being checked: it may still change what the press is on.
        const replyOpenAt =
          repeatUsed[factor.id] || (factor.id === "name" ? readBackRefused || nameReplyOpen(a.at) : addrRefused || addressReplyOpen(a.at)) || answerCheckingAt(factor.id, a.at);
        if (factor.state === "confirm" && confirmable(factor) && factor.evidence && !locked && !replyOpenAt) {
          if (pending?.factor === factor) pending = null;
          factor.state = "ok";
          confirmedByPress.add(factor.id);
          // A line of the answer that reached the console only after the press doesn't re-date it (second review of C7).
          const onLine = corrected.find((l) => l.key === factor.evidence!.key);
          factor.knownAt = Math.max(pressCountsFrom(a.at, factor.id), onLine && arrived(onLine) > a.at ? a.at : factor.evidence.knownAt);
          // A confirm press is the agent vouching for the answer: always disclosed, for the name as for the address.
          factor.method = a.target === "address" ? factor.method ?? "confirmed by the agent" : "confirmed by the agent";
          markVerified(factor.evidence);
          // A later line of the same answer that corrects it withdraws the press (independent review of C7, 23 Oct).
          const answer = corrected.find((l) => l.key === factor.evidence!.key);
          if (answer?.side === "caller") lastMatch[factor.id as "name" | "address"] = { line: answer, heard: factor.heard ?? answer.text, end: answer.endedAt };
        }
      } else if (a.type === "confirm" && a.target === "issue") {
        if (a.issue) issueChoice = a.issue;
        else issueConfirmedInPanel = true;
      } else if (a.type === "confirm" && a.target === "order") {
        orderPresses.push(a.at);
      } else if (a.type === "confirm" && a.target === "choice" && lowConfidenceChoice) {
        const found = readChoice(lowConfidenceChoice.text);
        if (found) setChoice(found.choice, lowConfidenceChoice, a.at);
        lowConfidenceChoice = null;
      } else if (a.type === "approve" && readyToApprove()) {
        if (identityHeldAt(a.at)) given.push({ at: a.at, via: "panel" });
        else refused.push({ at: a.at, via: "panel", reason: IDENTITY_LATER });
      } else if (a.type === "approve" && !verified() && !!choice && choice.value !== "both" && issueSupported() && !lowConfidenceChoice && identityFalls.some((f) => f.said <= a.at && f.at > a.at)) {
        // Pressed while the console still showed identity verified: the caller's line that undid it was said before the
        // press but reached the console after it. Kept in the history as not counted (independent review, 23 Oct).
        refused.push({ at: a.at, via: "panel", reason: "a caller line said before it, which reached the console after it, undid identity" });
      }
      continue;
    }

    const line = item.line;
    const ev = evidenceOf(line);
    if (lingerUntil !== null && line.startedAt > lingerUntil) [expecting, lingerUntil] = [null, null];

    if (line.side === "caller") {
      // Judged before this line changes anything: what the copilot was waiting for when it was said.
      // After a choice, a line that reads as a different one, or the answer to the choice asked again, is a key answer too.
      const heardChoice = readChoice(line.text)?.choice;
      const changesChoice = !!choice && !!heardChoice && heardChoice !== "both" && heardChoice !== choice.value;
      if (!locked && (!intent || expecting === "name" || expecting === "address" || lowConfidenceChoice || (!choice && (choiceAsked || unreadChoice)) || (choice && (choiceAsked || changesChoice)))) {
        keyAnswers.push(line.key);
      }
      // A reply to the agent's read-back of a detail already verified when it reached the console: it may reject it, so it
      // is checked too. Verified only later (typed after a refused read-back), it is no reply to a verified detail.
      const repliesToOkBack = (["name", "address"] as const).filter((id) => {
        const f = id === "name" ? name : address;
        return backsSaid[id].some((b) => backReply(b).some((l) => l.key === line.key) && (verifiedBefore(f, line) || typedOverBefore(f, b)));
      });
      if (!locked && repliesToOkBack.length && !keyAnswers.includes(line.key)) keyAnswers.push(line.key);
      const caused = CAUSED_AFTER.exec(line.text);
      if (caused && !ev.lowConfidence) causedAfter = { phrase: caused[0], ev };

      for (const found of readIntent(line.text)) {
        if (found.score < 0.5) continue;
        // Keep building the same intent; switch only to a clearly stronger different one.
        const prev = intent as CopilotView["intent"];
        if (prev && prev.id !== found.id && found.score <= prev.confidence) continue;
        const same = prev?.id === found.id ? prev : null;
        const certainHere = found.score >= 0.8 && !ev.lowConfidence;
        if (found.id === "damaged" && certainHere && issueChoice === "other") issueChoice = null;
        intent = {
          id: found.id,
          label: found.id === "damaged" ? DAMAGED_LABEL : "Order status",
          category: "Orders and delivery",
          sopId: found.id === "damaged" ? sopId : null,
          certainty: same?.certainty === "high" || certainHere ? "high" : "low",
          confidence: same ? Math.max(same.confidence, found.score) : found.score,
          phrases: [...new Set([...(same?.phrases ?? []), ...found.evidence])].slice(0, 4),
          evidence: [...(same?.evidence ?? []), ev].slice(0, 3),
          source: "rules",
        };
      }

      if (askedDamage && saysYes(line.text) && !ev.lowConfidence) {
        // "Did it arrive damaged?" "Yes.": the caller established it. "Is the damage only on the screen?"
        // "Yes, only the screen.": confirms damage the caller described; on its own the agent confirms it arrived that way.
        damageAnswer = { question: askedDamage.ev, answer: ev, kind: askedDamage.kind };
        const prior = intent as CopilotView["intent"];
        const same = prior?.id === "damaged" ? prior : null;
        const certain = askedDamage.kind === "arrival" || same?.certainty === "high";
        if (issueChoice === "other" && askedDamage.kind === "arrival") issueChoice = null;
        intent = {
          id: "damaged",
          label: DAMAGED_LABEL,
          category: "Orders and delivery",
          sopId,
          certainty: certain ? "high" : "low",
          confidence: Math.max(same?.confidence ?? 0, certain ? 0.9 : 0.6),
          phrases: same?.phrases ?? [],
          evidence: [...(same?.evidence ?? []), askedDamage.ev, ev].slice(-3),
          source: "rules",
        };
      }
      askedDamage = null;

      const heard = readOrder(line, ev, lastCaller);
      callerMentions.push(...heard);
      lastCaller = { line, ev, expecting };
      earlyReadBack = null;

      // The caller's reply to the agent saying the name back verifies it only as a clear, checked yes, all of it (see
      // whyNotConfirmed and restOfReply), labelled as read back. Any other reply ends read-back for this call: the agent
      // asks for the name again, or types it when only the system couldn't confirm the yes. A reply with no name in it
      // ("No.") isn't heard as a name answer.
      // A line that starts after the 8 s is no reply: the read-back has expired, and the one more the card offers still
      // counts (second review of C7, 23 Oct: a late "Hello?" refused it for the call).
      const saidBackName = readBack as { ev: Evidence; endedAt: number } | null;
      const lateName: boolean = !!saidBackName && line.startedAt > saidBackName.endedAt + READ_BACK_REPLY_MS;
      const backed: { ev: Evidence; endedAt: number } | null = lateName ? null : saidBackName;
      readBack = null;
      if (lateName) [lastReadBack, nameExpiredOpen] = [null, true];
      const continues = !backed && replyOpen;
      if (backed) replyOpen = true;
      let why: string | null | undefined = backed && !locked && name.state !== "ok" ? whyNotConfirmed(line, ev, backed.endedAt, nameYes) : undefined;
      if (backed && why === null) {
        // The yes counts only if the rest of the reply is also a plain yes (or the exact name, or thanks); while part of it
        // is being checked, wait.
        const rest = restOfReply(line);
        const went = rest.find((l) => !l.checking && !confirmsOnly(l.text) && !thanksOnly(l.text) && !saysExactName(l.text, nameParts));
        // A later line with the name counts only as the yes does: checked, clear, and the fast model hearing the name too.
        const nameLine = rest.find((l) => !l.checking && !confirmsOnly(l.text) && !thanksOnly(l.text) && saysExactName(l.text, nameParts));
        if (went) why = `the caller went on: "${went.text}"`;
        else if (nameLine && (nameLine.checkFailed || !nameLine.checked || nameLine.typedFrom !== undefined)) why = NOT_CHECKED;
        else if (nameLine && nameLine.firstHeard !== undefined && !confirmsOnly(nameLine.firstHeard) && !fastHeardName(nameLine.firstHeard)) why = `the fast model heard "${nameLine.firstHeard}"`;
        else if (nameLine && nameLine.confidence !== null && nameLine.confidence < LOW_CONFIDENCE) why = UNCLEAR;
        else if (rest.some((l) => l.checking)) {
          readBackHeld = true;
          why = undefined;
        }
      }
      // A reply that only asks to hear it again ("Sorry?") allows the same read-back once more instead of ending it.
      let again = false;
      if (backed && why === "it isn't a plain yes" && !repeatUsed.name && readBackLeft("name")) {
        const asked = askedAgain(line);
        if (asked === "wait") readBackHeld = true;
        if (asked) why = undefined;
        if (asked === "again") [again, repeatUsed.name, nameRepeatOpen] = [true, true, true];
      }
      if (backed && why === null) {
        if (pending?.factor === name) pending = null;
        name.state = "ok";
        name.evidence = backed.ev;
        name.confirmedBy = ev;
        name.knownAt = shownWith(Math.max(backed.ev.knownAt, ev.knownAt), [...answerLines("name", backed.ev.at), ...restOfReply(line)]);
        name.confirmReason = undefined;
        name.method = NAME_READ_BACK;
        markVerified(ev);
      } else if (why) readBackRefused = { ev, why, recovery: why === NOT_CHECKED || why === UNCLEAR ? "type" : "ask" };
      if (backed && (why !== undefined || again)) lastReadBack = null;

      // The same for the street and city.
      earlyAddrBack = null;
      const saidBackAddr = addrBack as { ev: Evidence; endedAt: number } | null;
      const lateAddr: boolean = !!saidBackAddr && line.startedAt > saidBackAddr.endedAt + READ_BACK_REPLY_MS;
      const backedA: { ev: Evidence; endedAt: number } | null = lateAddr ? null : saidBackAddr;
      addrBack = null;
      if (lateAddr) [lastAddrBack, addrExpiredOpen] = [null, true];
      const continuesA = !backedA && addrReplyOpen;
      if (backedA) addrReplyOpen = true;
      let whyA: string | null | undefined = backedA && !locked && address.state !== "ok" ? whyNotConfirmed(line, ev, backedA.endedAt) : undefined;
      if (backedA && whyA === null) {
        const rest = restOfReply(line);
        const went = rest.find((l) => !l.checking && !confirmsOnly(l.text) && !thanksOnly(l.text));
        if (went) whyA = `the caller went on: "${went.text}"`;
        else if (rest.some((l) => l.checking)) {
          addrHeld = true;
          whyA = undefined;
        }
      }
      let againA = false;
      if (backedA && whyA === "it isn't a plain yes" && !repeatUsed.address && readBackLeft("address")) {
        const asked = askedAgain(line);
        if (asked === "wait") addrHeld = true;
        if (asked) whyA = undefined;
        if (asked === "again") [againA, repeatUsed.address, addrRepeatOpen] = [true, true, true];
      }
      if (backedA && whyA === null) {
        if (pending?.factor === address) pending = null;
        address.state = "ok";
        address.evidence = backedA.ev;
        address.confirmedBy = ev;
        address.knownAt = shownWith(Math.max(backedA.ev.knownAt, ev.knownAt), [...answerLines("address", backedA.ev.at), ...restOfReply(line)]);
        address.confirmReason = undefined;
        address.method = ADDRESS_READ_BACK;
        markVerified(ev);
      } else if (whyA) addrRefused = { ev, why: whyA, recovery: whyA === NOT_CHECKED || whyA === UNCLEAR ? "type" : "ask" };
      if (backedA && (whyA !== undefined || againA)) lastAddrBack = null;

      // His decision of 23 Oct 12:35: the caller clearly rejecting or correcting the agent's read-back of a detail already
      // verified (by a Confirm press, the caller's own answer or typing) reopens that check. Neither the read-back nor a
      // Confirm press can count again for it on this call; an approval given before the rejection stops counting
      // (identityFalls), and nothing that needs identity counts until the detail is verified again. Only a reply to a
      // read-back of that detail can do this, and only a rejection or a correction of it: an unrelated "No" changes
      // nothing. Either model hearing a rejection is enough, since reopening only means asking again.
      const rejectedBack = new Set<"name" | "address">();
      for (const id of repliesToOkBack) {
        const f = id === "name" ? name : address;
        if (locked || f.state !== "ok") continue;
        // The whole reply, as each model heard it, and as recognised under anything the agent typed over it.
        const back = backsSaid[id].find((b) => backReply(b).some((l) => l.key === line.key) && (verifiedBefore(f, line) || typedOverBefore(f, b)))!;
        const backLines = backReply(back);
        // Only the second model's text can take back a tick typed later over the old answer; either model can otherwise.
        const heard = (ls: TranscriptEvent[]) =>
          [ls.map((l) => l.text), ...(verifiedBefore(f, line) ? [ls.map((l) => l.firstHeard ?? l.typedFrom ?? l.text)] : []), ls.map((l) => l.typedFrom ?? l.text)].map((t) => t.join(". "));
        if (!heard(backLines).some((t) => rejectsBack(id, t))) continue;
        // The fall is dated from the line whose words made the reply a rejection, and from when the reply up to it was known.
        const upTo = backLines.findIndex((_, i) => heard(backLines.slice(0, i + 1)).some((t) => rejectsBack(id, t)));
        const part = backLines.slice(0, upTo < 0 ? backLines.length : upTo + 1);
        // The agent said the record's words in that read-back: what the caller says for it from now on is an echo.
        recordSaidAt[id] = Math.min(recordSaidAt[id] ?? back.startedAt, back.startedAt);
        const refusal = { ev, why: "it rejects the read-back", recovery: "ask" as const };
        if (id === "name") [readBackRefused, lastReadBack] = [refusal, null];
        else [addrRefused, lastAddrBack] = [refusal, null];
        Object.assign(f, { state: "confirm", confirmReason: f.confirmReason ?? "ambiguous", knownAt: undefined, method: undefined, confirmedBy: undefined });
        confirmedByPress.delete(id);
        verifiedAt = undefined;
        identityFalls.push({ at: Math.max(...part.map((l) => evidenceOf(l).knownAt)), id, said: part[part.length - 1].startedAt, reason: "the caller rejected the read-back after it" });
        delete lastMatch[id];
        if (pending?.factor === f) pending = null;
        rejectedBack.add(id);
      }

      // The caller correcting themselves straight after an answer that matched, before the agent spoke ("Sam Miller."
      // then "No wait, it's Tom Baker."): their own answer conflicts after all, so it's asked again, never verified and
      // never a failed attempt (his rule, 23 Oct).
      // Every later line of that answer is read with it, not only the next one ("Sam Miller." "Um." "No wait, it's Tom
      // Baker."), and a press or a volunteered match is withdrawn the same way (independent review of C7, 23 Oct).
      const selfCorrected = new Set<string>();
      for (const f of [name, address]) {
        const id = f.id as "name" | "address";
        const m = lastMatch[id];
        if (!m || m.line.key === line.key) continue;
        // After a pause, while the agent is still silent, a line that corrects itself ("No wait, it's Tom Baker.") is still
        // read with the answer; other lines after the pause are left out of it (third check of C7, 23 Oct: a correction
        // 2 s after the answer was ignored, and an approval after it counted).
        const near = line.startedAt - m.end < ANSWER_GAP_MS;
        const stillOn =
          !locked &&
          f.state === "ok" &&
          f.evidence?.key === m.line.key &&
          !ordered.some((l) => l.side === "agent" && l.startedAt > m.line.startedAt && l.startedAt < line.startedAt);
        if (stillOn && !near && !/\b(no|wait|actually|sorry|meant|mean|correction|oops)\b/i.test(line.text)) continue;
        if (!stillOn) {
          delete lastMatch[id];
          continue;
        }
        [m.heard, m.end] = [`${m.heard} ${line.text}`, line.endedAt];
        if ((id === "name" ? matchName(m.heard, customer) : matchAddress(m.heard, customer)) !== "ambiguous") continue;
        Object.assign(f, { state: "confirm", confirmReason: "ambiguous", heard: m.heard, heardFirst: m.heard, evidence: ev, knownAt: undefined, method: undefined });
        confirmedByPress.delete(id);
        verifiedAt = undefined;
        identityFalls.push({ at: ev.knownAt, id, said: line.startedAt });
        selfCorrected.add(id);
        delete lastMatch[id];
        // Later lines of the same answer are read together with it, so flipping back ("Sorry, Sam Miller.") stays asked again.
        pending = { factor: f, evs: [ev], texts: [m.heard], endedAt: line.endedAt, result: "ambiguous" };
      }

      const lingering = lingerUntil !== null;
      // While the question only lingers, a line about the detail is heard as an answer like any other: a split answer
      // joins up, a doubtful or disputed one opens Confirm or the read-back, and a different one is asked again. Only a
      // failed attempt is never counted (independent review of C7, 23 Oct: these used to be dropped silently).
      const hearLingering = (factor: Factor) => {
        hear(factor, line, ev);
        if (pending?.factor === factor) pending.noAttempt = true;
      };
      // Spelling the name ("M I L L E R.", "Miller with two Ls.", "That's Miller, double L.") after "Could you spell the last
      // name?" adds nothing to a doubtful answer, so it stays as it was. Spelled letters that make another name don't
      // count as spelling (second review of C7, 23 Oct: it was taken as a second name).
      const spelledRuns = (w: string[]) => {
        const runs: string[] = [];
        let run = "";
        for (const y of [...w, ""]) {
          if (/^[a-z]$/.test(y)) run += y;
          else {
            if (run.length > 1) runs.push(run);
            run = "";
          }
        }
        return runs;
      };
      const spellsOther = (t: string) => spelledRuns(textWords(t)).some((r) => !nameParts.some((p) => r === p || soundsLike(r, p)));
      const spellsName = (t: string) => {
        const w = textWords(t).map((y) => y.replace(/'s$/, ""));
        if (spellsOther(t)) return false;
        const rest = w.filter((y) => !/^[a-z]$/.test(y) && !nameParts.some((p) => soundsLike(y, p)));
        return w.some((y) => /^[a-z]$/.test(y) || /^[a-z]s$/.test(y)) && rest.every((y) => isFiller(y) || /^[a-z]s$/.test(y) || /^(with|two|double|an|a|one|it|its|it's|that|that's|thats|is|spelled|spelt|and|as|in|like|letter|letters|yes|yeah)$/.test(y));
      };
      // A line about the street and city or the email is never a name ("It's Hill Road in Dallas.", the email with
      // "miller" in it); a line about the name says part of it, sounds like it, or names someone else (namesAnother).
      // "Yes, it's the Samsung one." is neither (second review of C7, 23 Oct).
      const addressWords = (t: string) =>
        textWords(t).some((w) => [...recordStreet, ...recordCity].includes(w) || STREET_TYPE_WORDS.has(w)) || addressMethod(t) === "email";
      const aboutName = (t: string) => !addressWords(t) && (saysNamePart(t) || soundsLikeRecord("name", t, customer) || namesAnother(t, customer) || spellsOther(t));
      const aboutAddress = (t: string) =>
        saysAddressPart(t) || soundsLikeRecord("address", t, customer) || addressMethod(t) === "email" || /\b(road|street|avenue|drive|lane)\b/i.test(t);
      // While the question only lingers, a line that adds nothing new to a doubtful answer ("Miller, M I L L E R.", "It's
      // Miller with two Ls.") leaves it as it was; only a match, or a line naming someone else, changes it.
      const addsNothing = (f: Factor, t: string) =>
        f.state === "confirm" && (f.id === "name" ? !["match", "ambiguous"].includes(matchName(t, customer)) && !namesAnother(t, customer) : matchAddress(t, customer) === "partial");
      // A typed correction over the caller's reply to a read-back is the agent's words, not the caller's, unless that
      // reply said the detail (independent review of C7, 23 Oct: the record name typed over "Yes." verified).
      const typedOverReply = (backedOrOpen: boolean, says: (t: string) => boolean) => backedOrOpen && ev.typedFrom !== undefined && !says(ev.typedFrom);
      let heardName = false;
      let heardAddress = false;
      if (!locked) {
        // The factor the agent asked for; the other only counts if volunteered as a clear match.
        if (
          why === null ||
          readBackHeld ||
          again ||
          ((why || continues) && !saysNamePart(line.text)) ||
          typedOverReply(!!backed || continues, saysNamePart) ||
          selfCorrected.has("name") ||
          rejectedBack.has("name")
        ) {
          // A confirmed read-back, a reply still being decided, a "Sorry?", or a reply to one with no name in it: never a failed attempt.
        } else if (expecting === "name" && confirmsOnly(line.text)) {
          // A plain yes answers no name question ("Yes, that's right." to a read-back the fast model misheard as a
          // question): nothing changes, and it is never a failed attempt.
        } else if (name.state === "confirm" && spellsName(line.text)) {
          heardName = true;
        } else if (expecting === "name" && (lingering || nameExpiredOpen)) {
          heardName = aboutName(line.text);
          if (heardName && !addsNothing(name, line.text)) hearLingering(name);
        } else if (expecting === "name") {
          heardName = true;
          hear(name, line, ev);
        }
        else if (name.state !== "ok" && matchName(line.text, customer) === "match" && !spokenAfterRecordSaid(name, [ev]) && !moreBeingChecked(line, ev.knownAt)) {
          matched(name, ev, doubt([ev], line.text));
          if ((name.state as Factor["state"]) === "ok") lastMatch.name = { line, heard: line.text, end: line.endedAt };
        }
        if (
          whyA === null ||
          addrHeld ||
          againA ||
          ((whyA || continuesA) && !saysAddressPart(line.text)) ||
          typedOverReply(!!backedA || continuesA, saysAddressPart) ||
          selfCorrected.has("address") ||
          rejectedBack.has("address")
        ) {
          // The same for the address read-back.
        } else if (expecting === "address" && confirmsOnly(line.text)) {
          // The same for the address.
        } else if (expecting === "address" && (lingering || addrExpiredOpen)) {
          heardAddress = aboutAddress(line.text);
          if (heardAddress && !addsNothing(address, line.text)) hearLingering(address);
        } else if (expecting === "address") {
          heardAddress = true;
          hear(address, line, ev);
        }
        else if (
          address.state !== "ok" &&
          matchAddress(line.text, customer) === "match" &&
          !spokenAfterRecordSaid(address, [ev], addressMethod(line.text) === "email") &&
          !moreBeingChecked(line, ev.knownAt)
        ) {
          matched(address, ev, doubt([ev], line.text), addressMethod(line.text));
          if ((address.state as Factor["state"]) === "ok") lastMatch.address = { line, heard: line.text, end: line.endedAt };
        }
        // A later line that names a different candidate while the answer is still the agent's call (doubtful, a
        // sound-alike) and nobody asked for it ("I'm pulling up your account now." then "Actually it's Tom Baker."): the
        // caller's answer conflicts, so it is asked again; no read-back, no Confirm (independent review of C7, 23 Oct).
        // Never on a line that answers the other detail's question or was heard as the other detail: the field would move
        // onto it, and typing there would overwrite that answer (second review of C7, 23 Oct).
        for (const [f, heardIt, reply, about, other, otherHeard] of [
          [name, heardName, !!backed || continues, aboutName, address, heardAddress],
          [address, heardAddress, !!backedA || continuesA, aboutAddress, name, heardName],
        ] as const) {
          if (heardIt || reply || rejectedBack.has(f.id as "name" | "address") || f.state !== "confirm" || f.confirmReason === "ambiguous" || !f.evidence || line.startedAt <= f.evidence.at) continue;
          if (otherHeard || expecting === other.id || other.evidence?.key === line.key) continue;
          // Nor once the agent has asked about something else since the answer ("Is the damage only on the screen?"):
          // the caller is answering that. A question about this detail ("And the last name?") keeps it open.
          const asked = ordered.some(
            (l) => l.side === "agent" && l.startedAt > f.evidence!.at && l.startedAt < line.startedAt && /\?/.test(l.text) && !(f.id === "name" ? /name/i : /\b(street|city|address|email|e-mail|zip)\b/i).test(l.text),
          );
          if (asked) continue;
          const result = f.id === "name" ? matchName(line.text, customer) : matchAddress(line.text, customer);
          if (!about(line.text) || (result !== "mismatch" && result !== "ambiguous")) continue;
          Object.assign(f, { confirmReason: "ambiguous", heard: line.text, heardFirst: line.firstHeard ?? line.text, evidence: ev });
        }
      }

      const wants = readChoice(line.text);
      if (wants) unreadChoice = null;
      else if (choiceAsked && !choice) unreadChoice = ev;
      choiceAsked = false;
      if (wants?.choice === "both") askedBoth = ev;
      else if (wants && ev.lowConfidence) {
        // The same choice again, unclear, changes nothing; a different one is a possible change of mind.
        if (!choice || wants.choice !== choice.value) lowConfidenceChoice = ev;
      } else if (wants) {
        setChoice(wants.choice, ev, ev.knownAt);
        lowConfidenceChoice = null;
      }

      for (const phrase of escalationWords(line.text)) escalations.push({ kind: "words", phrase, ev });
      for (const phrase of safetyWords(line.text)) escalations.push({ kind: "safety", phrase, ev });

      if (expecting === "order" && callerMentions.length) expecting = null;
    } else {
      const offer = agentOffers(line.text);
      if (offer && !verified()) earlyOffers.push(ev);
      if (offer && escalations.length) offersInEscalation.push(ev);

      if (agentAsksChoice(line.text)) choiceAsked = true;
      const kind = ev.lowConfidence ? null : damageQuestion(line.text);
      askedDamage = kind ? { ev, kind } : null;

      closeAnswer();
      lastCaller = null;
      replyOpen = false;
      addrReplyOpen = false;
      nameExpiredOpen = false;
      addrExpiredOpen = false;
      const asksRaw = agentAsksFor(line.text, !verified() && !locked);
      // The agent said the record's name, or its street and city, in any form ("Is your name Sam Miller?", or a
      // read-back): from here the caller's spoken words can't verify that detail by themselves (second review, 23 Oct),
      // and a caller repeating it never counts as recognition (his rule, 23 Oct: assisted read-back stays separate).
      for (const f of [name, address]) {
        const id = f.id as "name" | "address";
        if (f.state === "ok" || recordSaidAt[id] !== null) continue;
        const said = [line.text, line.reheard?.text].some((t) => !!t && (id === "name" ? mentionsRecordName(t, line.startedAt) : mentionsRecordAddress(t, line.startedAt)));
        if (said) recordSaidAt[id] = line.startedAt;
      }
      if (address.state !== "ok" && emailSaidAt === null && [line.text, line.reheard?.text].some((t) => !!t && mentionsRecordEmail(t))) emailSaidAt = line.startedAt;
      if (!locked && [line.text, line.reheard?.text].some((t) => !!t && readsBackName(t, customer))) backsSaid.name.push(line);
      if (!locked && readsBackAddress(line.text, customer)) backsSaid.address.push(line);
      // No read-back of either detail while the caller's reply to an earlier one is still being checked.
      const replyChecking = [...readBacksSeen, ...addrBacksSeen].some((b) => replyTo(b).some((l) => l.checking));
      // Saying the name back is allowed only when the client allows it, once the caller has given an answer that covers
      // the whole name but the speech models couldn't confirm (never a partial, ambiguous, missing or wrong one: he chose
      // "Back to before", 23 Oct), before any failed attempt (a failure is asked again, or the caller's own words typed),
      // and once per call: a reply that isn't a clear yes ends it.
      const canReadBack: boolean =
        !!pack.policy.nameReadBack &&
        !locked &&
        !readBackRefused &&
        readBackLeft("name") &&
        !readBackHeld &&
        !openProbe &&
        // Nor while the caller's reply to an earlier read-back is still being checked: a repeated read-back would take
        // over from it, and a press or an approval would count before that reply's "No." (fourth review, 23 Oct).
        !replyChecking &&
        !addrHeld &&
        // Nor while part of the caller's own answer is still being checked (below: it counts once that check lands).
        !answerChecking("name", line.startedAt) &&
        providedWhole(name) &&
        name.attempts === 0 &&
        name.evidence?.side === "caller";
      const pendingReadBack = readBack;
      // The read-back as the fast model heard it, or as the second model heard it again (below).
      const reheard = line.reheard?.text && !(line.reheard.confidence !== null && line.reheard.confidence < LOW_CONFIDENCE) ? line.reheard : null;
      const saidBack =
        !ev.lowConfidence && readsBackName(line.text, customer)
          ? ev
          : reheard && readsBackName(reheard.text!, customer)
            ? { ...ev, text: reheard.text!, firstHeard: line.text, knownAt: Math.max(ev.knownAt, reheard.at), lowConfidence: false }
            : null;
      // The street and city said back under the same conditions. A read-back that names the address ("So the address is
      // Hill Road, Dallas, right?") isn't a new address question.
      const canReadBackAddr: boolean =
        !!pack.policy.addressReadBack &&
        !locked &&
        !addrRefused &&
        readBackLeft("address") &&
        !addrHeld &&
        !readBackHeld &&
        !openProbe &&
        !replyChecking &&
        !answerChecking("address", line.startedAt) &&
        providedWhole(address) &&
        address.attempts === 0 &&
        address.evidence?.side === "caller";
      const addrSaidBack = !ev.lowConfidence && (!asksRaw || asksRaw === "address") && readsBackAddress(line.text, customer);
      addrBack = canReadBackAddr && addrSaidBack ? { ev, endedAt: line.endedAt } : null;
      // A line that says the record's name, or its street and city, back ("So your name is Sam Miller, right?") isn't a
      // new question for that detail while it can count as a read-back, now or once a check lands: it would reset the
      // question, the caller's "Yes." would become the answer and the sound-alike would be lost (Amendment 5 check, 23
      // Oct). Said while part of the caller's answer is still being checked, it waits as a read-back (earlySaid) instead of
      // moving the question past that answer (independent review of C7, 23 Oct). Where it can't count on this call
      // (read-back off, refused, used up, after a failed attempt), it stays a question, so the caller's "No." is heard and
      // a Confirm press can't verify over it; a plain yes changes nothing (second review of C7, 23 Oct). Only the record's
      // own words count: a re-ask that merely has a name in it ("Could you repeat the address, Sam?") stays a question.
      const nameWordBack: boolean =
        asksRaw === "name" && !!saidBack && !!pack.policy.nameReadBack && !locked && !readBackRefused && readBackLeft("name") && providedWhole(name) && name.attempts === 0;
      const addrWordBack: boolean =
        asksRaw === "address" && addrSaidBack && !!pack.policy.addressReadBack && !locked && !addrRefused && readBackLeft("address") && providedWhole(address) && address.attempts === 0;
      const asks: typeof asksRaw = addrBack || nameWordBack || addrWordBack ? null : asksRaw;
      readBack = !asks && !addrBack && canReadBack && saidBack ? { ev: saidBack, endedAt: line.endedAt } : null;
      // The agent's mic is clean, but the fast model can still mishear a read-back: it wrote "So it's Samuel Wright."
      // for "So it's Sam Miller, right?" and the second model heard it right (23 Oct C3 call). While read-back is allowed
      // and the name question is the latest one, a line shaped like a read-back is heard again by the second model. It
      // isn't held back: until that check finishes it counts as heard, and only what depends on whether it was a
      // read-back waits (openProbe). What counts as a read-back, and the caller's checked plain yes, stay as they are.
      // After the caller's "Sorry?", the repeated read-back is heard again the same way.
      if (!readBack && !addrBack && !asks && !pendingReadBack && canReadBack && nameAsk && (nameAskEnds === Infinity || nameRepeatOpen) && !line.reheard && shapedLikeReadBack(line.text)) {
        readBackChecks.push(line.key);
        if (line.probing) openProbe = line;
      }
      if (line.probedAt !== undefined) probesSeen.push(line);
      // Said before the name answer's check finished, it isn't a read-back yet; once it is, the caller's reply must not
      // have counted on its own first (third review, 23 Oct: "Yes, Sam Miller." verified, then went back for its check).
      // Only where a read-back could still count (fourth review, 23 Oct: not after a refusal or a failed attempt), and
      // only for the name answer itself, not a reply to an earlier read-back or line heard again (an item read-back
      // like "And that's the tablet on order 427, is that right?" has the same shape).
      earlyReadBack =
        !!pack.policy.nameReadBack &&
        !readBack &&
        !asks &&
        !locked &&
        !readBackRefused &&
        readBackLeft("name") &&
        !readBackHeld &&
        !openProbe &&
        name.attempts === 0 &&
        name.state !== "ok" &&
        expecting === "name" &&
        answerChecking("name", line.startedAt) &&
        (readsBackName(line.text, customer) || shapedLikeReadBack(line.text))
          ? line
          : null;
      earlyAddrBack =
        !!pack.policy.addressReadBack &&
        !addrBack &&
        !readBack &&
        !asks &&
        !locked &&
        !addrRefused &&
        readBackLeft("address") &&
        !addrHeld &&
        address.attempts === 0 &&
        address.state !== "ok" &&
        expecting === "address" &&
        answerChecking("address", line.startedAt) &&
        readsBackAddress(line.text, customer)
          ? line
          : null;
      if (earlyReadBack) earlySaid.name = earlyReadBack;
      if (earlyAddrBack) earlySaid.address = earlyAddrBack;
      if (asks || readBack || addrBack) [earlySaid.name, earlySaid.address] = [null, null];
      if (readBack) {
        expecting = "name";
        readBacksUsed.name++;
        lastReadBack = { ...readBack, line };
        readBacksSeen.push(line);
      } else if (addrBack) {
        expecting = "address";
        readBacksUsed.address++;
        lastAddrBack = { ...addrBack, line };
        addrBacksSeen.push(line);
      }
      else if (!asks && (expecting === "name" || expecting === "address")) {
        const f = expecting === "name" ? name : address;
        if (f.state !== "ok" && !locked && onlyHolds(line.text)) lingerUntil = line.endedAt + LINGER_MS;
        else [expecting, lingerUntil] = [null, null];
      }
      if (asks || readBack || addrBack) lingerUntil = null;
      if (asks || readBack || addrBack) [nameRepeatOpen, addrRepeatOpen] = [false, false];
      if (asks || readBack || addrBack) {
        if (asks !== "name" && nameAsk) nameAskEnds = Math.min(nameAskEnds, line.startedAt);
        if (asks !== "address" && addressAsk) addressAskEnds = Math.min(addressAskEnds, line.startedAt);
      }
      if (asks === "name") [nameAsk, nameAskEnds] = [ev, Infinity];
      if (asks === "address") [addressAsk, addressAskEnds] = [ev, Infinity];
      if (asks) {
        expecting = asks;
        const factor = asks === "name" ? name : asks === "address" ? address : null;
        if (factor && (factor.state === "idle" || factor.state === "failed" || factor.state === "partial")) factor.state = "asking";
      }

      if (verified()) for (const mention of findOrderMentions(line.text, idLengths)) agentMentionsAfterVerify.push({ mention, ev });

      if (name.attempts + address.attempts > 0 && agentDisclosesFactor(line.text)) disclosures.push(ev);

      // "Done. The new tablet ships today." after the customer chose is the agent's approval on the call.
      const offeringOptions = /\?/.test(line.text) && /\bor\b/i.test(line.text);
      // Said while the console still showed identity verified: the caller's rejection, said before it, reached the console
      // after it. Never counted, but kept in the history (independent review, 23 Oct).
      if (
        choice &&
        !offeringOptions &&
        !verified() &&
        !escalations.length &&
        ev.at > choice.evidence.at &&
        !ev.lowConfidence &&
        agentCommits(line.text) &&
        !(choice.value === "refund" ? /\b(replace(ment)?|ships?|shipped|shipping|new (one|\w+))\b/i : /\brefund\b/i).test(line.text) &&
        (choice.value !== "refund" || /\b(refund|money|done|all set)\b/i.test(line.text)) &&
        identityFalls.some((f) => f.said <= line.endedAt && f.at > arrived(line))
      )
        refused.push({ at: line.endedAt, via: "call", evidence: ev, reason: "a caller line said before it, which reached the console after it, undid identity" });
      if (choice && !offeringOptions && verified() && !escalations.length && ev.at > choice.evidence.at) {
        const commit = ev.lowConfidence ? null : agentCommits(line.text);
        // A line that names the other outcome is never this one's approval: "Done. The new tablet ships
        // today." counted as the approval of a refund (Call 11 review, I-23).
        const namesReplacement = /\b(replace(ment)?|ships?|shipped|shipping|new (one|\w+))\b/i.test(line.text);
        const namesRefund = /\brefund\b/i.test(line.text);
        const other = choice.value === "refund" ? "replacement" : "refund";
        const namesOther = choice.value === "refund" ? namesReplacement : namesRefund;
        const fitsChoice = !namesOther && (choice.value === "refund" ? /\b(refund|money|done|all set)\b/i.test(line.text) : true);
        const aboutChoice =
          choice.value === "refund"
            ? /\b(refund|money|dollars|visa|card)\b|\$\d/i.test(line.text)
            : /\b(ships?|shipping|replacement|new (one|\w+))\b/i.test(line.text) && !/\brefund\b/i.test(line.text);
        const earlier = [...given].reverse().find((g) => g.at > choice!.evidence.at);
        let note: string;
        if (commit && fitsChoice && readyToApprove() && !identityHeldAt(line.endedAt)) {
          refused.push({ at: line.endedAt, via: "call", evidence: ev, reason: IDENTITY_LATER });
          note = "approval words, but identity was verified only after them";
        } else if (commit && fitsChoice && readyToApprove()) {
          given.push({ at: line.endedAt, via: "call", evidence: ev });
          unheardApproval = null;
          note = "approval heard in this line";
        } else if (commit && namesOther && readyToApprove()) {
          // Recorded and checked again, not dropped (the 01:43 "free refund" line in Call 11, I-24).
          refused.push({ at: line.endedAt, via: "call", evidence: ev, reason: `it named a ${other}, not the ${choice.value}` });
          keyAnswers.push(line.key);
          note = `approval words, but the line named the ${other}`;
        } else if (aboutChoice && readyToApprove() && !earlier) {
          // About the chosen outcome, but no approval heard in it: flag it, and let the second speech model
          // hear it again (call 7: "offset a full refund" for "I've set up a full refund").
          unheardApproval = { ev, value: choice.value === "refund" ? "refund" : "replacement" };
          keyAnswers.push(line.key);
          note = "about the outcome, but no approval heard";
        } else if (aboutChoice && earlier) {
          // Call 10: the refund line ("Afzata full refund of 329 dollars.") came after an approval in the panel.
          note = earlier.via === "panel" ? "already approved in the panel" : "already approved on the call";
        } else if (aboutChoice) {
          note = "not ready to approve yet";
        } else {
          note = "not about the outcome";
        }
        // An unclear agent line once the customer has chosen may carry the approval or the terms: check it too.
        if (ev.lowConfidence && !keyAnswers.includes(line.key)) {
          keyAnswers.push(line.key);
          note = "unclear line after the customer chose";
        }
        agentChecks.push({ key: line.key, check: keyAnswers.includes(line.key), reason: note });
      }
    }
  }

  const hinted = hints.intent && ordered.find((l) => l.key === hints.intent!.key);
  if (!intent && hints.intent && hinted) {
    const damaged = hints.intent.id === "damaged";
    intent = {
      id: hints.intent.id,
      label: damaged ? DAMAGED_LABEL : "Order status",
      category: "Orders and delivery",
      sopId: damaged ? sopId : null,
      certainty: "low",
      confidence: 0.5,
      // No caller phrase backs a model reading; provenance is in `source`, never in the facts.
      phrases: [],
      evidence: [evidenceOf(hinted)],
      source: "model",
    };
  }
  const intentEvidence: Evidence[] = (intent as CopilotView["intent"])?.evidence ?? [];
  // "I dropped it": damage after delivery isn't covered unless the agent chooses "Arrived damaged".
  if (causedAfter && intent?.id === "damaged") intent = { ...intent, certainty: "low" };
  if (issueChoice === "damaged" && intent?.id !== "damaged") {
    intent = { id: "damaged", label: DAMAGED_LABEL, category: "Orders and delivery", sopId, certainty: "high", confidence: 1, phrases: [], evidence: intentEvidence, source: "agent" };
  } else if (issueChoice === "damaged" && intent) {
    intent = { ...intent, certainty: "high" };
  } else if (issueChoice === "other") {
    intent = { id: "other", label: "Another issue (not damage on arrival)", category: "Orders and delivery", sopId: null, certainty: "high", confidence: 1, phrases: [], evidence: intentEvidence, source: "agent" };
  } else if (intent && issueConfirmedInPanel) intent = { ...intent, certainty: "high" };
  const supported = intent?.id === "damaged" && intent.certainty === "high";
  const callerDescribed = intent?.source === "rules" && intent.phrases.length > 0;
  const damageSource =
    issueChoice === "damaged" || issueConfirmedInPanel ? "confirmed by the agent" : callerDescribed ? "described by the caller" : "confirmed by the caller";
  if (pending && now - pending.endedAt >= ANSWER_GAP_MS) closeAnswer();
  const isVerified = verified();
  const verifiedKnownAt = isVerified ? Math.max(name.knownAt ?? 0, address.knownAt ?? 0) : undefined;
  const attemptsLeft = Math.max(0, pack.policy.maxVerificationAttempts - Math.max(name.attempts, address.attempts));

  /* ---------- Order ---------- */
  const order: CopilotView["order"] = { state: "none" };
  const latestCaller = [...callerMentions].reverse();
  if (latestCaller.length) {
    const { mention, ev, differ } = latestCaller[0];
    const reading = differ ? mention.candidates.join(" or ") : mention.method === "sound-alike" ? `probably ${mention.candidates[0]}` : mention.candidates[0];
    order.heard = { text: mention.heard, reading, method: mention.method, evidence: ev };
    order.state = "heard";
  }
  if (isVerified) {
    const sources: { mention: OrderMention; ev: Evidence; differ?: { first: string; checked: string }; several?: string[] }[] = [...latestCaller, ...agentMentionsAfterVerify];
    const found = matchOrder(sources.map((s) => s.mention), customerOrders, pack.policy.claimWindowDays);
    if (found) {
      const source = sources.find((s) => s.mention === found.mention);
      // A confirmation is bound to the order number it confirmed: once the caller names a different
      // number after it, it no longer stands, even if they come back to the first (plan Step 5, action 5).
      const stands = (at: number) => !callerMentions.some((c) => c.ev.at > at && !c.mention.candidates.includes(found.order.id));
      const readBack = agentMentionsAfterVerify.find(
        (a) => !a.ev.lowConfidence && a.mention.candidates.includes(found.order.id) && stands(a.ev.at)
      );
      // A Confirm press counts only for the order the panel showed when it was pressed.
      const pressedAt = orderPresses.find(
        (at) =>
          stands(at) &&
          rules(pack, asOf(lines, at), allActions.filter((x) => x.at < at), at, hints, true).order.match?.order.id === found.order.id
      );
      const differ = source?.differ;
      const several = source?.several;
      const needsConfirmation = found.needsConfirmation || !!source?.ev.lowConfidence || !!differ || !!several;
      order.state = "matched";
      order.match = {
        order: orderView(found.order, now),
        method: found.method,
        note: differ
          ? `The two speech models heard different order numbers: ${differ.checked} on the check, ${differ.first} first. Read the order number back to the caller.`
          : several
            ? `The caller named ${several.join(", then ")}. ${found.note} Read the order number back to the caller.`
            : found.note,
        needsConfirmation,
        confirmed: !!readBack || pressedAt !== undefined,
        confirmedBy: readBack?.ev ?? (pressedAt !== undefined ? "panel" : undefined),
        evidence: source?.ev,
        ...(pressedAt !== undefined ? { pressedAt } : {}),
        ...(readBack ? { readBack: readBack.ev } : {}),
      };
    } else if (latestCaller.length) {
      order.state = "unmatched";
    }
  }
  const match = order.match;
  // Located: found in the verified customer's orders, and confirmed if it was only a near match.
  const orderLocated = !!match && (!match.needsConfirmation || match.confirmed);
  // Confirmed: the item was read back to the caller (or the agent confirmed it). Required before any
  // approval, even for an exact match: the SOP lists it, and it costs the agent one sentence (decision 14 Oct, 6.1).
  const itemConfirmed = !!match?.confirmed;

  /* ---------- Eligibility (order data and SOP numbers only) ---------- */
  const checks: Check[] = [];
  let band: AuthorityBand | null = null;
  if (isVerified && match) {
    const o = match.order;
    const p = pack.policy;
    band = bandFor(p.authority, o.price);
    const inWindow = o.deliveredDaysAgo !== null && o.deliveredDaysAgo <= p.claimWindowDays;
    checks.push(
      {
        id: "window",
        label: `Inside ${p.claimWindowDays} days of delivery`,
        pass: inWindow,
        detail: o.deliveredDaysAgo === null ? "Not delivered yet" : `Delivered ${o.deliveredLabel}${o.deliveredDate ? ` (${o.deliveredDate})` : ""}`,
        sopRef: ref("Claim rules"),
      },
      { id: "stock", label: "Same item in stock", pass: o.inStock, detail: o.inStock ? (o.stockUnits ? `${o.stockUnits} units` : "In stock") : "Out of stock", sopRef: ref("Scenario A") },
      {
        id: "value",
        label: `Within agent authority (${money(p.authority[0].upTo ?? 0)})`,
        pass: band.agentCanApprove,
        detail: `${money(o.price)}: ${band.approver}`,
        sopRef: ref("Resolution authority"),
      },
      {
        id: "claims",
        label: `No earlier damage claim in ${p.repeatClaimWindowDays} days`,
        pass: customer.damageClaimsLast90Days === 0,
        detail: `${customer.damageClaimsLast90Days} earlier claim${customer.damageClaimsLast90Days === 1 ? "" : "s"}`,
        sopRef: ref("Scenario C"),
      },
      {
        id: "photo",
        label: "Can resolve before the photo arrives",
        pass: o.price < p.photoRequiredFrom,
        detail: o.price < p.photoRequiredFrom ? `Under ${money(p.photoRequiredFrom)}: photo within ${p.photoDays} days` : `${money(p.photoRequiredFrom)} or more: photo first`,
        sopRef: ref("Claim rules"),
      }
    );
  }
  // Scenario C triggers from the data. Out of stock is not one: it makes Scenario B apply.
  const failedChecks = checks.filter((c) => !c.pass && (c.id === "window" || c.id === "value" || c.id === "claims"));

  /* ---------- Escalation (Scenario C overrides A and B) ---------- */
  const safety = escalations.filter((e) => e.kind === "safety");
  const words = escalations.filter((e) => e.kind === "words");
  const escalate = escalations.length > 0 || failedChecks.length > 0;

  const lingerOver = lingerUntil !== null && now > lingerUntil;
  const identityFactor = lingerOver ? null : expecting === "name" ? name : expecting === "address" ? address : null;
  const awaiting: CopilotView["awaiting"] =
    locked || escalate
      ? null
      : identityFactor && identityFactor.state !== "ok"
        ? identityFactor.id
        : // The caller's next line may be the reply to a read-back: it waits for its check from the start, so a line that
          // already counted is never hidden later, when the line heard again (or said before the name answer's check
          // finished) turns out to be one (second and third reviews, 23 Oct).
          (openProbe || earlyReadBack) && name.state !== "ok"
          ? "name"
        : earlyAddrBack && address.state !== "ok"
          ? "address"
        : lowConfidenceChoice || (!choice && (choiceAsked || unreadChoice))
          ? "choice"
          : !intent
            ? "issue"
            : null;

  // A caller line after the choice that the second speech model is still checking, and that reads (as first
  // heard) as a different choice.
  const settledChoice = choice as CopilotView["choice"];
  const checkingChange = settledChoice
    ? corrected.find((l) => {
        const heard = readChoice(l.text)?.choice;
        return l.checking && l.side === "caller" && l.startedAt > settledChoice.evidence.at && !!heard && heard !== "both" && heard !== settledChoice.value;
      })
    : undefined;

  // A caller reply to the agent's read-back of a detail already verified, still being checked: it may reject the read-back
  // (his decision, 23 Oct 12:35), so nothing is approved until it settles. The same while the read-back line itself is
  // held for its check (an agent line after an approval), once the caller has replied to it.
  const checkingIdentity = locked
    ? undefined
    : (["name", "address"] as const)
        .flatMap((id) => [...backsSaid[id].flatMap((b) => backReply(b).filter((l) => l.checking)), ...heldBacks(id).flatMap(backReply)].filter((l) => verifiedBefore(id === "name" ? name : address, l)))
        .sort((x, y) => x.startedAt - y.startedAt)[0];

  /* ---------- Recommendation ---------- */
  let recommendation: Recommendation | null = null;
  if (escalate) {
    const reasons = [
      ...safety.map((e) => `Safety: the caller said "${e.phrase}".`),
      ...words.map((e) => `The caller mentioned "${e.phrase}".`),
      ...failedChecks.map((c) => `${c.label}: no (${c.detail}).`),
    ];
    const c = pack.sop.scenarios.find((s) => s.id === "C");
    recommendation = {
      scenario: "C",
      title: safety.length ? "Safety first, then escalate to Tier 2" : "Escalate to Tier 2",
      action: safety.length
        ? `Ask the customer to stop using and unplug the device, then escalate. Don't promise a replacement or refund. Open a Tier 2 case and transfer, or book a call back within ${pack.policy.escalationCallbackHours} business hours.`
        : `Don't promise a replacement or refund. Open a Tier 2 case and transfer, or book a call back within ${pack.policy.escalationCallbackHours} business hours.`,
      reasons,
      sopRef: ref("Scenario C"),
      evidence: [...new Map(escalations.map((e) => [e.ev.key, e.ev])).values()],
      // "Team Lead or Customer Care Manager. Agents can't approve." → the approver part only.
      approver: c?.authority.split(".")[0] ?? "Tier 2",
      agentCanApprove: false,
      approval: { state: "not-ready" },
    };
  } else if (isVerified && match && band && supported) {
    const o = match.order;
    const refund = choice?.value === "refund" || !o.inStock;
    const scenario = refund ? "B" : "A";
    const reasons = [
      `Delivered ${o.deliveredLabel}: inside the ${pack.policy.claimWindowDays}-day window.`,
      refund ? (o.inStock ? "The customer prefers a refund." : "The item is out of stock.") : `Same item in stock${o.stockUnits ? ` (${o.stockUnits} units)` : ""}.`,
      `${money(o.price)} is in the ${pack.sop.authority[band.row].range} band: ${band.approver}.`,
      ...(scenario === "A" ? [choice?.value === "replacement" ? "The customer chose a replacement." : "No preference stated, so replacement is the default."] : []),
    ];
    let prepared: Recommendation["prepared"];
    if (choice && choice.value !== "both" && itemConfirmed) {
      prepared =
        choice.value === "refund" || refund
          ? {
              kind: "refund",
              reference: pack.references.refund,
              lines: [
                `Full refund of ${money(o.price)} including shipping to ${o.payment ?? "the original payment method"}`,
                `Issued when the carrier scans the return; ${pack.policy.refundTiming} to appear`,
                "Prepaid return label by email",
              ],
            }
          : {
              kind: "replacement",
              reference: pack.references.replacement,
              lines: [
                `${o.shortName} at no charge; ${pack.policy.replacementShipping}`,
                `Prepaid return label by email; ${pack.policy.returnDays} days to send the damaged one back`,
                ...(o.price < pack.policy.photoRequiredFrom ? [`Photo of the damage requested within ${pack.policy.photoDays} days`] : []),
              ],
            };
    }
    recommendation = {
      scenario,
      alsoAllowed: scenario === "A" && !choice && askedBoth ? "B" : undefined,
      title: scenario === "A" ? (choice?.value === "replacement" ? "Replacement (customer's choice)" : "Replacement") : "Refund",
      action:
        scenario === "A"
          ? `Replace the ${o.shortName} at no charge; it ${pack.policy.replacementShipping}. Email a prepaid return label.`
          : `Refund ${money(o.price)} to ${o.payment ?? "the original payment method"} when the return is scanned. Email a prepaid return label.`,
      reasons,
      sopRef: ref(`Scenario ${scenario}`),
      evidence: [verifiedAt, match.evidence, choice?.evidence, askedBoth ?? undefined].filter((e): e is Evidence => !!e),
      approver: band.approver,
      agentCanApprove: band.agentCanApprove,
      authorityRow: band.row,
      prepared,
      approval: { state: prepared ? "awaiting" : "not-ready" },
    };
    if (prepared && !past) {
      const history: NonNullable<Recommendation["history"]> = [];
      // An approval counts only for the outcome it was given for, on what the copilot knew then: the
      // lines and checked results that had arrived, and the agent's corrections and choices so far. A
      // correction typed or a check finished later, a change of mind or an order found later all need a
      // fresh approval (outside review, 12 Oct). The first approval that holds is the one recorded.
      // Every approval given is kept in the history, with whether it counted and why not (call 8 review).
      // A spoken approval said while a Confirm press stood, and only heard because of it: once the press is
      // undone this pass no longer hears it, so it is found in the pass just before the undo and kept in the
      // history as not counted, rather than disappearing (Step 5 check, 13 Oct).
      const withdrawn: GivenApproval[] = [];
      for (const u of undone) {
        const before = rules(pack, asOf(lines, u.undoneAt, true), allActions.filter((x) => x.at < u.undoneAt), u.undoneAt, hints, true);
        for (const g of givenIn.get(before) ?? []) {
          const known = (x: GivenApproval) => x.at === g.at && x.via === g.via;
          if (g.via === "call" && g.at >= u.confirmedAt && !given.some(known) && !withdrawn.some(known)) withdrawn.push(g);
        }
      }
      // Which approval came first is decided by when the panel could accept it: the press, or when the line's
      // text reached the copilot (its checked text, if it went to the second model). A spoken line checked
      // after a press no longer takes the credit back from the press the panel already showed as approved
      // (Call 13 Card A, outside review 6.2). Whether each one holds is still judged at its own `at`, as before.
      const acceptedAt = (g: GivenApproval) => g.evidence?.knownAt ?? g.at;
      for (const a of [...given, ...withdrawn, ...refused].sort((x, y) => acceptedAt(x) - acceptedAt(y))) {
        // The note under the card still names the latest one not counted by when it was given, as before.
        const latest = !(recommendation.staleApproval && recommendation.staleApproval.at > a.at);
        const refusal = refused.find((r) => r === a);
        if (refusal || withdrawn.includes(a)) {
          const reason = refusal?.reason ?? "a confirmation it relied on was undone";
          if (recommendation.approval.state !== "approved" && latest) recommendation.staleApproval = { at: a.at, via: a.via, evidence: a.evidence, reason, ...(refusal ? { refused: true } : {}) };
          history.push({ at: a.at, via: a.via, evidence: a.evidence, counted: false, reason });
          continue;
        }
        const then = rules(pack, asOf(lines, a.at), allActions.filter((x) => x.at <= a.at), a.at, hints, true);
        const r = then.recommendation;
        const changedSince = choiceChanges.some((t) => t > a.at);
        // A Confirm press the approval relied on was taken back after it: confirming again doesn't revive it.
        const undoneSince = undone.some((u) => u.confirmedAt <= a.at && u.undoneAt > a.at);
        const fell = identityFalls.find((f) => {
          const factor = f.id === "name" ? name : address;
          const again = factor.state === "ok" && Math.max(factor.evidence?.at ?? 0, factor.confirmedBy?.at ?? 0) > f.said && (factor.knownAt ?? Infinity) <= a.at;
          return f.at > a.at && !again;
        });
        const fellSince = !!fell;
        const holds = !changedSince && !undoneSince && !fellSince && !!r?.prepared && r.scenario === scenario && r.prepared.kind === prepared.kind && then.order.match?.order.id === o.id;
        const first = recommendation.approval;
        // Said before the approval that counted but available only after it: one that holds says why it
        // didn't count; one that doesn't hold keeps its own reason, as it had before this ordering.
        const overtaken = first.state === "approved" && a.at < first.at!;
        if (first.state === "approved" && (!overtaken || holds)) {
          history.push({ ...a, counted: false, reason: overtaken ? `already approved ${first.via === "panel" ? "in the panel" : "on the call"} before this line's text arrived` : "already approved" });
          continue;
        }
        if (holds) {
          recommendation.approval = { state: "approved", ...a, by: `${pack.agent.name} (${pack.agent.id})` };
          recommendation.staleApproval = undefined;
          history.push({ ...a, counted: true });
          continue;
        }
        const covered = notCovered(then, prepared.kind, o.id);
        const reason = undoneSince
          ? "a confirmation it relied on was undone"
          : fellSince && then.verification.verified
            ? fell?.reason ?? "the caller's answer it relied on was corrected after it"
            : changedSince && covered === "the outcome has changed since"
            ? "the customer changed their choice after it"
            : covered;
        if (first.state !== "approved" && latest) recommendation.staleApproval = { ...a, reason };
        history.push({ ...a, counted: false, reason });
      }
      if (recommendation.approval.state === "awaiting" && unheardApproval?.value === prepared.kind && choice && unheardApproval.ev.at > choice.evidence.at) {
        recommendation.unheardApproval = unheardApproval.ev;
      }
      if (lowConfidenceChoice) {
        // A possible change of mind: nothing is approved until the agent confirms what the customer wants.
        // Words that never counted are no approval to hold: their note stays as it is.
        const held = recommendation.approval.state === "approved" ? recommendation.approval : recommendation.staleApproval?.refused ? undefined : recommendation.staleApproval;
        recommendation.approval = { state: "not-ready" };
        if (held?.at !== undefined && held.via) {
          recommendation.staleApproval = { at: held.at, via: held.via, evidence: held.evidence, reason: "the customer may have changed their mind" };
        }
      } else if (checkingChange) {
        // A caller line that may change the choice is still with the second speech model: the approval is
        // on hold until its checked text arrives, then stands or falls by the usual rules (call 8 review).
        // Nothing can be approved meanwhile, given or not (Call 11 review, I-22).
        const held = recommendation.approval.state === "approved" ? recommendation.approval : null;
        recommendation.approval = { state: "not-ready" };
        recommendation.checkingChoice = evidenceOf(checkingChange);
        if (held)
          recommendation.suspended = {
            at: held.at!,
            via: held.via!,
            evidence: evidenceOf(checkingChange),
            reason: "a possible change of choice is being checked",
            ...(held.evidence ? { heard: held.evidence } : {}),
          };
      } else if (checkingIdentity) {
        // The caller's reply to a read-back of a detail already verified is still with the second speech model: it may
        // reject the read-back, so the approval is on hold until its checked text arrives, then stands or falls (his
        // decision, 23 Oct 12:35: wait for the complete reply).
        const held = recommendation.approval.state === "approved" ? recommendation.approval : null;
        recommendation.approval = { state: "not-ready" };
        recommendation.checkingIdentity = evidenceOf(checkingIdentity);
        if (held)
          recommendation.suspended = {
            at: held.at!,
            via: held.via!,
            evidence: evidenceOf(checkingIdentity),
            reason: "the caller's reply to your read-back is being checked",
            ...(held.evidence ? { heard: held.evidence } : {}),
          };
      }
      if (history.length) recommendation.history = history;
    } else if (!past && (given.length || refused.length)) {
      // Nothing is prepared, so nothing can be approved: say why at once, rather than only once the item
      // is read back (Call 11 review, I-24). "Done." before the read-back used to show no reason at all.
      const missing = !itemConfirmed ? "the item wasn't confirmed with the caller yet" : "the customer's choice wasn't known yet";
      // Given while a Confirm press stood that is now undone: say so, as the history does once the item is confirmed again.
      const reasonFor = (a: GivenApproval) => (undone.some((u) => u.confirmedAt <= a.at && u.undoneAt > a.at) ? "a confirmation it relied on was undone" : missing);
      const history = [...given.map((a) => ({ ...a, reason: reasonFor(a) })), ...refused].sort((x, y) => x.at - y.at).map((a) => ({ ...a, counted: false }));
      const last = history[history.length - 1];
      const lastRefused = refused.some((r) => r.at === last.at && r.via === last.via);
      recommendation.staleApproval = { at: last.at, via: last.via, evidence: last.evidence, reason: last.reason, ...(lastRefused ? { refused: true } : {}) };
      recommendation.history = history;
    }
    // The transcript note for a line whose approval words didn't count says so, and why.
    for (const h of recommendation.history ?? []) {
      const check = h.evidence && !h.counted && agentChecks.find((c) => c.key === h.evidence!.key);
      if (check && check.reason === "approval heard in this line") check.reason = `approval words heard, not counted: ${h.reason}`;
    }
  }

  /* ---------- Alerts ---------- */
  const alerts: Alert[] = [];
  if (earlyOffers.length) {
    alerts.push({
      id: "offer-before-verification",
      level: "warning",
      title: "Resolution offered before identity check",
      detail: "Verify first; don't commit yet.",
      sopRef: ref("Verification"),
      evidence: earlyOffers,
      resolved: verifiedKnownAt ? `Identity verified at ${clock(verifiedKnownAt)}.` : undefined,
    });
  }
  if (safety.length) {
    alerts.push({
      id: "safety",
      level: "danger",
      title: `Safety report: "${safety[0].phrase}"`,
      detail: "Ask the customer to stop using and unplug the device, then escalate.",
      sopRef: ref("Scenario C"),
      evidence: safety.map((e) => e.ev),
    });
  }
  if (words.length) {
    alerts.push({
      id: "escalation-words",
      level: "danger",
      title: `Escalation: caller mentioned "${words[0].phrase}"`,
      detail: "Don't promise a resolution. Open a Tier 2 case.",
      sopRef: ref("Scenario C"),
      evidence: words.map((e) => e.ev),
    });
  }
  for (const c of failedChecks) {
    alerts.push({ id: `check-${c.id}`, level: "danger", title: `${c.label}: no`, detail: `${c.detail}. Escalate to Tier 2.`, sopRef: ref("Scenario C"), evidence: [] });
  }
  if (offersInEscalation.length) {
    alerts.push({
      id: "offer-during-escalation",
      level: "danger",
      title: "Resolution offered while Scenario C applies",
      detail: "Don't promise a replacement or refund.",
      sopRef: ref("Scenario C"),
      evidence: offersInEscalation,
    });
  }
  if (locked) {
    const failed = [name, address].find((f) => f.attempts >= pack.policy.maxVerificationAttempts);
    alerts.push({
      id: "verification-locked",
      level: "danger",
      title: "Identity not verified after two attempts",
      detail: "Don't discuss the order. Offer a call back to the phone number on the order, and log the attempt.",
      sopRef: ref("Verification"),
      evidence: failed?.evidence ? [failed.evidence] : [],
    });
  } else {
    for (const f of [name, address]) {
      if (f.state === "failed") {
        alerts.push({
          id: `verification-failed-${f.id}`,
          level: "warning",
          title: `${f.label}: not matched (attempt ${f.attempts} of ${pack.policy.maxVerificationAttempts})`,
          // After a wrong answer the caller gives the detail again, or (address) the email on the order instead; the
          // order's own details are never read to them (his choice, 23 Oct: "Back to before").
          detail: `${attemptsLeft === 1 ? "One attempt left" : `${attemptsLeft} attempts left`}. Don't say which detail didn't match. Ask the caller to give ${
            f.id === "name" ? "their full name again" : "the street and city again, or the email address on the order instead"
          }; don't read the order's details to them.`,
          sopRef: ref("Verification"),
          evidence: f.evidence ? [f.evidence] : [],
        });
      }
    }
  }
  if (disclosures.length) {
    alerts.push({
      id: "disclosed-factor",
      level: "warning",
      title: "The failed detail was named to the caller",
      detail: "Don't say which detail didn't match.",
      sopRef: ref("Verification"),
      evidence: disclosures,
    });
  }

  /* ---------- Please-confirm prompts (low confidence never ticks a step) ---------- */
  // Whether saying the name back counts now (see Policy.nameReadBack and the agent branch above).
  // Waiting ends READ_BACK_REPLY_MS after the question: silence isn't a refusal, but a yes after that never counts.
  const readBackUntil = readBack ? (readBack as { endedAt: number }).endedAt + READ_BACK_REPLY_MS : undefined;
  // A reply that started in time and is still being checked: the wait lasts as long as the check, never "expired".
  if (
    readBackUntil !== undefined &&
    corrected.some((l) => l.checking && l.side === "caller" && l.startedAt >= readBackUntil - READ_BACK_REPLY_MS - READ_BACK_OVERLAP_MS && l.startedAt <= readBackUntil)
  )
    readBackHeld = true;
  // Also once the agent has gone on talking, while a reply said in time is still being checked.
  if (!locked && name.state !== "ok" && nameReplyOpen(now) && !openProbe) readBackHeld = true;
  // A read-back said while a reply to an earlier one is still being checked (either detail) wouldn't count, so the
  // offer waits until that check lands (review, 23 Oct).
  const replyCheckingNow = [...readBacksSeen, ...addrBacksSeen].some((b) => replyTo(b).some((l) => l.checking));
  const readBackState: ReadBackState =
    !pack.policy.nameReadBack || locked || name.attempts > 0
      ? "off"
      : readBackRefused
        ? "refused"
        : readBackHeld || openProbe || (readBackUntil !== undefined && now <= readBackUntil) || (earlySaid.name && answerChecking("name", now))
          ? "waiting"
          : readBackUntil !== undefined || !readBackLeft("name")
            ? "expired"
            : providedWhole(name) && !replyCheckingNow && !addrHeld
              ? "available"
              : "off";
  const probed = openProbe as TranscriptEvent | null;
  const probeWhich = probed ? (ordered.some((l) => l.side === "agent" && l.startedAt > probed.startedAt) ? ("earlier" as const) : ("last" as const)) : undefined;
  // The name card leads with what to do: reading a diagnosis first cost about 3 s on the 21 Oct stage call.
  const nameAction =
    readBackState === "available" && nameRepeatOpen
      ? "The caller asked to hear it again: say the same read-back once more and wait for a plain yes, or type it (N)."
      : readBackState === "available"
      ? "Say back the full name you heard and wait for the caller's yes (it counts only if it is the name on the order), or type what the caller said (N)."
      : readBackState === "waiting" && openProbe
        ? `Checking your ${probeWhich ?? "last"} line with the second model in case it was the name read-back. You can type what the caller said (N).`
        : readBackState === "waiting" && earlySaid.name && answerChecking("name", now)
          ? "Your read-back counts once the rest of the caller's answer is checked. You can type what the caller said (N)."
        : readBackState === "waiting"
          ? "Wait for the caller's yes to your read-back, or type what the caller said (N)."
          : readBackState === "expired"
            ? readBackLeft("name")
              ? `No reply to your read-back within ${READ_BACK_REPLY_MS / 1000} s, so a yes now won't count. Say it back once more (the last time it counts), ask for the full name again, or type it (N).`
              : `No reply to your read-back within ${READ_BACK_REPLY_MS / 1000} s, so a yes now won't count, and reading the name back again won't count on this call. Ask for the full name again, or type it (N).`
            : "Type what the caller said (N), or ask again.";
  // The same for the street and city (Policy.addressReadBack).
  const addrUntil = addrBack ? (addrBack as { endedAt: number }).endedAt + READ_BACK_REPLY_MS : undefined;
  if (
    addrUntil !== undefined &&
    corrected.some((l) => l.checking && l.side === "caller" && l.startedAt >= addrUntil - READ_BACK_REPLY_MS - READ_BACK_OVERLAP_MS && l.startedAt <= addrUntil)
  )
    addrHeld = true;
  if (!locked && address.state !== "ok" && addressReplyOpen(now)) addrHeld = true;
  const addrState: ReadBackState =
    !pack.policy.addressReadBack || locked || address.attempts > 0
      ? "off"
      : addrRefused
        ? "refused"
        : addrHeld || (addrUntil !== undefined && now <= addrUntil) || (earlySaid.address && answerChecking("address", now))
          ? "waiting"
          : addrUntil !== undefined || !readBackLeft("address")
            ? "expired"
            : providedWhole(address) && !replyCheckingNow && !readBackHeld && !openProbe
              ? "available"
              : "off";
  const addrAction =
    addrState === "available" && addrRepeatOpen
      ? "The caller asked to hear it again: say the same street and city once more and wait for a plain yes, or type what the caller said (A)."
      : addrState === "available"
        ? "Say back the street and city you heard as one question and wait for the caller's yes (it counts only if it is the order's street and city word for word), or type what the caller said (A)."
        : addrState === "waiting" && earlySaid.address && answerChecking("address", now)
          ? "Your read-back counts once the rest of the caller's answer is checked. You can type what the caller said (A)."
        : addrState === "waiting"
          ? "Wait for the caller's yes to your read-back, or type what the caller said (A)."
          : addrState === "expired"
            ? readBackLeft("address")
              ? `No reply to your read-back within ${READ_BACK_REPLY_MS / 1000} s, so a yes now won't count. Say it back once more (the last time it counts), ask for the street and city again, or type them (A).`
              : `No reply to your read-back within ${READ_BACK_REPLY_MS / 1000} s, so a yes now won't count, and reading the address back again won't count on this call. Ask for the street and city again, or type them (A).`
            : "Type what the caller said (A), or ask again.";
  for (const f of [name, address]) {
    if (f.state === "confirm" && f.evidence && f.confirmReason === "after-read-back" && !locked) {
      const what = f.id === "name" ? "the name" : "the street and city";
      prompts.push({
        target: f.id,
        askAgain: true,
        text: `Heard "${f.heard ?? f.evidence.text}" only after you said ${what} on the order yourself, so it doesn't verify ${what} by itself. Type ${
          f.id === "name" ? "the name (N)" : "the street and city (A)"
        } only if the caller said it before you did; otherwise offer a call back to the phone number on the order.`,
        evidence: f.evidence,
      });
      continue;
    }
    if (f.state === "confirm" && f.evidence && f.id === "address" && addrRefused) {
      // After a refused read-back, as for the name: neither another read-back nor the Confirm button counts.
      const newer = f.evidence.at > addrRefused.ev.at;
      prompts.push({
        target: "address",
        askAgain: true,
        text: newer
          ? `Address not recognised. Type what the caller said (A), or ask again. Heard "${f.heard ?? f.evidence.text}". The read-back wasn't confirmed earlier, so reading it back or pressing Confirm won't count on this call.`
          : addrRefused.recovery === "ask"
            ? `Read-back not confirmed: the caller's reply "${addrRefused.ev.typedFrom ?? addrRefused.ev.text}" doesn't count, because ${addrRefused.why}. Ask for the street and city again, and type the new answer (A) only if it still isn't recognised. Reading the address back again won't count on this call.`
            : `Read-back not confirmed: the caller's reply "${addrRefused.ev.typedFrom ?? addrRefused.ev.text}" doesn't count, because ${addrRefused.why}. If you clearly heard the caller give their street and city and say yes, type them (A); otherwise ask again. Reading the address back again won't count on this call.`,
        evidence: newer ? f.evidence : addrRefused.ev,
      });
      continue;
    }
    if (f.state === "confirm" && f.evidence && f.id === "address" && addrState !== "off") {
      // The card leads with the read-back, as for the name; the agent can still confirm a sound-alike they heard clearly.
      const heard = f.heard ?? f.evidence.text;
      prompts.push({
        target: "address",
        askAgain: !confirmable(f) || repeatUsed.address || undefined,
        text: `Address not recognised. ${addrAction} Heard "${heard}".${addrState === "available" && confirmable(f) && !repeatUsed.address ? " If you heard it clearly, you can confirm instead (recorded as confirmed by you)." : ""}`,
        evidence: f.evidence,
      });
      continue;
    }
    if (f.state === "confirm" && f.evidence && f.id === "name" && readBackRefused) {
      // After a refused read-back, typing is the way on: neither another read-back nor the Confirm button counts.
      const newer = f.evidence.at > readBackRefused.ev.at;
      prompts.push({
        target: "name",
        askAgain: true,
        text: newer
          ? `Name not recognised. Type what the caller said (N), or ask again. Heard "${f.heard ?? f.evidence.text}". The read-back wasn't confirmed earlier, so reading it back or pressing Confirm won't count on this call.`
          : readBackRefused.recovery === "ask"
            ? `Read-back not confirmed: the caller's reply "${readBackRefused.ev.typedFrom ?? readBackRefused.ev.text}" doesn't count, because ${readBackRefused.why}. Ask for the full name again, and type the new answer (N) only if it still isn't recognised. Reading the name back again won't count on this call.`
            : `Read-back not confirmed: the caller's reply "${readBackRefused.ev.typedFrom ?? readBackRefused.ev.text}" doesn't count, because ${readBackRefused.why}. If you clearly heard the caller give their name and say yes, type the name (N); otherwise ask for the full name again. Reading the name back again won't count on this call.`,
        evidence: newer ? f.evidence : readBackRefused.ev,
      });
    } else if (f.state === "confirm" && f.evidence && f.id === "name" && (readBackState === "waiting" || readBackState === "expired" || repeatUsed.name)) {
      // Said back: the card says what the read-back is waiting for, or that the wait is over. After a "Sorry?", the
      // Confirm button no longer counts, so the card doesn't offer it.
      prompts.push({
        target: "name",
        askAgain: !confirmable(f) || repeatUsed.name || undefined,
        text: `Name not recognised. ${nameAction} Heard "${f.heard ?? f.evidence.text}".`,
        evidence: f.evidence,
      });
    } else if (f.state === "confirm" && f.evidence && f.id === "name") {
      const heard = f.heard ?? f.evidence.text;
      prompts.push({
        target: "name",
        askAgain: !confirmable(f) || undefined,
        text:
          !confirmable(f) && (f.confirmReason === "low-confidence" || f.confirmReason === "garbled")
            ? `Name not recognised. ${nameAction} Heard "${heard}"${f.confirmReason === "garbled" ? ", which looks garbled (the same words repeated)" : " with low confidence"}, and it doesn't match the name on the order. Typed words are checked against the order.`
            : f.confirmReason === "disagree"
            ? `Name not recognised. ${nameAction} Heard "${f.heard}", first heard as "${f.evidence.firstHeard}": the two speech models disagree, so it isn't counted as a wrong answer.`
            : f.confirmReason === "ambiguous"
            ? `Ask for the full name once more. Heard "${f.heard}": it names more than one name, or denies part of one, so it isn't counted either way.`
            : f.confirmReason === "sounds-like"
            ? `Name unclear. Confirm if you heard it clearly, or ${nameAction[0].toLowerCase()}${nameAction.slice(1)} Heard "${f.heard}": it sounds like the name on the order but isn't a clear match.`
            : f.confirmReason === "garbled"
              ? `Name unclear. Confirm if you heard it clearly, or ${nameAction[0].toLowerCase()}${nameAction.slice(1)} Heard "${f.heard}", which looks garbled (the same words repeated).`
              : `Name unclear. Confirm if you heard it clearly (recorded as confirmed by you), or ${nameAction[0].toLowerCase()}${nameAction.slice(1)} Heard "${heard}" with low confidence.`,
        evidence: f.evidence,
      });
    } else if (f.state === "confirm" && f.evidence) {
      const what = f.id === "name" ? "name" : "address";
      prompts.push({
        target: f.id,
        askAgain: !confirmable(f) || undefined,
        text:
          !confirmable(f) && (f.confirmReason === "low-confidence" || f.confirmReason === "garbled")
            ? `Heard "${f.heard ?? f.evidence.text}"${f.confirmReason === "garbled" ? ", which looks garbled (the same words repeated)" : " with low confidence"}, and it doesn't match the ${what} on the order. Ask the caller to repeat it, or type what they said; typed words are checked against the order.`
            : f.confirmReason === "disagree"
            ? `Heard "${f.heard}", first heard as "${f.evidence.firstHeard}". The two speech models disagree, so this isn't counted as a wrong answer. Ask the caller to repeat it, or type what they said.`
            : f.confirmReason === "ambiguous"
            ? `Heard "${f.heard}". It names more than one ${f.id === "name" ? "name" : "address"}, or denies part of one, so it isn't counted either way. Ask for the ${f.id === "name" ? "full name" : "street and city"} once more.`
            : f.confirmReason === "sounds-like"
            ? `Heard "${f.heard}". It sounds like the ${f.id === "name" ? "name" : "address"} on the order but isn't a clear match. Ask the caller to repeat it, or confirm if you heard it clearly.`
            : f.confirmReason === "garbled"
              ? `Heard "${f.heard}", which looks garbled (the same words repeated). Ask the caller to repeat it, or confirm if you heard it clearly.`
              : `Heard "${f.heard ?? f.evidence.text}" with low confidence. Ask the caller to repeat it, or confirm if you heard it clearly; it is recorded as confirmed by you.`,
        evidence: f.evidence,
      });
    } else if (f.state === "partial" && f.evidence && !locked && pending?.factor !== f) {
      // The caller has finished and only part of the answer matched: never a failed attempt, nothing to confirm.
      prompts.push({
        target: f.id,
        text:
          f.id === "name"
            ? `Ask for the full name again, without saying which part didn't match. Heard "${f.heard}", which matches only part of the name on the order.`
            : `Heard "${f.heard}", which matches only part of the address on the order. Ask for the street and city again, without saying which part didn't match.`,
        evidence: f.evidence,
        askAgain: true,
      });
    }
  }
  if (match && match.needsConfirmation && !match.confirmed) {
    prompts.push({ target: "order", text: `${match.note} Read the order number back to the caller.`, evidence: match.evidence });
  } else if (match && !match.confirmed && choice && !escalate) {
    // Everything else is ready: the item read-back is what approval waits for.
    prompts.push({
      target: "order",
      text: `The item hasn't been confirmed with the caller. Read back order ${match.order.id}, the ${match.order.shortName}, before approving. If you already did and the transcript missed it, confirm here.`,
      evidence: match.evidence,
    });
  }
  if (lowConfidenceChoice) {
    prompts.push({ target: "choice", text: `Heard "${lowConfidenceChoice.text}" with low confidence. Confirm what the customer wants.`, evidence: lowConfidenceChoice });
  } else if (unreadChoice && !escalate && isVerified) {
    // Before identity is verified the identity prompt comes first; the choice waits.
    prompts.push({
      target: "choice",
      text: `Heard "${unreadChoice.text}"${unreadChoice.lowConfidence ? " with low confidence" : ""}, which isn't a choice. Ask the customer again: replacement or refund?`,
      evidence: unreadChoice,
      askAgain: true,
    });
  }
  if (intent?.certainty === "low" && intent.evidence[0]) {
    prompts.push({
      target: "issue",
      text:
        intent.source === "model"
          ? `The local model suggests "${intent.label}", but no rule found it in the caller's words. Ask the caller what happened, then choose what they said.`
          : causedAfter && intent.id === "damaged"
            ? `The caller said "${causedAfter.phrase}". Damage after delivery isn't covered by ${sopId}. Ask whether it arrived damaged, then choose what they said.`
            : !intent.phrases.length && damageAnswer
              ? `The caller said "${damageAnswer.answer.text}" to "${damageAnswer.question.text}", but hasn't said it arrived damaged. Ask what happened, then choose what they said.`
              : `The issue was heard with low certainty ("${intent.phrases[0]}"). Confirm the damage with the caller.`,
      evidence: causedAfter && intent.id === "damaged" ? causedAfter.ev : intent.evidence[0],
    });
  } else if (!escalate && !locked && ((intent && !supported) || (!intent && isVerified))) {
    // Nothing to offer under this SOP until the problem is established as damage on arrival.
    prompts.push({
      target: "issue",
      text: intent
        ? `"${intent.label}" isn't covered by ${sopId}, so don't offer a replacement or refund. Ask the caller what happened; if the item arrived damaged, choose that.`
        : `The caller's problem isn't in the transcript. Ask what happened to the item before offering anything, then choose what they said.`,
      evidence: intent?.evidence[0],
      askAgain: true,
    });
  }

  /* ---------- Where the agent types the caller's name ---------- */
  // From the moment the caller's answer arrives, while the second speech model still checks it, unless the fast
  // model already heard a clear match. A typed answer replaces the line and a late check can't overwrite it.
  let nameEntry: CopilotView["nameEntry"] = null;
  if (name.state !== "ok") {
    const asked = nameAsk as Evidence | null;
    const checkingAnswer =
      asked && !readBack
        ? [...corrected].reverse().find((l) => l.checking && l.side === "caller" && l.startedAt > asked.at && l.startedAt < nameAskEnds && matchName(l.text, customer) !== "match")
        : undefined;
    const extra = {
      ...(readBackState === "waiting" && !readBackHeld && readBackUntil !== undefined ? { readBackUntil } : {}),
      ...(readBackState === "refused" && readBackRefused ? { readBackRecovery: (readBackRefused as { recovery: "ask" | "type" }).recovery } : {}),
      ...(readBackState === "waiting" && probeWhich ? { readBackProbe: probeWhich } : {}),
      ...(readBackState === "available" && nameRepeatOpen ? { readBackRepeat: true as const } : {}),
    };
    if (checkingAnswer) nameEntry = { key: checkingAnswer.key, checking: true, readBack: readBackState, ...extra };
    // Not on an answer from before the agent asked again: typing there would rewrite a failed attempt (independent review).
    else if (name.evidence?.side === "caller" && (!asked || name.evidence.at > asked.at)) nameEntry = { key: name.evidence.key, checking: false, readBack: readBackState, ...extra };
  }

  /* ---------- Where the agent types the street and city ---------- */
  // The same as the name field, once the name is verified: from the moment the caller's answer arrives, unless the
  // fast model already heard a clear match. Never while identity is locked after too many failed attempts.
  let addressEntry: CopilotView["addressEntry"] = null;
  if (name.state === "ok" && address.state !== "ok" && !locked) {
    const asked = addressAsk as Evidence | null;
    const checkingAnswer =
      asked
        ? [...corrected].reverse().find((l) => l.checking && l.side === "caller" && l.startedAt > asked.at && l.startedAt < addressAskEnds && matchAddress(l.text, customer) !== "match")
        : undefined;
    const extra = pack.policy.addressReadBack
      ? {
          readBack: addrState,
          ...(addrState === "waiting" && !addrHeld && addrUntil !== undefined ? { readBackUntil: addrUntil } : {}),
          ...(addrState === "refused" && addrRefused ? { readBackRecovery: (addrRefused as { recovery: "ask" | "type" }).recovery } : {}),
          ...(addrState === "available" && addrRepeatOpen ? { readBackRepeat: true as const } : {}),
        }
      : {};
    if (checkingAnswer) addressEntry = { key: checkingAnswer.key, checking: true, ...extra };
    else if (address.evidence?.side === "caller" && (!asked || address.evidence.at > asked.at)) addressEntry = { key: address.evidence.key, checking: false, ...extra };
  }

  /* ---------- SOP steps ---------- */
  const factorStep = (f: Factor): StepStatus =>
    locked && f.state !== "ok" ? "blocked" : f.state === "ok" ? "done" : f.state === "confirm" || f.state === "failed" || f.state === "partial" ? "attention" : f.state === "asking" ? "active" : "pending";
  const factorDetail = (f: Factor) =>
    f.state === "failed" ? `Not matched (${f.attempts})` : f.state === "confirm" ? "Please confirm" : f.state === "asking" && f.heard ? "Listening…" : undefined;
  const approved = recommendation?.approval.state === "approved";
  const steps: SopStep[] = [
    {
      id: "issue",
      label: "Identify the issue",
      status: !intent ? "pending" : supported ? "done" : "attention",
      detail: intent ? (intent.sopId ? intent.label : `${intent.label}: no SOP`) : undefined,
      evidence: intent?.evidence[0],
      sopRef: sopId,
    },
    { id: "name", label: "Verify: full name", status: factorStep(name), detail: name.state === "ok" && name.method ? byMethod(name.method) : factorDetail(name), evidence: name.evidence, sopRef: ref("Verification") },
    {
      id: "address",
      label: "Verify: email, or street and city",
      status: factorStep(address),
      detail: address.state === "ok" && address.method ? byMethod(address.method) : factorDetail(address),
      evidence: address.evidence,
      sopRef: ref("Verification"),
    },
    {
      id: "order",
      label: "Locate the order",
      status: !isVerified ? (locked ? "blocked" : "pending") : !match ? "pending" : orderLocated ? "done" : "attention",
      detail: !isVerified ? (order.heard ? `Heard ${order.heard.reading}; locked until identity check` : "Locked until identity check") : match ? `#${match.order.id}` : order.state === "unmatched" ? "No match in this customer's orders" : undefined,
      evidence: match?.evidence ?? order.heard?.evidence,
      sopRef: ref("Verification"),
    },
    {
      id: "confirm",
      label: "Confirm the item and the damage",
      // Reading the order number back confirms the item, not the damage (both ticked it on 11 Oct).
      status: match?.confirmed && supported ? "done" : match?.confirmed ? "attention" : "pending",
      detail: match?.confirmed
        ? `${match.confirmedBy === "panel" ? "Item confirmed by the agent" : "Order read back"}; ${supported ? `damage ${damageSource}` : "damage not confirmed"}`
        : undefined,
      evidence: damageAnswer?.answer ?? (typeof match?.confirmedBy === "object" ? match.confirmedBy : undefined),
      sopRef: ref("Claim rules"),
    },
    {
      id: "eligibility",
      label: "Check window, stock, value and earlier claims",
      status: !checks.length ? "pending" : failedChecks.length ? "blocked" : "done",
      detail: checks.length ? (failedChecks.length ? "Escalate: Scenario C" : "All checks pass") : undefined,
      sopRef: ref("Claim rules"),
    },
    {
      id: "choice",
      label: "Customer's choice",
      status: escalate ? "skipped" : choice && lowConfidenceChoice ? "attention" : choice ? "done" : unreadChoice && isVerified ? "attention" : "pending",
      detail: escalate
        ? "Not offered: Scenario C"
        : choice
          ? `${choice.value === "replacement" ? "Replacement" : "Refund"}${lowConfidenceChoice ? "; may have changed, confirm" : ""}`
          : unreadChoice && isVerified
            ? "Answer not understood; ask again"
            : askedBoth
              ? "Asked about both"
              : undefined,
      evidence: choice?.evidence ?? unreadChoice ?? askedBoth ?? undefined,
      sopRef: ref("Scenario A and B"),
    },
    {
      id: "approval",
      label: escalate ? "Escalate to Tier 2" : "Agent approval",
      status: escalate ? "pending" : approved ? "done" : recommendation?.suspended ? "attention" : "pending",
      detail: approved
        ? recommendation?.approval.via === "call"
          ? "Confirmed on the call"
          : "Approved in the panel"
        : recommendation?.suspended
          ? recommendation.checkingIdentity
            ? "On hold: checking the caller's reply to your read-back"
            : "On hold: checking a possible change of choice"
          : undefined,
      evidence: recommendation?.approval.evidence,
      sopRef: ref("Resolution authority"),
    },
    { id: "docs", label: "Documentation", status: approved ? "done" : "pending", sopRef: ref("Required documentation") },
  ];
  if (ordered.length) {
    const current = steps.find((s) => s.status !== "done" && s.status !== "skipped");
    if (current && current.status === "pending") current.status = "active";
  }

  /* ---------- Suggested reply (rules templates; wording only) ---------- */
  const o = match?.order;
  const reply = (text: string, section: string, rewordable = false) => ({ text, sopRef: ref(section), basis: "rules" as const, rewordable });
  const neutral = (text: string, section: string) => reply(text, section, true);
  let suggestedReply: CopilotView["suggestedReply"] = null;
  let termRecord: { label: string; said: boolean; evidence?: Evidence; saidInstead?: string; corrected?: string }[] = [];
  if (locked) {
    suggestedReply = reply("For your security I can't discuss the order on this call. I can arrange a call back to the phone number on the order.", "Verification");
  } else if (safety.length) {
    suggestedReply = reply(
      `For your safety, please stop using the ${o?.noun ?? "device"} and unplug it. I'm passing this to a senior colleague now, and if we get cut off they'll call you back within ${pack.policy.escalationCallbackHours} business hours.`,
      "Scenario C"
    );
  } else if (escalate) {
    suggestedReply = reply(
      `I understand, and I want this handled properly. I'm opening a case with a senior colleague who can review it. I can transfer you now, or they can call you back within ${pack.policy.escalationCallbackHours} business hours.`,
      "Scenario C"
    );
  } else if (intent || earlyOffers.length || isVerified) {
    if (name.state === "failed" || address.state === "failed") {
      suggestedReply = neutral("I wasn't able to match those details. Could you check them and try once more?", "Verification");
    } else if (name.state === "confirm") {
      suggestedReply = neutral("Sorry, could you say your full name once more?", "Verification");
    } else if (name.state === "partial") {
      suggestedReply = neutral("Thank you. And your last name, please?", "Verification");
    } else if (name.state === "idle") {
      suggestedReply = neutral(
        earlyOffers.length
          ? "Before I arrange anything, I need to check a couple of details. Can I have your full name, please?"
          : "I'm sorry to hear that. Before I look at the order, can I have your full name, please?",
        "Verification"
      );
    } else if (name.state === "ok" && address.state === "idle") {
      suggestedReply = neutral("Thank you. And the email address on the order, or the street and city for the delivery?", "Verification");
    } else if (address.state === "partial" || address.state === "confirm") {
      suggestedReply = neutral("Sorry, could you give me the street and the city once more?", "Verification");
    } else if (isVerified && !match) {
      suggestedReply = reply(`Thanks, ${firstName}, you're verified. Could you give me the order number, please?`, "Verification");
    } else if (isVerified && o && match && !orderLocated) {
      suggestedReply = reply(`Thanks, ${firstName}, you're verified. Just to confirm, is it order ${o.id}, the ${o.shortName} delivered ${o.deliveredLabel}?`, "Verification");
    } else if (isVerified && o && !supported) {
      suggestedReply = reply(`Thanks, ${firstName}, you're verified. Can you tell me what's wrong with the ${o.noun}?`, "Claim rules");
    } else if (isVerified && o && match && !match.confirmed && !choice && !askedBoth) {
      suggestedReply = reply(
        `Thanks, ${firstName}, you're verified. I can see the ${o.shortName} on order ${o.id}, delivered ${o.deliveredLabel}. I can ship a replacement today at no cost, with a free return label for the damaged one, or give you a full refund if you'd prefer.`,
        "Scenario A"
      );
    } else if (o && !choice && unreadChoice) {
      suggestedReply = reply(`Sorry, I didn't catch that. Would you like the new ${o.noun}, or the refund?`, "Scenario A and B");
    } else if (o && !choice) {
      suggestedReply = reply(
        `You can have either. A new ${o.noun} ships today at no cost, or a full refund once the carrier scans your return; it takes ${pack.policy.refundTiming} to appear. Which do you prefer?`,
        "Scenario A and B"
      );
    } else if (o && choice && lowConfidenceChoice) {
      suggestedReply = reply(`Sorry, just to be sure: would you like the new ${o.noun}, or the refund?`, "Scenario A and B");
    } else if (o && match && choice && !match.confirmed && !lowConfidenceChoice) {
      suggestedReply = reply(`Just to confirm, that's order ${o.id}, the ${o.shortName}?`, "Claim rules");
    } else if (o && recommendation?.checkingIdentity) {
      // While the caller's reply to a read-back is checked, never an outcome as done: the reply may reject the identity
      // the outcome relies on (independent review, 23 Oct).
      suggestedReply = neutral("One moment, please, while I check your details.", "Verification");
    } else if (o && recommendation?.checkingChoice) {
      // While the caller's possible change of choice is being checked, never an outcome as done: reading
      // that aloud could approve whichever outcome the check settles on (Call 11 review, I-22 and I-23).
      suggestedReply = neutral("One moment, please, while I make sure I have your choice right.", "Scenario A and B");
    } else if (o && recommendation?.prepared && !approved) {
      suggestedReply =
        recommendation.prepared.kind === "replacement"
          ? reply(`Done. The new ${o.noun} ships today. You'll get an email with a free return label for the damaged one.`, "Scenario A")
          : reply(
              `I've set up a full refund of ${money(o.price)} to your ${o.payment ?? "original payment method"}. It's issued when the carrier scans the return and takes ${pack.policy.refundTiming} to appear. You'll get an email with a free return label.`,
              "Scenario B"
            );
    } else if (o && approved && recommendation?.prepared && choice) {
      // Approval isn't the customer hearing the terms: keep what the agent hasn't said yet since the choice,
      // across split lines (outside review of call 6, §6). Each term counts only with its facts right, not
      // negated and heard clearly: keywords alone passed "a refund of 999 dollars… we do not need a scan"
      // (outside review of call 7, §6). Only then the closing question.
      const since = choice.evidence.at;
      // Heard clearly as recognised: a failed check leaves a line as first heard. The recheck below asks for a
      // better reading; it never takes away a term the line was heard saying.
      const clear = (l: TranscriptEvent) => !(l.confidence !== null && l.confidence < LOW_CONFIDENCE);
      // A line the second model is still checking counts as first heard meanwhile; its checked text replaces it
      // when it comes back. Held back, every term stayed "not heard yet" while the stage card's short row 15
      // lines queued for their checks (21 Oct).
      const agentSince = corrected
        .filter((l) => l.side === "agent" && l.startedAt >= since && clear(l))
        .sort((a, b) => a.startedAt - b.startedAt || a.seq - b.seq);
      const toldRaw = agentSince.map((l) => l.text).join(" ");
      // Sentence by sentence over the agent's own words, with every negation (contractions included):
      // the first affirmed sentence counts, so a term repeated after a negated one is heard (Call 13 review).
      const says = (pattern: RegExp) => {
        const found = findAffirmed(toldRaw, pattern);
        return !!found && !found.negated;
      };
      // Every amount and card number said must be the record's, and the record's must be said. Recognition
      // often drops the "$": "a full refund of 329 to your visa ending 2208" (Call 12 review, RC12-01), so a
      // number straight after "refund of" counts too. Any other bare number (order 427, 3 to 5 days) doesn't.
      const cents = Math.round((o.price % 1) * 100);
      // A number said straight after "not" is one the agent rules out ("$329, not $299"), not one they commit to.
      const ruledOut = (text: string) => normalize(text).replace(/\bnot (?:to )?(?:the |your )?(?:\$ ?\d+(?: \d{2}\b)?|\d+ dollars\b|(?:\p{L}+ )?ending (?:in )?\d[\d ]*\d\b)/gu, " ");
      const amountsIn = (text: string) =>
        [...ruledOut(text).matchAll(/\$ ?(\d+)(?: (\d{2})\b)?|\b(\d+) dollars\b|\brefund (?:of|for) (\d+)(?: (\d{2})\b)?/g)].map((m) => ({
          whole: Number(m[1] ?? m[3] ?? m[4]),
          cents: Number(m[2] ?? m[5] ?? 0),
        }));
      const isPrice = (a: { whole: number; cents: number }) => a.whole === Math.floor(o.price) && a.cents === cents;
      const last4 = o.payment?.match(/\d{4}$/)?.[0];
      const cardsIn = (text: string) => [...ruledOut(text).matchAll(/\bending (?:in )?(\d[\d ]*\d)\b/g)].map((m) => m[1].replace(/ /g, ""));
      // A wrong number is put right only explicitly (outside review of 22 Oct, item 7: no "last number wins"): a
      // sentence that opens "To be clear", "To confirm", "Correction", "I mean", "I misspoke" or "Let me correct that"
      // and itself says the record's number, not negated, supersedes the numbers of that kind said before it, and the
      // record quotes it with what it replaced. A bare "I misspoke." or "To be clear," with the number in the very next
      // sentence counts too, as a pause can split them. Everything said from there on must be right. A plain repeat, a
      // correction about another term, or "299, sorry, 329" in one sentence doesn't (independent review, 22 Oct).
      const sentences = agentSince.flatMap((l) => l.text.split(/(?<=[.!?;])\s+/).map((part) => ({ line: l, part })));
      const corrections = sentences
        .flatMap((s, k) => {
          const opening = CORRECTION.exec(normalize(s.part));
          if (!opening) return [];
          const bare = normalize(s.part).slice(opening[0].length).trim() === "";
          return [{ head: bare ? sentences[k + 1] : s, text: sentences.slice(k).map((x) => x.part).join(" ") }];
        })
        .reverse();
      const saidAmounts = amountsIn(toldRaw);
      const saidCards = cardsIn(toldRaw);
      // The correction itself must not be negated ("To be clear: it doesn't go to the Visa ending 2208").
      const affirmedIn = (text: string, pattern: RegExp) => { const f = findAffirmed(text, pattern); return !!f && !f.negated; };
      const fixOf = <T,>(found: (text: string) => T[], right: (x: T) => boolean, said: RegExp) =>
        corrections.find(({ head, text }) => !!head && found(head.part).length > 0 && found(head.part).every(right) && affirmedIn(head.part, said) && found(text).every(right));
      const amountFix = saidAmounts.some((a) => !isPrice(a)) ? fixOf(amountsIn, isPrice, /\$ ?\d|\b\d+ dollars\b|\brefund (?:of|for) \d/) : undefined;
      const cardFix = last4 && saidCards.some((c) => c !== last4) ? fixOf(cardsIn, (d) => d === last4, /\bending\b/) : undefined;
      const amounts = amountFix ? amountsIn(amountFix.text) : saidAmounts;
      const cards = cardFix ? cardsIn(cardFix.text) : saidCards;
      const rightAmount = amounts.length > 0 && amounts.every(isPrice);
      const rightCard = last4 ? cards.length > 0 && cards.every((c) => c === last4) && says(/\bending\b/) : says(/\boriginal payment\b/);
      // A number said that isn't the record's is named in the record, so "not heard" can't hide a wrong one.
      const wrongAmounts = [...new Set(saidAmounts.filter((a) => !isPrice(a)).map((a) => (a.cents ? `${a.whole}.${String(a.cents).padStart(2, "0")}` : `${a.whole}`)))];
      const wrongCards = last4 ? [...new Set(saidCards.filter((c) => c !== last4))] : [];
      const spelled = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
      const [low, high] = (pack.policy.refundTiming.match(/\d+/g) ?? []).map((n) => `(${n}|${spelled[Number(n)] ?? n})`);
      const timing = new RegExp(`\\b${low} to ${high} (business )?days\\b`);
      const terms =
        recommendation.prepared.kind === "refund"
          ? [
              // Amount and card are separate terms (22 Oct call: "a full refund of $329" was heard, the card ending
              // wasn't, and one combined "amount and card" item hid which part was missing).
              {
                label: "Refund amount",
                key: /\brefund/,
                said: says(/\brefund/) && rightAmount,
                text: `That's a full refund of ${money(o.price)}.`,
                ...(wrongAmounts.length ? { saidInstead: wrongAmounts.join(", ") } : {}),
                ...(amountFix ? { from: amountFix.head!.line } : {}),
              },
              {
                label: "Card it goes to",
                key: last4 ? /\bending\b/ : /\boriginal payment\b/,
                said: rightCard,
                text: `The refund goes to your ${o.payment ?? "original payment method"}.`,
                ...(wrongCards.length ? { saidInstead: `ending ${wrongCards.join(", ")}` } : {}),
                ...(cardFix ? { from: cardFix.head!.line } : {}),
              },
              {
                label: "When it's issued and how long it takes",
                key: /\bscan/,
                said: says(/\bscan/) && says(timing),
                text: `It's issued when the carrier scans the return and takes ${pack.policy.refundTiming} to appear.`,
              },
              { label: "Return label", key: /\blabel\b/, said: says(/\blabel\b/), text: "You'll get an email with a free return label." },
            ]
          : [
              { label: "Ships today", key: /\bships? (out )?today\b/, said: says(/\bships? (out )?today\b/), text: `The new ${o.noun} ships today.` },
              { label: "Return label", key: /\blabel\b/, said: says(/\blabel\b/), text: "You'll get an email with a free return label for the damaged one." },
            ];
      // The record keeps each term with the line that said it (call 8 review).
      termRecord = terms.map((t) => {
        const affirmed = (text: string) => { const f = findAffirmed(text, t.key); return !!f && !f.negated; };
        // A term split across lines ("…ships" / "today.") is quoted by the line that completed it.
        // A corrected number is quoted by the line that corrected it, and the record keeps what it replaced.
        const fixed = "from" in t ? t.from : undefined;
        const line = t.said ? (fixed ?? agentSince.find((l) => affirmed(l.text)) ?? agentSince.find((_, i) => affirmed(agentSince.slice(0, i + 1).map((l) => l.text).join(" ")))) : undefined;
        const instead = "saidInstead" in t ? t.saidInstead : undefined;
        return { label: t.label, said: t.said, evidence: line ? evidenceOf(line) : undefined, ...(instead ? (t.said ? { corrected: instead } : { saidInstead: instead }) : {}) };
      });
      const missing = terms.filter((t) => !t.said);
      // Both the amount and the card missing: the one sentence that says both. After a wrong number (as heard), the
      // suggestion opens with "To be clear", which the rules above take as the correction.
      const both =
        missing[0]?.label === "Refund amount" && missing[1]?.label === "Card it goes to"
          ? [`I've set up a full refund of ${money(o.price)} to your ${o.payment ?? "original payment method"}.`, ...missing.slice(2).map((t) => t.text)]
          : missing.map((t) => t.text);
      const unsaid = missing.some((t) => "saidInstead" in t && t.saidInstead) && both.length ? [`To be clear: ${/^I\b/.test(both[0]) ? both[0] : both[0][0].toLowerCase() + both[0].slice(1)}`, ...both.slice(1)] : both;
      // While a term isn't heard, each agent line since the approval gets the second speech model's check, once:
      // "It's issued when the carriers can't return" (for "…the carrier scans the return") was never re-heard on
      // the 21 Oct stage call. What counts is still decided above, negations included. Lines that ended before the
      // approval aren't re-heard: the approval may rest on them (the order read-back, or the approving line itself),
      // a line being checked counts for nothing until its checked text arrives, and a press is judged on the lines
      // the copilot had when it was made, so re-hearing them took the approval away, for good if the check failed
      // (independent review of the 22 Oct fixes). Terms said before "Approved." are said again after it.
      if (unsaid.length) {
        const approvedAt = recommendation.approval.at ?? Infinity;
        for (const l of agentSince) {
          if (l.endedAt <= approvedAt || keyAnswers.includes(l.key)) continue;
          keyAnswers.push(l.key);
          const entry = agentChecks.find((c) => c.key === l.key);
          if (entry) Object.assign(entry, { check: true, reason: "a term isn't heard yet since the approval" });
        }
      }
      suggestedReply = unsaid.length
        ? reply(unsaid.join(" "), recommendation.prepared.kind === "refund" ? "Scenario B" : "Scenario A")
        : neutral("Is there anything else I can help with?", "Required documentation");
    } else if (approved) {
      suggestedReply = neutral("Is there anything else I can help with?", "Required documentation");
    }
  }

  // Approval alone doesn't complete the documentation: the step stays open while a term the customer must
  // hear isn't heard yet, so a finished-looking checklist can't hide "not heard yet" in the record (Call 12
  // review, RC12-03).
  const unheardTerms = termRecord.filter((t) => !t.said).map((t) => t.label.toLowerCase());
  if (approved && termRecord.length) {
    const docs = steps.find((s) => s.id === "docs")!;
    if (unheardTerms.length) {
      // The step in progress, as the checklist marks the first open step (above).
      docs.status = steps.some((s) => s !== docs && s.status !== "done" && s.status !== "skipped") ? "pending" : "active";
      docs.detail = `Not heard yet: ${unheardTerms.join(", ")}`;
    } else docs.detail = "Terms heard on the call";
  }

  /* ---------- Documentation (filled once approved; nothing is sent) ---------- */
  // Only what the caller said goes in as the damage; never a placeholder or the model's provenance.
  const qa = damageAnswer && `the caller said "${damageAnswer.answer.text}" to "${damageAnswer.question.text}"`;
  const damage = !supported
    ? null
    : callerDescribed
      ? [`"${intent!.phrases[0]}"`, qa].filter(Boolean).join("; ")
      : qa
        ? `${qa}${damageSource === "confirmed by the agent" ? "; arrival damage confirmed by the agent" : ""}`
        : "confirmed by the agent; description not captured in the transcript, clarification required";
  const documentation = [
    {
      label: "Case summary",
      value:
        isVerified && o
          ? `${customer.name} (${customer.id}), order ${o.id} ${o.shortName}, damage: ${damage ?? "not established"}, verified by full name${name.method ? ` (${name.method})` : ""} and ${address.method ?? "second factor"}`
          : null,
    },
    { label: "Resolution", value: approved && recommendation?.prepared ? `${recommendation.prepared.kind === "replacement" ? "Replacement order" : "Refund"} ${recommendation.prepared.reference}` : null },
    {
      label: "Approval record",
      value: approved && recommendation ? `${pack.agent.name} (${pack.agent.id}), ${recommendation.approver}, ${clock(recommendation.approval.evidence?.at ?? recommendation.approval.at ?? now)}` : null,
    },
    {
      // Both ways the item was confirmed, and any press taken back (I-25, I-02).
      label: "Item confirmation",
      value:
        [
          ...undone.filter((u) => u.target === "order").map((u) => `confirmed in the panel at ${clock(u.confirmedAt)}, undone at ${clock(u.undoneAt)}`),
          ...(match?.pressedAt !== undefined ? [`confirmed in the panel at ${clock(match.pressedAt)}`] : []),
          ...(match?.readBack ? [`read back at ${clock(match.readBack.at)} ("${match.readBack.text}")`] : []),
        ].join("; ") || null,
    },
    { label: "Customer communication", value: approved ? "Confirmation email and prepaid return label (prepared; nothing is sent in this demo)" : null },
    {
      label: "Approval history",
      value:
        approved && recommendation?.history
          ? recommendation.history
              .map((h) => `${clock(h.evidence?.at ?? h.at)} ${h.via === "call" ? "on the call" : "in the panel"}: ${h.counted ? "counted" : `not counted (${h.reason})`}`)
              .join("; ")
          : null,
    },
    {
      // "Not heard": the copilot only knows what recognition gave it, not what the customer heard (Call 12 review).
      label: "Terms heard",
      value: approved && termRecord.length
        ? termRecord
            .map((t) => `${t.label}: ${t.evidence ? `"${t.evidence.text}" (${clock(t.evidence.at)}${t.corrected ? `, correcting ${t.corrected} said before` : ""})` : t.saidInstead ? `not heard yet (said as ${t.saidInstead}, which isn't the order's)` : "not heard yet"}`)
            .join("; ")
        : null,
    },
  ];

  const view: CopilotView = {
    callId: ordered[0]?.callId ?? null,
    lineCount: ordered.length,
    intent,
    verification: { factors: [name, address], verified: isVerified, verifiedAt, verifiedKnownAt, locked, attemptsLeft },
    order,
    checks,
    choice,
    recommendation,
    suggestedReply,
    alerts,
    prompts,
    steps,
    documentation,
    awaiting,
    ...(lingerUntil !== null && !lingerOver && identityFactor && awaiting === identityFactor.id ? { awaitingUntil: lingerUntil } : {}),
    keyAnswers,
    readBackChecks,
    agentChecks,
    undoable: [
      ...(["name", "address"] as const).filter((t) => confirmedByPress.has(t)),
      ...(match?.confirmedBy === "panel" ? (["order"] as const) : []),
    ],
    nameEntry,
    addressEntry,
    readBackUntil: [
      readBackState === "waiting" && !readBackHeld ? readBackUntil : undefined,
      addrState === "waiting" && !addrHeld ? addrUntil : undefined,
    ].reduce<number | undefined>((a, u) => (u === undefined ? a : a === undefined ? u : Math.min(a, u)), undefined),
  };
  givenIn.set(view, given);
  return view;
}

/**
 * The recommendation card's line on who may approve and whether it can be approved now (I-27): the
 * old "You can approve this." showed while nothing could be approved.
 */
export function approvalReadiness(view: CopilotView): string | null {
  const rec = view.recommendation;
  if (!rec) return null;
  if (!rec.agentCanApprove) return `Needs approval from ${rec.approver}.`;
  const state =
    rec.approval.state === "approved"
      ? "Approved."
      : rec.approval.state === "awaiting"
        ? "Ready to approve."
        : rec.checkingIdentity
          ? "Not ready: checking the caller's reply to your read-back."
          : rec.checkingChoice || rec.suspended
          ? "Not ready: checking a possible change of choice."
          : !view.choice
            ? "Not ready: the customer hasn't chosen yet."
            : view.order.match && !view.order.match.confirmed
              ? "Not ready: read back the order first."
              : "Not ready.";
  return `Within your authority. ${state}`;
}
