import { findOrderMentions, findSplitOrder, matchOrder, type MentionMethod, type OrderMention } from "./orders";
import { agentAsksChoice, agentAsksFor, agentCommits, agentDisclosesFactor, agentOffers, escalationWords, readChoice, readIntent, safetyWords, type Choice } from "./signals";
import { findAffirmed, normalize, repeatsItself, soundsLike, words as textWords } from "./text";
import type { AgentAction, AuthorityBand, ClientPack, Customer, Order, Side, TranscriptEvent } from "./types";
import { deniesIdentity, isFiller, matchAddress, matchName, soundsLikeRecord } from "./verification";

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
const CORRECTION = /^(sorry )?(just )?(to be clear|to confirm|correction|i mean|i meant|i misspoke|let me correct( that)?|to correct that)\b/;

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
  /** When the factor was verified, by when its evidence was usable (see Evidence.knownAt). */
  knownAt?: number;
  /**
   * Why the agent is asked to confirm: a doubtful line, a garbled one, or an answer that only sounds
   * like the record. "disagree": a wrong answer the two speech models heard differently; the agent
   * asks again or types the caller's words, and can't just confirm it. "ambiguous": the answer names
   * two candidates or denies something else; asked again, never confirmed.
   */
  confirmReason?: "low-confidence" | "garbled" | "sounds-like" | "disagree" | "ambiguous";
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
  /**
   * Caller lines that answer a key question, judged in speech order: the problem (until one is heard),
   * the name, the address and the choice. Each gets the second model's check once, even when the
   * agent's question reached the console after the answer (the two sides are transcribed separately).
   */
  keyAnswers: string[];
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
    readBack: "off" | "available" | "waiting" | "expired" | "refused";
    /** While waiting: epoch ms after which the caller's yes no longer counts (the field shows the expiry itself). */
    readBackUntil?: number;
    /** After a refusal: ask for the full name again, or type the name (only for a yes the system couldn't confirm). */
    readBackRecovery?: "ask" | "type";
  } | null;
  /**
   * Where the agent types the caller's street and city, the same way as the name: from the moment the caller's
   * answer to the address question arrives, while the second speech model still checks it (22 Oct call: about
   * 20 s went on the address, typed into a card that came only after both models had heard it wrong). Shown once
   * the name is verified; null once the address is. Typed words are checked against the order as before.
   */
  addressEntry: { key: string; checking: boolean } | null;
};

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

