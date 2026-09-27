import { findOrderMentions, matchOrder, type MentionMethod, type OrderMention } from "./orders";
import { agentAsksFor, agentCommits, agentDisclosesFactor, agentOffers, escalationWords, readChoice, readIntent, safetyWords, type Choice } from "./signals";
import type { AgentAction, AuthorityBand, ClientPack, Customer, Order, Side, TranscriptEvent } from "./types";
import { matchAddress, matchName } from "./verification";

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

export type Evidence = { key: string; seq: number; side: Side; text: string; at: number; lowConfidence: boolean };

export type FactorState = "idle" | "asking" | "partial" | "confirm" | "ok" | "failed";
export type Factor = { id: "name" | "address"; label: string; state: FactorState; attempts: number; method?: string; evidence?: Evidence };

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

export type ConfirmPrompt = { target: "issue" | "name" | "address" | "order" | "choice"; text: string; evidence?: Evidence };

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
};

export type CopilotView = {
  callId: string | null;
  lineCount: number;
  intent: {
    id: "damaged" | "order-status";
    label: string;
    category: string;
    sopId: string | null;
    certainty: "high" | "low";
    confidence: number;
    phrases: string[];
    evidence: Evidence[];
    /** "model" when only the local model could read the line; always low certainty. */
    source: "rules" | "model";
  } | null;
  verification: { factors: Factor[]; verified: boolean; verifiedAt?: Evidence; locked: boolean; attemptsLeft: number };
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
};

const DAY = 86_400_000;

const evidenceOf = (l: TranscriptEvent): Evidence => ({
  key: l.key,
  seq: l.seq,
  side: l.side,
  text: l.text,
  at: l.startedAt,
  lowConfidence: l.confidence !== null && l.confidence < LOW_CONFIDENCE,
});

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

