import { findOrderMentions, matchOrder, type MentionMethod, type OrderMention } from "./orders";
import { agentAsksChoice, agentAsksFor, agentCommits, agentDisclosesFactor, agentOffers, escalationWords, readChoice, readIntent, safetyWords, type Choice } from "./signals";
import { findPhrase, normalize, repeatsItself, soundsLike, words as textWords } from "./text";
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
  staleApproval?: { at: number; via: "call" | "panel"; evidence?: Evidence; reason: string };
  /**
   * The agent's line about this outcome, while it waits for approval, with no approval heard in it:
   * "offset a full refund…" for "I've set up a full refund…" (call 7). Never approves; the agent decides.
   */
  unheardApproval?: Evidence;
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
    match?: { order: OrderView; method: MentionMethod | "closest" | "only-recent"; note: string; needsConfirmation: boolean; confirmed: boolean; confirmedBy?: Evidence | "panel"; evidence?: Evidence };
  };
  checks: Check[];
  choice: { value: Choice; evidence: Evidence } | null;
  recommendation: Recommendation | null;
  suggestedReply: { text: string; sopRef: string; basis: "rules" } | null;
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
};

const DAY = 86_400_000;

const evidenceOf = (l: TranscriptEvent): Evidence => ({
  key: l.key,
  seq: l.seq,
  side: l.side,
  text: l.text,
  at: l.startedAt,
  knownAt: Math.max(l.availableAt ?? l.endedAt, l.typedAt ?? 0),
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

export function orderView(order: Order, now: number): OrderView {
  const d = order.deliveredDaysAgo;
  const deliveredLabel = d === null ? "Not delivered yet" : d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
  const deliveredDate = d === null ? null : new Date(now - d * DAY).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return { ...order, deliveredLabel, deliveredDate };
}

export const bandFor = (bands: AuthorityBand[], amount: number) => bands.find((b) => b.upTo === null || amount <= b.upTo) ?? bands[bands.length - 1];

const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
const clock = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

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
  if (!r?.prepared) return "the order wasn't confirmed yet";
  return "the outcome has changed since";
}

/** An approval as given: by the agent's commitment on the call, or in the panel. */
type GivenApproval = { at: number; via: "call" | "panel"; evidence?: Evidence };

/**
 * `past`: this pass rebuilds what the copilot knew at an earlier moment, to check an approval given
 * then. It only needs the recommendation, so it doesn't look at approvals itself.
 */
function rules(pack: ClientPack, lines: TranscriptEvent[], actions: AgentAction[], now: number, hints: ModelHints, past: boolean): CopilotView {
  const sopId = pack.sop.id;
  const ref = (section: string) => `${sopId} · ${section}`;
  const customer: Customer = pack.customers.find((c) => c.id === pack.callerCustomerId)!;
  const customerOrders = pack.orders.filter((o) => o.customerId === customer.id);
  const idLengths = [...new Set(pack.orders.map((o) => o.id.length))];
  const firstName = customer.name.split(" ")[0];

  // Speech order, not arrival order: the two sides are recognised separately. A line still
  // being checked by the second speech model is left out until its checked text arrives.
  const ordered = applyCorrections(lines, actions)
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
  const callerMentions: { mention: OrderMention; ev: Evidence }[] = [];
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
  let orderConfirmedInPanel = false;
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
  let unheardApproval: { ev: Evidence; value: "replacement" | "refund" } | null = null;
  const keyAnswers: string[] = [];

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

  /** A caller line while the agent is waiting for this factor. */
  function hear(factor: Factor, line: TranscriptEvent, ev: Evidence) {
    if (factor.state === "ok" || locked) return;
    if (pending?.factor !== factor) pending = { factor, evs: [], texts: [], endedAt: 0, result: "none" };
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

  for (const item of timeline) {
    if (pending && item.at - pending.endedAt >= ANSWER_GAP_MS) closeAnswer();
    if (item.kind === "action") {
      const a = item.action;
      if (a.type === "confirm" && (a.target === "name" || a.target === "address")) {
        const factor = a.target === "name" ? name : address;
        if (factor.state === "confirm" && factor.confirmReason !== "disagree" && factor.confirmReason !== "ambiguous" && factor.evidence && !locked) {
          if (pending?.factor === factor) pending = null;
          factor.state = "ok";
          factor.knownAt = Math.max(a.at, factor.evidence.knownAt);
          // A confirm press is the agent vouching for the answer: always disclosed, for the name as for the address.
          factor.method = a.target === "address" ? factor.method ?? "confirmed by the agent" : "confirmed by the agent";
          markVerified(factor.evidence);
        }
      } else if (a.type === "confirm" && a.target === "issue") {
        if (a.issue) issueChoice = a.issue;
        else issueConfirmedInPanel = true;
      } else if (a.type === "confirm" && a.target === "order") {
        orderConfirmedInPanel = true;
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

      for (const mention of findOrderMentions(line.text, idLengths, expecting === "order")) callerMentions.push({ mention, ev });

      if (!locked) {
        // The factor the agent asked for; the other only counts if volunteered as a clear match.
        if (expecting === "name") hear(name, line, ev);
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
      const asks = agentAsksFor(line.text, !verified() && !locked);
      if (!asks && (expecting === "name" || expecting === "address")) expecting = null;
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
        const fitsChoice =
          choice.value === "refund" ? /\b(refund|money)\b/i.test(line.text) || /\b(done|all set)\b/i.test(line.text) : !/\brefund\b/i.test(line.text);
        const aboutChoice =
          choice.value === "refund"
            ? /\b(refund|money|dollars|visa|card)\b|\$\d/i.test(line.text)
            : /\b(ships?|shipping|replacement|new (one|\w+))\b/i.test(line.text) && !/\brefund\b/i.test(line.text);
        if (commit && fitsChoice && readyToApprove()) {
          given.push({ at: line.endedAt, via: "call", evidence: ev });
          unheardApproval = null;
        } else if (aboutChoice && readyToApprove() && !given.some((g) => g.at > choice!.evidence.at)) {
          // About the chosen outcome, but no approval heard in it: flag it, and let the second speech model
          // hear it again (call 7: "offset a full refund" for "I've set up a full refund").
          unheardApproval = { ev, value: choice.value === "refund" ? "refund" : "replacement" };
          keyAnswers.push(line.key);
        }
        // An unclear agent line once the customer has chosen may carry the approval or the terms: check it too.
        if (ev.lowConfidence && !keyAnswers.includes(line.key)) keyAnswers.push(line.key);
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
    const { mention, ev } = latestCaller[0];
    const reading = mention.method === "sound-alike" ? `probably ${mention.candidates[0]}` : mention.candidates[0];
    order.heard = { text: mention.heard, reading, method: mention.method, evidence: ev };
    order.state = "heard";
  }
  if (isVerified) {
    const sources = [...latestCaller, ...agentMentionsAfterVerify];
    const found = matchOrder(sources.map((s) => s.mention), customerOrders, pack.policy.claimWindowDays);
    if (found) {
      const source = sources.find((s) => s.mention === found.mention);
      const readBack = agentMentionsAfterVerify.find(
        (a) => !a.ev.lowConfidence && a.mention.candidates.includes(found.order.id)
      );
      const needsConfirmation = found.needsConfirmation || !!source?.ev.lowConfidence;
      order.state = "matched";
      order.match = {
        order: orderView(found.order, now),
        method: found.method,
        note: found.note,
        needsConfirmation,
        confirmed: !!readBack || orderConfirmedInPanel,
        confirmedBy: readBack?.ev ?? (orderConfirmedInPanel ? "panel" : undefined),
        evidence: source?.ev,
      };
    } else if (latestCaller.length) {
      order.state = "unmatched";
    }
  }
  const match = order.match;
  const orderReady = !!match && (!match.needsConfirmation || match.confirmed);

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
    if (choice && choice.value !== "both" && orderReady) {
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
                `${o.shortName} at no charge, ${pack.policy.replacementShipping}`,
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
          ? `Replace the ${o.shortName} at no charge; it ships by ${pack.policy.replacementShipping}. Email a prepaid return label.`
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
      // An approval counts only for the outcome it was given for, on what the copilot knew then: the
      // lines and checked results that had arrived, and the agent's corrections and choices so far. A
      // correction typed or a check finished later, a change of mind or an order found later all need a
      // fresh approval (outside review, 12 Oct). The first approval that holds is the one recorded.
      for (const a of [...given].sort((x, y) => x.at - y.at)) {
        const then = rules(pack, lines.filter((l) => (l.availableAt ?? l.endedAt) <= a.at), actions.filter((x) => x.at <= a.at), a.at, hints, true);
        const r = then.recommendation;
        const changedSince = choiceChanges.some((t) => t > a.at);
        if (!changedSince && r?.prepared && r.scenario === scenario && r.prepared.kind === prepared.kind && then.order.match?.order.id === o.id) {
          recommendation.approval = { state: "approved", ...a, by: `${pack.agent.name} (${pack.agent.id})` };
          recommendation.staleApproval = undefined;
          break;
        }
        const reason = notCovered(then, prepared.kind, o.id);
        recommendation.staleApproval = { ...a, reason: changedSince && reason === "the outcome has changed since" ? "the customer changed their choice after it" : reason };
      }
      if (recommendation.approval.state === "awaiting" && unheardApproval?.value === prepared.kind && choice && unheardApproval.ev.at > choice.evidence.at) {
        recommendation.unheardApproval = unheardApproval.ev;
      }
      if (lowConfidenceChoice) {
        // A possible change of mind: nothing is approved until the agent confirms what the customer wants.
        const held = recommendation.approval.state === "approved" ? recommendation.approval : recommendation.staleApproval;
        recommendation.approval = { state: "not-ready" };
        if (held?.at !== undefined && held.via) {
          recommendation.staleApproval = { at: held.at, via: held.via, evidence: held.evidence, reason: "the customer may have changed their mind" };
        }
      }
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
  for (const f of [name, address]) {
    if (f.state === "confirm" && f.evidence) {
      prompts.push({
        target: f.id,
        askAgain: f.confirmReason === "disagree" || f.confirmReason === "ambiguous" || undefined,
        text:
          f.confirmReason === "disagree"
            ? `Heard "${f.heard}", first heard as "${f.evidence.firstHeard}". The two speech models disagree, so this isn't counted as a wrong answer. Ask the caller to repeat it, or type what they said.`
            : f.confirmReason === "ambiguous"
            ? `Heard "${f.heard}". It names more than one ${f.id === "name" ? "name" : "address"}, or denies part of one, so it isn't counted either way. Ask for the ${f.id === "name" ? "full name" : "street and city"} once more.`
            : f.confirmReason === "sounds-like"
            ? `Heard "${f.heard}". It sounds like the ${f.id === "name" ? "name" : "address"} on the order but isn't a clear match. Ask the caller to repeat it, or confirm if you heard it clearly.`
            : f.confirmReason === "garbled"
              ? `Heard "${f.heard}", which looks garbled (the same words repeated). Ask the caller to repeat it, or confirm if you heard it clearly.`
              : (f.id === "name" ? matchName(f.heard ?? f.evidence.text, customer) : matchAddress(f.heard ?? f.evidence.text, customer)) === "match"
              ? `Heard "${f.heard ?? f.evidence.text}" with low confidence. Ask the caller to repeat it, or confirm if you heard it clearly.`
              : `Heard "${f.heard ?? f.evidence.text}" with low confidence, and it doesn't match the ${f.id === "name" ? "name" : "address"} on the order. Ask the caller to repeat it, or type what they said. Confirm only if you clearly heard the ${f.id === "name" ? "name" : "address"} on the order; it is recorded as confirmed by you.`,
        evidence: f.evidence,
      });
    } else if (f.state === "partial" && f.evidence && !locked && pending?.factor !== f) {
      // The caller has finished and only part of the answer matched: never a failed attempt, nothing to confirm.
      prompts.push({
        target: f.id,
        text: `Heard "${f.heard}", which matches only part of the ${f.id === "name" ? "name" : "address"} on the order. Ask for the ${f.id === "name" ? "full name" : "street and city"} again, without saying which part didn't match.`,
        evidence: f.evidence,
        askAgain: true,
      });
    }
  }
  if (match && match.needsConfirmation && !match.confirmed) {
    prompts.push({ target: "order", text: `${match.note} Read the order number back to the caller.`, evidence: match.evidence });
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
    { id: "name", label: "Verify: full name", status: factorStep(name), detail: name.state === "ok" && name.method ? `By ${name.method}` : factorDetail(name), evidence: name.evidence, sopRef: ref("Verification") },
    {
      id: "address",
      label: "Verify: email, or street and city",
      status: factorStep(address),
      detail: address.state === "ok" ? `By ${address.method}` : factorDetail(address),
      evidence: address.evidence,
      sopRef: ref("Verification"),
    },
    {
      id: "order",
      label: "Locate the order",
      status: !isVerified ? (locked ? "blocked" : "pending") : !match ? "pending" : orderReady ? "done" : "attention",
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
      status: escalate ? "pending" : approved ? "done" : "pending",
      detail: approved ? (recommendation?.approval.via === "call" ? "Confirmed on the call" : "Approved in the panel") : undefined,
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
  const reply = (text: string, section: string) => ({ text, sopRef: ref(section), basis: "rules" as const });
  let suggestedReply: CopilotView["suggestedReply"] = null;
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
      suggestedReply = reply("I wasn't able to match those details. Could you check them and try once more?", "Verification");
    } else if (name.state === "confirm") {
      suggestedReply = reply("Sorry, could you say your full name once more?", "Verification");
    } else if (name.state === "partial") {
      suggestedReply = reply("Thank you. And your last name, please?", "Verification");
    } else if (name.state === "idle") {
      suggestedReply = reply(
        earlyOffers.length
          ? "Before I arrange anything, I need to check a couple of details. Can I have your full name, please?"
          : "I'm sorry to hear that. Before I look at the order, can I have your full name, please?",
        "Verification"
      );
    } else if (name.state === "ok" && address.state === "idle") {
      suggestedReply = reply("Thank you. And the email address on the order, or the street and city for the delivery?", "Verification");
    } else if (address.state === "partial" || address.state === "confirm") {
      suggestedReply = reply("Sorry, could you give me the street and the city once more?", "Verification");
    } else if (isVerified && !match) {
      suggestedReply = reply(`Thanks, ${firstName}, you're verified. Could you give me the order number, please?`, "Verification");
    } else if (isVerified && o && match && !orderReady) {
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
      const told = normalize(
        ordered
          .filter((l) => l.side === "agent" && l.startedAt >= since && !evidenceOf(l).lowConfidence)
          .map((l) => l.text)
          .join(" ")
      );
      const says = (pattern: RegExp) => {
        const found = findPhrase(told, pattern);
        return !!found && !found.negated;
      };
      // Every amount and card number said must be the record's, and the record's must be said.
      const cents = Math.round((o.price % 1) * 100);
      const amounts = [...told.matchAll(/\$ ?(\d+)(?: (\d{2})\b)?|\b(\d+) dollars\b/g)].map((m) => ({ whole: Number(m[1] ?? m[3]), cents: Number(m[2] ?? 0) }));
      const rightAmount = amounts.length > 0 && amounts.every((a) => a.whole === Math.floor(o.price) && a.cents === cents);
      const last4 = o.payment?.match(/\d{4}$/)?.[0];
      const cards = [...told.matchAll(/\bending (?:in )?(\d[\d ]*\d)\b/g)].map((m) => m[1].replace(/ /g, ""));
      const rightCard = last4 ? cards.length > 0 && cards.every((c) => c === last4) : says(/\boriginal payment\b/);
      const spelled = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
      const [low, high] = (pack.policy.refundTiming.match(/\d+/g) ?? []).map((n) => `(${n}|${spelled[Number(n)] ?? n})`);
      const terms =
        recommendation.prepared.kind === "refund"
          ? [
              { said: says(/\brefund/) && rightAmount && rightCard, text: `I've set up a full refund of ${money(o.price)} to your ${o.payment ?? "original payment method"}.` },
              {
                said: says(/\bscan/) && says(new RegExp(`\\b${low} to ${high} (business )?days\\b`)),
                text: `It's issued when the carrier scans the return and takes ${pack.policy.refundTiming} to appear.`,
              },
              { said: says(/\blabel\b/), text: "You'll get an email with a free return label." },
            ]
          : [
              { said: says(/\bships?\b/), text: `The new ${o.noun} ships today.` },
              { said: says(/\blabel\b/), text: "You'll get an email with a free return label for the damaged one." },
            ];
      const unsaid = terms.filter((t) => !t.said).map((t) => t.text);
      suggestedReply = unsaid.length
        ? reply(unsaid.join(" "), recommendation.prepared.kind === "refund" ? "Scenario B" : "Scenario A")
        : reply("Is there anything else I can help with?", "Required documentation");
    } else if (approved) {
      suggestedReply = reply("Is there anything else I can help with?", "Required documentation");
    }
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
      value: approved && recommendation ? `${pack.agent.name} (${pack.agent.id}), ${recommendation.approver}, ${clock(recommendation.approval.at ?? now)}` : null,
    },
    { label: "Customer communication", value: approved ? "Confirmation email and prepaid return label (prepared; nothing is sent in this demo)" : null },
  ];

  return {
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
  };
}