/** A reply that is a plain yes and nothing more ("Yes, that's right, thank you."): a correction, a "yes, but", a question back or anything else isn't. */
const CONFIRM_START = /^(yes|yeah|yep|yup|correct|exactly|absolutely|right|that's (right|correct|it|me)|that is (right|correct|it|me))\b/;
const CONFIRM_WORDS = new Set("yes yeah yep yup correct right exactly absolutely that's that is it it's me thank thanks you please sir madam ma'am indeed".split(" "));
const confirmsOnly = (text: string) => {
  const w = textWords(text);
  return !/\?/.test(text) && w.length > 0 && CONFIRM_START.test(w.join(" ")) && w.every((x) => CONFIRM_WORDS.has(x));
};

/**
 * Timestamps can put the start of a reply slightly before the end of the question; up to this much is tolerated. A yes
 * that starts earlier is speech overlapping the question, not an answer to it.
 */
export const READ_BACK_OVERLAP_MS = 250;
/** A reply that starts this long after the read-back ended isn't taken as its answer; the field shows the wait ending. */
export const READ_BACK_REPLY_MS = 8000;

/** Refusals where the caller did say a plain yes and only the system couldn't confirm it: typing the name is allowed. */
const NOT_CHECKED = "the second speech model didn't finish checking it";
const UNCLEAR = "it was unclear";

/**
 * Why the caller's next line after a read-back doesn't confirm it, or null when it does: a plain yes and nothing else,
 * started after the question ended, checked by the second speech model with both models hearing a yes, and heard
 * clearly. "No", corrections, "yes, but…", unclear speech and a yes to anything else never verify the name.
 */
function whyNotConfirmed(line: TranscriptEvent, ev: Evidence, askedEnd: number): string | null {
  if (line.typedFrom !== undefined) return "the agent typed over it";
  if (line.startedAt < askedEnd - READ_BACK_OVERLAP_MS) return "it started before the question ended";
  if (line.startedAt > askedEnd + READ_BACK_REPLY_MS) return "it came too long after the question";
  if (!confirmsOnly(line.text)) return "it isn't a plain yes";
  if (line.checkFailed || !line.checked) return NOT_CHECKED;
  if (line.firstHeard !== undefined && !confirmsOnly(line.firstHeard)) return `the fast model heard "${line.firstHeard}"`;
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

/** An approval as given: by the agent's commitment on the call, or in the panel. */
type GivenApproval = { at: number; via: "call" | "panel"; evidence?: Evidence };
/** Approval words in a line that named the other outcome: never counted, but kept in the history. */
type RefusedApproval = GivenApproval & { reason: string };
/** The approvals each pass heard, so a later pass can find the ones an undo took away. */
const givenIn = new WeakMap<CopilotView, GivenApproval[]>();

/**
 * `past`: this pass rebuilds what the copilot knew at an earlier moment, to check an approval given
 * then. It only needs the recommendation, so it doesn't look at approvals itself.
 */
function rules(pack: ClientPack, lines: TranscriptEvent[], allActions: AgentAction[], now: number, hints: ModelHints, past: boolean): CopilotView {
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
  // The agent's latest question for the name, and their read-back of it still waiting for the caller's answer.
  let nameAsk: Evidence | null = null;
  // The agent's latest question for the street and city (or email).
  let addressAsk: Evidence | null = null;
  // The agent's read-back waiting for the caller's reply, and the reply that ended read-back for this call.
  let readBack: { ev: Evidence; endedAt: number } | null = null;
  let readBackRefused: { ev: Evidence; why: string; recovery: "ask" | "type" } | null = null;
  // Everything the caller says before the agent's next line is one reply to the read-back (review, 22 Oct: "Yes." then
  // "But no, that's not right." as two lines). `held`: part of it is still being checked, so nothing is decided yet.
  let replyOpen = false;
  let readBackHeld = false;
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
  const markVerified = (ev: Evidence) => {
    if (verified() && !verifiedAt) verifiedAt = ev;
  };

  /** The caller lines answering the agent's current identity question (see ANSWER_GAP_MS). */
  type Pending = { factor: Factor; evs: Evidence[]; texts: string[]; endedAt: number; result: "partial" | "sounds-like" | "ambiguous" | "mismatch" | "none" };
  // Cast so TypeScript doesn't narrow it to null: it changes inside hear() and closeAnswer().
  let pending = null as Pending | null;
  const firstAnswer = new Map<Factor["id"], Pending>();

  const addressMethod = (text: string) => (/\b(at|@)\b/.test(text.toLowerCase()) && !/\broad\b/i.test(text) ? "email" : "street and city");

  /** Why an answer can't be trusted as heard, if it can't. */
  const doubt = (evs: Evidence[], text: string): "low-confidence" | "garbled" | null =>
    evs.some((e) => e.lowConfidence) ? "low-confidence" : repeatsItself(text) ? "garbled" : null;

  function matched(factor: Factor, ev: Evidence, reason: "low-confidence" | "garbled" | null, method?: string, knownAt = ev.knownAt) {
    factor.evidence = ev;
    factor.knownAt = knownAt;
    if (reason) {
      // A doubtful line never ticks a step on its own.
      factor.state = "confirm";
      factor.confirmReason = reason;
      return;
    }
    factor.state = "ok";
    factor.method = ev.typedFrom === undefined ? method : [method, "typed by the agent"].filter(Boolean).join(", ");
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

  /** A caller line while the agent is waiting for this factor. */
  function hear(factor: Factor, line: TranscriptEvent, ev: Evidence) {
    if (factor.state === "ok" || locked) return;
    if (pending?.factor !== factor) pending = { factor, evs: [], texts: [], endedAt: 0, result: "none" };
    // The end of the first answer, all of its lines: the start point for "Name accepted" in Call details.
    if (factor.answeredAt === undefined) firstAnswer.set(factor.id, pending);
    if (firstAnswer.get(factor.id) === pending) factor.answeredAt = line.endedAt;
    pending.evs.push(ev);
    pending.texts.push(line.text);
    pending.endedAt = line.endedAt;
    const heard = pending.texts.join(" ");
    const reason = doubt(pending.evs, heard);
    const result = factor.id === "name" ? matchName(heard, customer) : matchAddress(heard, customer);
    factor.heard = heard;
    factor.evidence = ev;
    if (result === "match") {
      matched(factor, ev, reason, factor.id === "address" ? addressMethod(heard) : undefined, Math.max(...pending.evs.map((e) => e.knownAt)));
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
    const { factor, evs, texts, result } = pending;
    pending = null;
    if (result !== "mismatch" || locked) return;
    // A wrong answer from a doubtful, garbled or disputed line is the agent's call, never a failed attempt.
    const reason = doubt(evs, texts.join(" ")) ?? (evs.some(modelsDisagree) ? "disagree" : null);
    if (reason) {
      factor.state = "confirm";
      factor.confirmReason = reason;
      return;
    }
    factor.attempts++;
    factor.state = "failed";
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
        // Once the caller hasn't confirmed a read-back, the agent can't vouch for the name instead.
        if (factor.state === "confirm" && confirmable(factor) && factor.evidence && !locked && !(factor.id === "name" && readBackRefused)) {
          if (pending?.factor === factor) pending = null;
          factor.state = "ok";
          confirmedByPress.add(factor.id);
          factor.knownAt = Math.max(a.at, factor.evidence.knownAt);
          // A confirm press is the agent vouching for the answer: always disclosed, for the name as for the address.
          factor.method = a.target === "address" ? factor.method ?? "confirmed by the agent" : "confirmed by the agent";
          markVerified(factor.evidence);
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
        given.push({ at: a.at, via: "panel" });
      }
      continue;
    }

    const line = item.line;
    const ev = evidenceOf(line);

    if (line.side === "caller") {
      // Judged before this line changes anything: what the copilot was waiting for when it was said.
      // After a choice, a line that reads as a different one, or the answer to the choice asked again, is a key answer too.
      const heardChoice = readChoice(line.text)?.choice;
      const changesChoice = !!choice && !!heardChoice && heardChoice !== "both" && heardChoice !== choice.value;
      if (!locked && (!intent || expecting === "name" || expecting === "address" || lowConfidenceChoice || (!choice && (choiceAsked || unreadChoice)) || (choice && (choiceAsked || changesChoice)))) {
        keyAnswers.push(line.key);
      }
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

      // The caller's reply to the agent saying the name back verifies it only as a clear, checked yes, all of it (see
      // whyNotConfirmed and restOfReply), labelled as read back. Any other reply ends read-back for this call: the agent
      // asks for the name again, or types it when only the system couldn't confirm the yes. A reply with no name in it
      // ("No.") isn't heard as a name answer.
      const backed: { ev: Evidence; endedAt: number } | null = readBack;
      readBack = null;
      const continues = !backed && replyOpen;
      if (backed) replyOpen = true;
      let why: string | null | undefined = backed && !locked && name.state !== "ok" ? whyNotConfirmed(line, ev, backed.endedAt) : undefined;
      if (backed && why === null) {
        // The yes counts only if the rest of the reply is also a plain yes; while part of it is being checked, wait.
        const rest = restOfReply(line);
        const went = rest.find((l) => !l.checking && !confirmsOnly(l.text));
        if (went) why = `the caller went on: "${went.text}"`;
        else if (rest.some((l) => l.checking)) {
          readBackHeld = true;
          why = undefined;
        }
      }
      if (backed && why === null) {
        if (pending?.factor === name) pending = null;
        name.state = "ok";
        name.evidence = backed.ev;
        name.confirmedBy = ev;
        name.knownAt = Math.max(backed.ev.knownAt, ev.knownAt);
        name.confirmReason = undefined;
        name.method = NAME_READ_BACK;
        markVerified(ev);
      } else if (why) readBackRefused = { ev, why, recovery: why === NOT_CHECKED || why === UNCLEAR ? "type" : "ask" };

      if (!locked) {
        // The factor the agent asked for; the other only counts if volunteered as a clear match.
        if (why === null || readBackHeld || ((why || continues) && !saysNamePart(line.text))) {
          // A confirmed read-back, a reply still being decided, or a reply to one with no name in it: never a failed attempt.
        } else if (expecting === "name") hear(name, line, ev);
        else if (name.state !== "ok" && matchName(line.text, customer) === "match") matched(name, ev, doubt([ev], line.text));
        if (expecting === "address") hear(address, line, ev);
        else if (address.state !== "ok" && matchAddress(line.text, customer) === "match") matched(address, ev, doubt([ev], line.text), addressMethod(line.text));
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
      const asks = agentAsksFor(line.text, !verified() && !locked);
      // Saying the name back is allowed only when the client allows it, once the caller has given a full answer the
      // speech models couldn't confirm (never a partial, ambiguous or missing one), before any failed attempt (a
      // failure is corrected by typing the caller's words), and once per call: a reply that isn't a clear yes ends it.
      const canReadBack: boolean =
        !!pack.policy.nameReadBack &&
        !locked &&
        !readBackRefused &&
        !readBackHeld &&
        name.state === "confirm" &&
        name.confirmReason !== "ambiguous" &&
        name.attempts === 0 &&
        name.heard !== undefined &&
        name.evidence?.side === "caller";
      readBack = !asks && canReadBack && !ev.lowConfidence && readsBackName(line.text, customer) ? { ev, endedAt: line.endedAt } : null;
      if (readBack) expecting = "name";
      else if (!asks && (expecting === "name" || expecting === "address")) expecting = null;
      if (asks === "name") nameAsk = ev;
      if (asks === "address") addressAsk = ev;
      if (asks) {
        expecting = asks;
        const factor = asks === "name" ? name : asks === "address" ? address : null;
        if (factor && (factor.state === "idle" || factor.state === "failed" || factor.state === "partial")) factor.state = "asking";
      }

      if (verified()) for (const mention of findOrderMentions(line.text, idLengths)) agentMentionsAfterVerify.push({ mention, ev });

      if (name.attempts + address.attempts > 0 && agentDisclosesFactor(line.text)) disclosures.push(ev);

      // "Done. The new tablet ships today." after the customer chose is the agent's approval on the call.
      const offeringOptions = /\?/.test(line.text) && /\bor\b/i.test(line.text);
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
        if (commit && fitsChoice && readyToApprove()) {
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
          rules(pack, lines.filter((l) => (l.availableAt ?? l.endedAt) <= at), allActions.filter((x) => x.at < at), at, hints, true).order.match?.order.id === found.order.id
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

  const identityFactor = expecting === "name" ? name : expecting === "address" ? address : null;
  const awaiting: CopilotView["awaiting"] =
    locked || escalate
      ? null
      : identityFactor && identityFactor.state !== "ok"
        ? identityFactor.id
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
        const before = rules(pack, lines.filter((l) => (l.availableAt ?? l.endedAt) < u.undoneAt), allActions.filter((x) => x.at < u.undoneAt), u.undoneAt, hints, true);
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
        const then = rules(pack, lines.filter((l) => (l.availableAt ?? l.endedAt) <= a.at), allActions.filter((x) => x.at <= a.at), a.at, hints, true);
        const r = then.recommendation;
        const changedSince = choiceChanges.some((t) => t > a.at);
        // A Confirm press the approval relied on was taken back after it: confirming again doesn't revive it.
        const undoneSince = undone.some((u) => u.confirmedAt <= a.at && u.undoneAt > a.at);
        const holds = !changedSince && !undoneSince && !!r?.prepared && r.scenario === scenario && r.prepared.kind === prepared.kind && then.order.match?.order.id === o.id;
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
          detail: `${attemptsLeft === 1 ? "One attempt left" : `${attemptsLeft} attempts left`}. Don't say which detail didn't match.`,
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
  const readBackState: NonNullable<CopilotView["nameEntry"]>["readBack"] =
    !pack.policy.nameReadBack || locked || name.attempts > 0
      ? "off"
      : readBackRefused
        ? "refused"
        : readBackHeld || (readBackUntil !== undefined && now <= readBackUntil)
          ? "waiting"
          : readBackUntil !== undefined
            ? "expired"
            : name.state === "confirm" && name.confirmReason !== "ambiguous"
              ? "available"
              : "off";
  // The name card leads with what to do: reading a diagnosis first cost about 3 s on the 21 Oct stage call.
  const nameAction =
    readBackState === "available"
      ? "Say it back as you heard it and wait for the caller's yes, or type it (N)."
      : readBackState === "waiting"
        ? "Wait for the caller's yes to your read-back, or type what the caller said (N)."
        : readBackState === "expired"
          ? `No reply to your read-back within ${READ_BACK_REPLY_MS / 1000} s, so a yes now won't count. Ask for the full name again, or type it (N).`
          : "Type what the caller said (N), or ask again.";
  for (const f of [name, address]) {
    if (f.state === "confirm" && f.evidence && f.id === "name" && readBackRefused) {
      // After a refused read-back, typing is the way on: neither another read-back nor the Confirm button counts.
      const newer = f.evidence.at > readBackRefused.ev.at;
      prompts.push({
        target: "name",
        askAgain: true,
        text: newer
          ? `Name not recognised. Type what the caller said (N), or ask again. Heard "${f.heard ?? f.evidence.text}". The read-back wasn't confirmed earlier, so reading it back or pressing Confirm won't count on this call.`
          : readBackRefused.recovery === "ask"
            ? `Read-back not confirmed: the caller's reply "${readBackRefused.ev.text}" doesn't count, because ${readBackRefused.why}. Ask for the full name again, and type the new answer (N) only if it still isn't recognised. Reading the name back again won't count on this call.`
            : `Read-back not confirmed: the caller's reply "${readBackRefused.ev.text}" doesn't count, because ${readBackRefused.why}. If you clearly heard the caller give their name and say yes, type the name (N); otherwise ask for the full name again. Reading the name back again won't count on this call.`,
        evidence: newer ? f.evidence : readBackRefused.ev,
      });
    } else if (f.state === "confirm" && f.evidence && f.id === "name" && (readBackState === "waiting" || readBackState === "expired")) {
      // Said back: the card says what the read-back is waiting for, or that the wait is over.
      prompts.push({
        target: "name",
        askAgain: !confirmable(f) || undefined,
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
      asked && expecting === "name" && !readBack
        ? [...corrected].reverse().find((l) => l.checking && l.side === "caller" && l.startedAt > asked.at && matchName(l.text, customer) !== "match")
        : undefined;
    const extra = {
      ...(readBackState === "waiting" && !readBackHeld && readBackUntil !== undefined ? { readBackUntil } : {}),
      ...(readBackState === "refused" && readBackRefused ? { readBackRecovery: (readBackRefused as { recovery: "ask" | "type" }).recovery } : {}),
    };
    if (checkingAnswer) nameEntry = { key: checkingAnswer.key, checking: true, readBack: readBackState, ...extra };
    else if (name.evidence?.side === "caller") nameEntry = { key: name.evidence.key, checking: false, readBack: readBackState, ...extra };
  }

  /* ---------- Where the agent types the street and city ---------- */
  // The same as the name field, once the name is verified: from the moment the caller's answer arrives, unless the
  // fast model already heard a clear match. Never while identity is locked after too many failed attempts.
  let addressEntry: CopilotView["addressEntry"] = null;
  if (name.state === "ok" && address.state !== "ok" && !locked) {
    const asked = addressAsk as Evidence | null;
    const checkingAnswer =
      asked && expecting === "address"
        ? [...corrected].reverse().find((l) => l.checking && l.side === "caller" && l.startedAt > asked.at && matchAddress(l.text, customer) !== "match")
        : undefined;
    if (checkingAnswer) addressEntry = { key: checkingAnswer.key, checking: true };
    else if (address.evidence?.side === "caller") addressEntry = { key: address.evidence.key, checking: false };
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
          ? "On hold: checking a possible change of choice"
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
      const amountsIn = (text: string) =>
        [...normalize(text).matchAll(/\$ ?(\d+)(?: (\d{2})\b)?|\b(\d+) dollars\b|\brefund (?:of|for) (\d+)(?: (\d{2})\b)?/g)].map((m) => ({
          whole: Number(m[1] ?? m[3] ?? m[4]),
          cents: Number(m[2] ?? m[5] ?? 0),
        }));
      const isPrice = (a: { whole: number; cents: number }) => a.whole === Math.floor(o.price) && a.cents === cents;
      const last4 = o.payment?.match(/\d{4}$/)?.[0];
      const cardsIn = (text: string) => [...normalize(text).matchAll(/\bending (?:in )?(\d[\d ]*\d)\b/g)].map((m) => m[1].replace(/ /g, ""));
      // A wrong number is put right only explicitly (outside review of 22 Oct, item 7: no "last number wins"): a
      // sentence that opens "To be clear", "To confirm", "Correction", "I mean", "I misspoke" or "Let me correct that"
      // and says the record's number supersedes the numbers of that kind said before it, and the record keeps both.
      // Everything said from there on must be right. A plain repeat, or "299, sorry, 329" in one sentence, doesn't.
      const corrections = agentSince
        .flatMap((l, i) =>
          l.text.split(/(?<=[.!?;])\s+/).flatMap((part, j, parts) =>
            CORRECTION.test(normalize(part)) ? [{ line: l, text: [parts.slice(j).join(" "), ...agentSince.slice(i + 1).map((x) => x.text)].join(" ") }] : []
          )
        )
        .reverse();
      const saidAmounts = amountsIn(toldRaw);
      const saidCards = cardsIn(toldRaw);
      // The correction itself must not be negated ("To be clear: it doesn't go to the Visa ending 2208").
      const affirmedIn = (text: string, pattern: RegExp) => { const f = findAffirmed(text, pattern); return !!f && !f.negated; };
      const amountFix = saidAmounts.some((a) => !isPrice(a))
        ? corrections.find((c) => amountsIn(c.text).length > 0 && amountsIn(c.text).every(isPrice) && affirmedIn(c.text, /\$ ?\d|\b\d+ dollars\b|\brefund (?:of|for) \d/))
        : undefined;
      const cardFix = last4 && saidCards.some((c) => c !== last4)
        ? corrections.find((c) => cardsIn(c.text).length > 0 && cardsIn(c.text).every((d) => d === last4) && affirmedIn(c.text, /\bending\b/))
        : undefined;
      const amounts = amountFix ? amountsIn(amountFix.text) : saidAmounts;
      const cards = cardFix ? cardsIn(cardFix.text) : saidCards;
      const rightAmount = amounts.length > 0 && amounts.every(isPrice);
      const rightCard = last4 ? cards.length > 0 && cards.every((c) => c === last4) && says(/\bending\b/) : says(/\boriginal payment\b/);
      // A number said that isn't the record's is named in the record, so "not heard" can't hide a wrong one.
      const wrongAmounts = saidAmounts.filter((a) => !isPrice(a)).map((a) => (a.cents ? `${a.whole}.${String(a.cents).padStart(2, "0")}` : `${a.whole}`));
      const wrongCards = last4 ? saidCards.filter((c) => c !== last4) : [];
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
                ...(amountFix ? { from: amountFix.line } : {}),
              },
              {
                label: "Card it goes to",
                key: last4 ? /\bending\b/ : /\boriginal payment\b/,
                said: rightCard,
                text: `The refund goes to your ${o.payment ?? "original payment method"}.`,
                ...(wrongCards.length ? { saidInstead: `ending ${wrongCards.join(", ")}` } : {}),
                ...(cardFix ? { from: cardFix.line } : {}),
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
      // While a term isn't heard, each agent line since the customer's choice gets the second speech model's check,
      // once: "It's issued when the carriers can't return" (for "…the carrier scans the return") was never re-heard
      // on the 21 Oct stage call. Lines that ended before the Approve press count for the terms, so they are
      // re-heard too: on the 22 Oct call the refund sentence ended about when Approve was pressed, and its card
      // ending was never heard. What counts is still decided above, negations included.
      if (unsaid.length) {
        for (const l of agentSince) {
          if (keyAnswers.includes(l.key)) continue;
          keyAnswers.push(l.key);
          const entry = agentChecks.find((c) => c.key === l.key);
          if (entry) Object.assign(entry, { check: true, reason: "a term isn't heard yet since the customer chose" });
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
    keyAnswers,
    agentChecks,
    undoable: [
      ...(["name", "address"] as const).filter((t) => confirmedByPress.has(t)),
      ...(match?.confirmedBy === "panel" ? (["order"] as const) : []),
    ],
    nameEntry,
    addressEntry,
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
        : rec.checkingChoice || rec.suspended
          ? "Not ready: checking a possible change of choice."
          : !view.choice
            ? "Not ready: the customer hasn't chosen yet."
            : view.order.match && !view.order.match.confirmed
              ? "Not ready: read back the order first."
              : "Not ready.";
  return `Within your authority. ${state}`;
}