/** The rules in one pass over the call. `now` fixes "delivered yesterday" and approval times for tests. */
export function analyze(pack: ClientPack, lines: TranscriptEvent[], actions: AgentAction[] = [], now = Date.now(), hints: ModelHints = {}): CopilotView {
  const sopId = pack.sop.id;
  const ref = (section: string) => `${sopId} · ${section}`;
  const customer: Customer = pack.customers.find((c) => c.id === pack.callerCustomerId)!;
  const customerOrders = pack.orders.filter((o) => o.customerId === customer.id);
  const idLengths = [...new Set(pack.orders.map((o) => o.id.length))];
  const firstName = customer.name.split(" ")[0];

  // Speech order, not arrival order: the two sides are recognised separately.
  const ordered = [...lines].sort((a, b) => a.startedAt - b.startedAt || a.seq - b.seq);
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
  let choice: CopilotView["choice"] = null;
  let askedBoth: Evidence | null = null;
  const escalations: { kind: "words" | "safety"; phrase: string; ev: Evidence }[] = [];
  const earlyOffers: Evidence[] = [];
  const offersInEscalation: Evidence[] = [];
  const disclosures: Evidence[] = [];
  const prompts: ConfirmPrompt[] = [];
  let lowConfidenceChoice: Evidence | null = null;
  let orderConfirmedInPanel = false;
  let issueConfirmedInPanel = false;
  let approval: Recommendation["approval"] = { state: "not-ready" };

  const verified = () => name.state === "ok" && address.state === "ok";
  const markVerified = (ev: Evidence) => {
    if (verified() && !verifiedAt) verifiedAt = ev;
  };

  function answer(factor: Factor, result: "match" | "partial" | "mismatch" | "none", ev: Evidence, asked: boolean, method?: string) {
    if (factor.state === "ok" || locked) return;
    if (result === "match") {
      if (ev.lowConfidence) {
        factor.state = "confirm";
        factor.evidence = ev;
      } else {
        factor.state = "ok";
        factor.evidence = ev;
        factor.method = method;
        markVerified(ev);
      }
    } else if (asked && result === "partial") {
      factor.state = "partial";
      factor.evidence = ev;
    } else if (asked && result === "mismatch") {
      if (ev.lowConfidence) {
        // A doubtful line never counts as a failed attempt; ask again instead.
        factor.state = "confirm";
        factor.evidence = ev;
        return;
      }
      factor.attempts++;
      factor.state = "failed";
      factor.evidence = ev;
      if (factor.attempts >= pack.policy.maxVerificationAttempts) locked = true;
    }
  }

  for (const item of timeline) {
    if (item.kind === "action") {
      const a = item.action;
      if (a.type === "confirm" && (a.target === "name" || a.target === "address")) {
        const factor = a.target === "name" ? name : address;
        if (factor.state === "confirm" && factor.evidence && !locked) {
          factor.state = "ok";
          factor.method = factor.method ?? (a.target === "address" ? "confirmed by the agent" : undefined);
          markVerified(factor.evidence);
        }
      } else if (a.type === "confirm" && a.target === "issue") {
        issueConfirmedInPanel = true;
      } else if (a.type === "confirm" && a.target === "order") {
        orderConfirmedInPanel = true;
      } else if (a.type === "confirm" && a.target === "choice" && lowConfidenceChoice) {
        const found = readChoice(lowConfidenceChoice.text);
        if (found) choice = { value: found.choice, evidence: lowConfidenceChoice };
        lowConfidenceChoice = null;
      } else if (a.type === "approve" && approval.state !== "approved") {
        approval = { state: "approved", at: a.at, via: "panel" };
      }
      continue;
    }

    const line = item.line;
    const ev = evidenceOf(line);

    if (line.side === "caller") {
      for (const found of readIntent(line.text)) {
        if (found.score < 0.5) continue;
        // Keep building the same intent; switch only to a clearly stronger different one.
        const prev = intent as CopilotView["intent"];
        if (prev && prev.id !== found.id && found.score <= prev.confidence) continue;
        const same = prev?.id === found.id ? prev : null;
        const certainHere = found.score >= 0.8 && !ev.lowConfidence;
        intent = {
          id: found.id,
          label: found.id === "damaged" ? "Order issue: damaged on arrival" : "Order status",
          category: "Orders and delivery",
          sopId: found.id === "damaged" ? sopId : null,
          certainty: same?.certainty === "high" || certainHere ? "high" : "low",
          confidence: same ? Math.max(same.confidence, found.score) : found.score,
          phrases: [...new Set([...(same?.phrases ?? []), ...found.evidence])].slice(0, 4),
          evidence: [...(same?.evidence ?? []), ev].slice(0, 3),
          source: "rules",
        };
      }

      for (const mention of findOrderMentions(line.text, idLengths, expecting === "order")) callerMentions.push({ mention, ev });

      if (!locked) {
        const nameResult = matchName(line.text, customer);
        answer(name, nameResult, ev, expecting === "name");
        const addressResult = matchAddress(line.text, customer);
        const byEmail = /\b(at|@)\b/.test(line.text.toLowerCase()) && addressResult === "match" && !/\broad\b/i.test(line.text);
        answer(address, addressResult, ev, expecting === "address", byEmail ? "email" : "street and city");
      }

      const wants = readChoice(line.text);
      if (wants?.choice === "both") askedBoth = ev;
      else if (wants && ev.lowConfidence) lowConfidenceChoice = ev;
      else if (wants) {
        choice = { value: wants.choice, evidence: ev };
        lowConfidenceChoice = null;
      }

      for (const phrase of escalationWords(line.text)) escalations.push({ kind: "words", phrase, ev });
      for (const phrase of safetyWords(line.text)) escalations.push({ kind: "safety", phrase, ev });

      if (expecting && expecting !== "order") {
        const factor = expecting === "name" ? name : address;
        if (factor.state !== "partial") expecting = null;
      } else if (expecting === "order" && callerMentions.length) expecting = null;
    } else {
      const offer = agentOffers(line.text);
      if (offer && !verified()) earlyOffers.push(ev);
      if (offer && escalations.length) offersInEscalation.push(ev);

      const asks = agentAsksFor(line.text);
      if (asks) {
        expecting = asks;
        const factor = asks === "name" ? name : asks === "address" ? address : null;
        if (factor && (factor.state === "idle" || factor.state === "failed" || factor.state === "partial")) factor.state = "asking";
      }

      if (verified()) for (const mention of findOrderMentions(line.text, idLengths)) agentMentionsAfterVerify.push({ mention, ev });

      if (name.attempts + address.attempts > 0 && agentDisclosesFactor(line.text)) disclosures.push(ev);

      // "Done. The new tablet ships today." after the customer chose is the agent's approval on the call.
      const offeringOptions = /\?/.test(line.text) && /\bor\b/i.test(line.text);
      if (choice && !offeringOptions && !ev.lowConfidence && approval.state !== "approved" && verified() && !escalations.length) {
        const commit = agentCommits(line.text);
        const fitsChoice =
          choice.value === "refund" ? /\b(refund|money)\b/i.test(line.text) || /\b(done|all set)\b/i.test(line.text) : !/\brefund\b/i.test(line.text);
        if (commit && fitsChoice && ev.at > choice.evidence.at) approval = { state: "approved", at: line.endedAt, via: "call", evidence: ev };
      }
    }
  }

  const hinted = hints.intent && ordered.find((l) => l.key === hints.intent!.key);
  if (!intent && hints.intent && hinted) {
    const damaged = hints.intent.id === "damaged";
    intent = {
      id: hints.intent.id,
      label: damaged ? "Order issue: damaged on arrival" : "Order status",
      category: "Orders and delivery",
      sopId: damaged ? sopId : null,
      certainty: "low",
      confidence: 0.5,
      phrases: ["read by the local model"],
      evidence: [evidenceOf(hinted)],
      source: "model",
    };
  }
  if (intent && issueConfirmedInPanel) intent = { ...intent, certainty: "high" };
  const isVerified = verified();
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
  } else if (isVerified && match && band) {
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
      approval: prepared ? (approval.state === "approved" ? { ...approval, by: `${pack.agent.name} (${pack.agent.id})` } : { state: "awaiting" }) : { state: "not-ready" },
    };
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
      resolved: verifiedAt ? `Identity verified at ${clock(verifiedAt.at)}.` : undefined,
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
      prompts.push({ target: f.id, text: `Heard "${f.evidence.text}" with low confidence. Ask the caller to repeat it, or confirm if you heard it clearly.`, evidence: f.evidence });
    }
  }
  if (match && match.needsConfirmation && !match.confirmed) {
    prompts.push({ target: "order", text: `${match.note} Read the order number back to the caller.`, evidence: match.evidence });
  }
  if (lowConfidenceChoice) {
    prompts.push({ target: "choice", text: `Heard "${lowConfidenceChoice.text}" with low confidence. Confirm what the customer wants.`, evidence: lowConfidenceChoice });
  }
  if (intent?.certainty === "low" && intent.evidence[0]) {
    prompts.push({
      target: "issue",
      text:
        intent.source === "model"
          ? `Only the local model read this as "${intent.label}". Confirm the problem with the caller.`
          : `The issue was heard with low certainty ("${intent.phrases[0]}"). Confirm the damage with the caller.`,
      evidence: intent.evidence[0],
    });
  }

  /* ---------- SOP steps ---------- */
  const factorStep = (f: Factor): StepStatus =>
    locked && f.state !== "ok" ? "blocked" : f.state === "ok" ? "done" : f.state === "confirm" || f.state === "failed" || f.state === "partial" ? "attention" : f.state === "asking" ? "active" : "pending";
  const approved = recommendation?.approval.state === "approved";
  const steps: SopStep[] = [
    {
      id: "issue",
      label: "Identify the issue",
      status: !intent ? "pending" : intent.certainty === "high" ? "done" : "attention",
      detail: intent ? intent.label : undefined,
      evidence: intent?.evidence[0],
      sopRef: sopId,
    },
    { id: "name", label: "Verify: full name", status: factorStep(name), detail: name.state === "failed" ? `Not matched (${name.attempts})` : undefined, evidence: name.evidence, sopRef: ref("Verification") },
    {
      id: "address",
      label: "Verify: email, or street and city",
      status: factorStep(address),
      detail: address.state === "ok" ? `By ${address.method}` : address.state === "failed" ? `Not matched (${address.attempts})` : undefined,
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
      status: match?.confirmed ? "done" : "pending",
      detail: match?.confirmed ? (match.confirmedBy === "panel" ? "Confirmed by the agent" : "Order read back by the agent") : undefined,
      evidence: typeof match?.confirmedBy === "object" ? match.confirmedBy : undefined,
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
      status: escalate ? "skipped" : choice ? "done" : "pending",
      detail: escalate ? "Not offered: Scenario C" : choice ? (choice.value === "replacement" ? "Replacement" : "Refund") : askedBoth ? "Asked about both" : undefined,
      evidence: choice?.evidence ?? askedBoth ?? undefined,
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
  } else if (intent || earlyOffers.length) {
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
    } else if (isVerified && o && match && !match.confirmed && !choice && !askedBoth) {
      suggestedReply = reply(
        `Thanks, ${firstName}, you're verified. I can see the ${o.shortName} on order ${o.id}, delivered ${o.deliveredLabel}. I can ship a replacement today at no cost, with a free return label for the damaged one, or give you a full refund if you'd prefer.`,
        "Scenario A"
      );
    } else if (o && !choice) {
      suggestedReply = reply(
        `You can have either. A new ${o.noun} ships today at no cost, or a full refund in ${pack.policy.refundTiming}. Which do you prefer?`,
        "Scenario A and B"
      );
    } else if (o && recommendation?.prepared && !approved) {
      suggestedReply =
        recommendation.prepared.kind === "replacement"
          ? reply(`Done. The new ${o.noun} ships today. You'll get an email with a free return label for the damaged one.`, "Scenario A")
          : reply(
              `I've set up a full refund of ${money(o.price)} to your ${o.payment ?? "original payment method"}. It's issued when the carrier scans the return and takes ${pack.policy.refundTiming} to appear. You'll get an email with a free return label.`,
              "Scenario B"
            );
    } else if (approved) {
      suggestedReply = reply("Is there anything else I can help with?", "Required documentation");
    }
  }

  /* ---------- Documentation (filled once approved; nothing is sent) ---------- */
  const damage = intent?.phrases[0];
  const documentation = [
    {
      label: "Case summary",
      value:
        isVerified && o
          ? `${customer.name} (${customer.id}), order ${o.id} ${o.shortName}${damage ? `, damage: "${damage}"` : ""}, verified by full name and ${address.method ?? "second factor"}`
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
    verification: { factors: [name, address], verified: isVerified, verifiedAt, locked, attemptsLeft },
    order,
    checks,
    choice,
    recommendation,
    suggestedReply,
    alerts,
    prompts,
    steps,
    documentation,
  };
}
