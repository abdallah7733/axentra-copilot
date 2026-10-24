/*
  The per-case workflow runner (03_EXPECTED_OUTCOMES, sections 2 and 2a). Each case is an
  independent test: a new call on its own evaluation record, brought to the case's starting state
  by the harness, then the case's recognised lines, then the copilot's view read as L3 (fields)
  and L4 (workflow). Nothing carries over from one case to the next: every run starts empty.

  The starting state is set the way the agent would set it, never from recognised speech:
  identity from typed corrections (the agent's typed-input mechanism), the issue from the panel's
  "arrived damaged" choice, the replacement from a typed choice, the item from the agent's
  read-back, and the approval from the panel's Approve. Only the case's own lines are speech.

  The copilot rules are called exactly as the console calls them (analyze), unchanged.
*/

import { ADDRESS_READ_BACK, ANSWER_GAP_MS, NAME_READ_BACK, analyze, type CopilotView } from "@/lib/copilot/copilot";
import type { AgentAction, ClientPack, TranscriptEvent } from "@/lib/copilot/types";
import { CHECK_TIMEOUT_MS } from "@/lib/live/engine";
import type { DevCase } from "./cases";
import { addressCodes, fieldsOf, nameCode, textFieldCodes, type FieldCodes, type FieldResult } from "./fields";
import type { TimesMethod } from "./hypotheses";
import { evalPack } from "./records";

export type WorkflowCode = "DONE_RIGHT" | "CLARIFY" | "NO_EFFECT" | "MISSED" | "UNSAFE" | "LOST";

/** One recognised line of a case. Times are seconds from the start of the case. */
export type CaseLine = {
  side: "agent" | "caller";
  /** First-pass text (L1), after the engine's filters. */
  first: string;
  /** Checked text (L2), when the second model checked the line. */
  checked?: string;
  checkFailed?: boolean;
  /** The first pass's confidence. */
  confidence?: number | null;
  /** The check's own confidence: the console puts it on the line with the checked text (store.ts). */
  checkedConfidence?: number | null;
  start: number;
  end: number;
  /** When the first text was on screen; defaults to 1 s after the line ends. */
  firstAt?: number;
  /** When the checked text (or a failed check) landed; defaults to 2 s after the first text. */
  checkedAt?: number;
  /**
   * A replay: the soonest the check could land after the first text. The engine's own time for an answered
   * check (its elapsedMs), or the wait of a check that timed out (it can't have answered sooner).
   */
  checkEngineS?: number;
};

export type WorkflowResult = {
  view: CopilotView;
  /** The view after the agent's cue, before the caller's line: what "no effect" is judged against. */
  before: CopilotView;
  l3: FieldCodes;
  l4: WorkflowCode;
  note: string;
  /** Prompts about the case's step still waiting for the agent at the end (for a no-effect case: prompts its line added). */
  confirmationTurns: number;
  /** Seconds from the end of the caller's speech until every field of the case was first OK at L3; null if never or not timed. */
  correctFieldS: number | null;
  /** A replay (checks "all"): with 9 s checks, early checks or later first passes 1.5 s late (all, or one at a time), the console would hold a different set of caller lines. */
  timingDependent: boolean;
};

/** A fixed clock, so "delivered today" and every time in the view are the same on every run. */
const T0 = Date.parse("2026-10-19T09:00:00.000Z");
const CASE_START = T0 + 120_000;
const at = (s: number) => T0 + Math.round(s * 1000);
const inCase = (s: number) => CASE_START + Math.round(s * 1000);

const firstAtOf = (l: CaseLine) => l.firstAt ?? l.end + 1;
const checkedAtOf = (l: CaseLine) => l.checkedAt ?? firstAtOf(l) + 2;
/** When the copilot could use the line's final text. */
const usableAt = (l: CaseLine) => (l.checked !== undefined ? checkedAtOf(l) : firstAtOf(l));
/** A landed check brings its own confidence, as in store.ts; a failed one leaves the first pass's. */
const checkedConfidence = (l: CaseLine, first: number | null) => (l.checkedConfidence !== undefined ? l.checkedConfidence : first);

type Built = { lines: TranscriptEvent[]; actions: AgentAction[] };

/** The lines and panel actions that bring a new call to the case's starting state. */
export function startState(c: DevCase, pack: ClientPack): Built {
  const customer = pack.customers.find((x) => x.id === pack.callerCustomerId)!;
  const lines: TranscriptEvent[] = [];
  const actions: AgentAction[] = [];
  const line = (side: "agent" | "caller", text: string, s: number, e: number) => {
    const n = lines.length + 1;
    lines.push({ callId: `EVAL-${c.id}`, seq: n, key: `s${n}`, side, text, startedAt: at(s), endedAt: at(e), final: true, confidence: 0.95 });
    return `s${n}`;
  };
  /** A caller answer the agent typed: what speech recognition heard is irrelevant, the typed words count. */
  const typed = (text: string, s: number) => actions.push({ type: "correct", key: line("caller", "[start state]", s, s + 1), text, at: at(s + 2) });
  if (c.start.identity !== "none") {
    line("agent", "Can I have your full name, please?", 2, 4);
    typed(customer.name, 5);
  }
  if (c.start.identity === "both") {
    line("agent", "And the street and city for the delivery?", 10, 13);
    typed(`${customer.address.street} in ${customer.address.city}`, 14);
  }
  if (c.start.damage) actions.push({ type: "confirm", target: "issue", issue: "damaged", at: at(20) });
  if (c.start.replacementApproved) {
    const order = pack.orders.find((o) => o.customerId === customer.id)!;
    line("agent", `Just to confirm, that's order ${order.id}, the ${order.shortName}?`, 25, 28);
    line("agent", "Which do you prefer, a replacement or a refund?", 30, 33);
    typed("A replacement, please.", 34);
    actions.push({ type: "approve", at: at(40) });
  }
  return { lines, actions };
}

/** The case's lines as transcript events, with the text available at `t` (seconds from the case start), or all final text. */
function caseEvents(c: DevCase, caseLines: CaseLine[], firstSeq: number, t = Infinity): TranscriptEvent[] {
  return caseLines.flatMap((l, i): TranscriptEvent[] => {
    if (firstAtOf(l) > t) return [];
    const base = { callId: `EVAL-${c.id}`, seq: firstSeq + i, key: `c${i + 1}`, side: l.side, startedAt: inCase(l.start), endedAt: inCase(l.end), final: true as const, confidence: l.confidence ?? 0.9 };
    if (l.checked === undefined) return [{ ...base, text: l.first, availableAt: inCase(firstAtOf(l)), ...(l.checkFailed ? { checkFailed: true } : {}) }];
    // While the check runs the copilot leaves the line out, as on a live call.
    if (checkedAtOf(l) > t) return [{ ...base, text: l.first, availableAt: inCase(firstAtOf(l)), checking: true }];
    return [{ ...base, text: l.checked, confidence: checkedConfidence(l, base.confidence), availableAt: inCase(checkedAtOf(l)), ...(l.checked !== l.first ? { firstHeard: l.first } : {}) }];
  });
}

/**
 * Which case lines the console would have held for the second model's check, as copilot-store.ts decides
 * it: a line arriving while the copilot awaits an answer (issue, name, address or choice), and any line
 * the copilot names as a key answer once a later line or check result arrives. The settle re-run after
 * the answer gap refreshes the view the next line is judged against. Used when a replay checked every
 * caller line (checks "all"): the copilot then sees a checked text, with the check's own confidence,
 * only where the console would have asked for one, at an estimated moment (the line times given). A
 * line the console would check but the file has no check for (an agent line) keeps its first text.
 */
export function consoleChecks(c: DevCase, pack: ClientPack, built: Built, caseLines: CaseLine[]): { lines: CaseLine[]; checked: number[] } {
  const firstSeq = built.lines.length + 1;
  // A blank first pass never reaches the console (store.ts drops it), so it can't be held for a check.
  const hasCheck = (l: CaseLine) => !!l.first.trim() && (l.checked !== undefined || !!l.checkFailed);
  const duration = (l: CaseLine) => checkedAtOf(l) - firstAtOf(l);
  const requestedAt = new Map<number, number>();
  const ignored = new Set(built.lines.map((l) => l.key));
  type Ev = { t: number; i: number; kind: "first" | "checked" };
  const queue: Ev[] = caseLines.map((l, i) => ({ t: firstAtOf(l), i, kind: "first" as const }));
  const arrived = new Set<number>();
  const done = new Set<number>();
  // The case's lines as the console holds them at a moment: first text, held for a check, or the check's result.
  const events = (): TranscriptEvent[] =>
    caseLines.flatMap((l, i): TranscriptEvent[] => {
      if (!arrived.has(i)) return [];
      const base = { callId: `EVAL-${c.id}`, seq: firstSeq + i, key: `c${i + 1}`, side: l.side, startedAt: inCase(l.start), endedAt: inCase(l.end), final: true as const, confidence: l.confidence ?? 0.9, availableAt: inCase(firstAtOf(l)) };
      if (!requestedAt.has(i)) return [{ ...base, text: l.first }];
      if (!done.has(i)) return [{ ...base, text: l.first, checking: true }];
      if (l.checked === undefined) return [{ ...base, text: l.first, checkFailed: true }];
      return [{ ...base, text: l.checked, confidence: checkedConfidence(l, base.confidence), ...(l.checked !== l.first ? { firstHeard: l.first } : {}) }];
    });
  const view = (t: number) => analyze(pack, [...built.lines, ...events()], built.actions, inCase(t));
  const request = (i: number, t: number) => {
    if (requestedAt.has(i) || !hasCheck(caseLines[i])) return;
    requestedAt.set(i, t);
    queue.push({ t: t + duration(caseLines[i]), i, kind: "checked" });
  };
  let last: number | null = null;
  while (queue.length) {
    queue.sort((a, b) => a.t - b.t || a.i - b.i);
    const ev = queue.shift()!;
    if (ev.kind === "first") {
      // The view the console holds when the line arrives: from the last line event, or its settle re-run.
      const seen = last === null ? ev.t : ev.t - last >= (ANSWER_GAP_MS + 100) / 1000 ? last + (ANSWER_GAP_MS + 100) / 1000 : last;
      if (caseLines[ev.i].side === "caller" && view(seen).awaiting) request(ev.i, ev.t);
      arrived.add(ev.i);
    } else done.add(ev.i);
    for (const key of view(ev.t).keyAnswers) {
      if (ignored.has(key)) continue;
      const i = Number(key.slice(1)) - 1;
      if (key.startsWith("c") && !requestedAt.has(i)) request(i, ev.t);
    }
    last = ev.t;
  }
  const lines = caseLines.map((l, i): CaseLine => {
    if (requestedAt.has(i)) return { ...l, checkedAt: requestedAt.get(i)! + duration(l) };
    const rest = { ...l };
    delete rest.checked;
    delete rest.checkFailed;
    delete rest.checkedAt;
    return rest;
  });
  return { lines, checked: [...requestedAt.keys()].sort((a, b) => a - b) };
}

/** The copilot's decisions, for judging whether a line changed anything (NO_EFFECT vs UNSAFE). */
function decisions(v: CopilotView) {
  return {
    intent: v.intent ? `${v.intent.id}/${v.intent.certainty}` : null,
    identity: v.verification.factors.map((f) => `${f.id}:${f.state}:${f.attempts}`).join(" ") + (v.verification.locked ? " locked" : ""),
    order: v.order.match ? `${v.order.match.order.id}${v.order.match.confirmed ? " confirmed" : ""}` : v.order.state,
    choice: v.choice?.value ?? null,
    approval: v.recommendation ? `${v.recommendation.scenario}:${v.recommendation.approval.state}` : null,
  };
}

const factor = (v: CopilotView, id: "name" | "address") => v.verification.factors.find((f) => f.id === id)!;

/** L3: what the copilot read, from its view. A value present across lines but never assembled is SPLIT. */
export function copilotFieldCodes(c: DevCase, view: CopilotView, before: CopilotView, callerTexts: string[]): FieldCodes {
  const codes: FieldCodes = {};
  const e = c.expected;
  const joined = textFieldCodes(c, callerTexts);
  const split = (field: keyof FieldCodes, r: FieldResult): FieldResult =>
    r.code !== "OK" && callerTexts.filter((t) => t.trim()).length > 1 && joined[field]?.code === "OK" ? { code: "SPLIT", note: `parts on separate lines, not joined (read: ${r.code}${r.note ? `, ${r.note}` : ""})` } : r;
  for (const field of fieldsOf(c)) {
    if (field === "order_id" && e.order_id) {
      const heard = view.order.heard;
      const read = heard?.reading.replace(/^probably /, "");
      const r: FieldResult = read
        ? read === e.order_id
          ? { code: "OK", note: heard!.method }
          : read.length < e.order_id.length && e.order_id.includes(read)
            ? { code: "PARTIAL", note: `read ${read}` }
            : { code: "WRONG", note: `read ${read}` }
        : view.order.match?.method === "only-recent"
          ? { code: "FROM_RECORD", note: `${view.order.match.order.id}, the customer's only recent order` }
          : { code: "MISSING" };
      codes.order_id = split("order_id", r);
    } else if (field === "order_id") {
      codes.order_id = view.order.heard ? { code: "INVENTED", note: `read ${view.order.heard.reading}` } : { code: "OK" };
    } else if (field === "name") {
      const f = factor(view, "name");
      codes.name = split("name", nameCode(f.heard ?? f.evidence?.text ?? "", e.name!));
    } else if (field === "intent") {
      codes.intent = !view.intent ? { code: "MISSING" } : view.intent.id === "damaged" ? { code: "OK", note: `${view.intent.certainty} certainty` } : { code: "WRONG", note: view.intent.label };
    } else if (field === "choice" && e.choice === "replacement") {
      const v = view.choice?.value;
      codes.choice = v === "replacement" ? { code: "OK" } : v === "refund" ? { code: "WRONG", note: "refund" } : v === "both" ? { code: "AMBIGUOUS", note: "both" } : { code: "MISSING" };
    } else if (field === "choice") {
      codes.choice = view.choice?.value === before.choice?.value ? { code: "OK" } : { code: "WRONG", note: `changed to ${view.choice?.value ?? "none"}` };
    } else if (field === "refund_wanted") {
      codes.refund_wanted = view.choice?.value === "refund" ? { code: "WRONG", note: "refund taken as wanted" } : { code: "OK" };
    }
  }
  if (e.street) {
    const f = factor(view, "address");
    const read = addressCodes(f.heard ?? f.evidence?.text ?? "", { house_no: e.house_no!, street: e.street, city: e.city! });
    for (const k of ["house_no", "street", "city", "address"] as const) codes[k] = split(k, read[k]!);
  }
  return codes;
}

const allOk = (codes: FieldCodes) => Object.values(codes).every((r) => r?.code === "OK");

/** L4: what the copilot did with the case's line, from its starting state (scoring file, section 4). */
function workflowCode(c: DevCase, before: CopilotView, view: CopilotView, l3: FieldCodes, callerTexts: string[], pack: ClientPack, built: Built, caseLines: CaseLine[]): { code: WorkflowCode; note: string } {
  if (c.caller.trim() && !callerTexts.some((t) => t.trim())) return { code: "LOST", note: "no caller text reached the copilot" };
  if (c.expected.order_id === undefined && !c.expected.name && !c.expected.street && !c.expected.intent) {
    // D01, D02, D10: correctly doing nothing.
    const [b, a] = [decisions(before), decisions(view)];
    const changed = (Object.keys(a) as (keyof typeof a)[]).filter((k) => a[k] !== b[k]);
    return changed.length ? { code: "UNSAFE", note: `the line changed ${changed.map((k) => `${k} (${b[k]} → ${a[k]})`).join(", ")}` } : { code: "NO_EFFECT", note: "" };
  }
  if (c.expected.intent) {
    // D03: intent and choice read, and no order number taken from the range.
    if (view.choice?.value === "refund") return { code: "UNSAFE", note: "refund set as the choice from a negated phrase" };
    if (view.order.heard) {
      // Would the number match once identity is verified? Verify it the agent's way and look.
      const later = verifyAfter(c, pack, built, caseLines);
      const m = later.order.match;
      if (m && m.method !== "only-recent") return { code: "UNSAFE", note: `"${view.order.heard.text}" read as an order number; it matches order ${m.order.id} once identity is verified` };
    }
    if (!view.intent || view.intent.id !== "damaged" || view.choice?.value !== "replacement") return { code: "MISSED", note: [!view.intent ? "no issue read" : view.intent.id !== "damaged" ? `issue read as ${view.intent.label}` : "", view.choice?.value !== "replacement" ? "no replacement choice read" : ""].filter(Boolean).join("; ") };
    if (view.intent.certainty !== "high") return { code: "CLARIFY", note: "damage heard with low certainty: the copilot asks the agent to confirm it" };
    return { code: "DONE_RIGHT", note: view.order.heard ? `order number "${view.order.heard.text}" read but matches nothing` : "" };
  }
  if (c.expected.order_id) {
    const m = view.order.match;
    if (!m) return { code: "MISSED", note: view.order.state === "unmatched" ? "a number was read but matches none of the customer's orders" : "no order shown" };
    if (m.order.id !== c.expected.order_id) return { code: "UNSAFE", note: `order ${m.order.id} shown for ${c.expected.order_id}` };
    if (!m.needsConfirmation) return { code: "DONE_RIGHT", note: `${m.method}` };
    return { code: "CLARIFY", note: `${m.method}: ${m.note}` };
  }
  const f = factor(view, c.expected.name ? "name" : "address");
  const right = c.expected.name ? l3.name?.code === "OK" : l3.street?.code === "OK" && l3.city?.code === "OK";
  // A read-back and the caller's yes verify the name without recognising it: never scored as recognition (22 Oct).
  if (f.state === "ok" && (f.method === NAME_READ_BACK || f.method === ADDRESS_READ_BACK))
    return { code: "CLARIFY", note: "verified by the agent's read-back and the caller's yes, not by recognition" };
  if (f.state === "ok") return right ? { code: "DONE_RIGHT", note: f.method ?? "" } : { code: "UNSAFE", note: `verified on "${f.heard ?? f.evidence?.text}"` };
  const failed = f.attempts ? `; ${f.attempts} failed attempt${f.attempts > 1 ? "s" : ""} counted` : "";
  if (f.state === "confirm" || f.state === "partial") return { code: "CLARIFY", note: (f.confirmReason ? `please confirm (${f.confirmReason})` : "asks for the rest") + failed };
  if (f.state === "failed") return { code: "CLARIFY", note: `counted as a failed attempt (${f.attempts} of ${pack.policy.maxVerificationAttempts})` };
  return { code: "MISSED", note: `left ${f.state}` };
}

/** The case, then identity verified by typing (as in a starting state), to see what a read number would match. */
function verifyAfter(c: DevCase, pack: ClientPack, built: Built, caseLines: CaseLine[]): CopilotView {
  const customer = pack.customers.find((x) => x.id === pack.callerCustomerId)!;
  const end = Math.max(...caseLines.map(usableAt)) + 5;
  const events = [...built.lines, ...caseEvents(c, caseLines, built.lines.length + 1)];
  const actions = [...built.actions];
  const add = (side: "agent" | "caller", text: string, s: number) => {
    const n = events.length + 1;
    events.push({ callId: `EVAL-${c.id}`, seq: n, key: `v${n}`, side, text, startedAt: inCase(s), endedAt: inCase(s + 1), final: true, confidence: 0.95 });
    return `v${n}`;
  };
  add("agent", "Can I have your full name, please?", end);
  actions.push({ type: "correct", key: add("caller", "[verify]", end + 2), text: customer.name, at: inCase(end + 4) });
  add("agent", "And the street and city for the delivery?", end + 6);
  actions.push({ type: "correct", key: add("caller", "[verify]", end + 8), text: `${customer.address.street} in ${customer.address.city}`, at: inCase(end + 10) });
  return analyze(pack, events, actions, inCase(end + 15));
}

/** What the copilot read (L3) and did (L4) with these case lines, the prompts left, and with `timed` when every field was first right. */
function judge(c: DevCase, pack: ClientPack, built: Built, caseLines: CaseLine[], timed = false): Omit<WorkflowResult, "timingDependent"> {
  const agentLines = caseLines.filter((l) => l.side === "agent");
  const callerLines = caseLines.filter((l) => l.side === "caller");
  const callerTexts = callerLines.map((l) => l.checked ?? l.first);
  const firstSeq = built.lines.length + 1;
  const all = [...built.lines, ...caseEvents(c, caseLines, firstSeq)];
  const lastAgent = agentLines.length ? Math.max(...agentLines.map(usableAt)) : 0;
  // Judged after the agent's cue, and before any caller line had started.
  const beforeT = Math.min(lastAgent + 0.5, ...callerLines.map((l) => l.start));
  const before = analyze(pack, [...built.lines, ...caseEvents(c, agentLines, firstSeq)], built.actions, inCase(beforeT));
  // Judged once everything has arrived and the caller has finished (past the 2 s answer gap).
  const endT = Math.max(lastAgent, ...caseLines.map(usableAt)) + 3;
  const view = analyze(pack, all, built.actions, inCase(endT));
  const l3 = copilotFieldCodes(c, view, before, callerTexts);
  const { code, note } = workflowCode(c, before, view, l3, callerTexts, pack, built, caseLines);
  // Confirmation turns: the prompts about this case's step still waiting at the end (to confirm or ask
  // again). For a case that should change nothing, any prompt its line added.
  const relevant: Record<string, string[]> = { order_id: ["order"], name: ["name"], street: ["address"], intent: ["issue", "choice", "order"] };
  const targets = Object.keys(c.expected).flatMap((k) => relevant[k] ?? []);
  const turns = targets.length
    ? view.prompts.filter((p) => targets.includes(p.target)).length
    : view.prompts.filter((p) => !before.prompts.some((b) => b.target === p.target && b.text === p.text)).length;
  let correctFieldS: number | null = null;
  if (timed && callerLines.length && fieldsOf(c).length) {
    // Step through every moment new caller text arrived; the first moment every field reads OK.
    const tEnd = Math.max(...callerLines.map((l) => l.end));
    const moments = [...new Set(callerLines.flatMap((l) => [firstAtOf(l), ...(l.checked !== undefined ? [checkedAtOf(l)] : [])]))].sort((a, b) => a - b);
    for (const t of moments) {
      const v = analyze(pack, [...built.lines, ...caseEvents(c, caseLines, firstSeq, t)], built.actions, inCase(t));
      const visible = callerLines.filter((l) => usableAt(l) <= t).map((l) => l.checked ?? l.first);
      if (allOk(copilotFieldCodes(c, v, before, visible))) {
        correctFieldS = Math.round((t - tEnd) * 1000) / 1000;
        break;
      }
    }
  }
  return { view, before, l3, l4: code, note, confirmationTurns: turns, correctFieldS };
}

const TIMES_NOTE: Record<TimesMethod, string> = {
  estimated: "check times estimated from the replay (phrase release + measured engine time); the estimate leaves out the 100 ms capture-block lag, waits inside the engine and the GPU shared with running checks",
  synthesized: "check times synthesized (1 s to first text, 2 s checks): which lines the console would check may differ live",
  measured: "",
};
/** The combined pass sends both sides at once, so its measured engine times already include that overlap. */
const COMBINED_NOTE = "check times estimated from the replay (phrase release + measured engine time, which in this combined pass includes the overlap of both sides' requests and the checks); the estimate leaves out the 100 ms capture-block lag";

/**
 * An assumed shared-GPU slowdown, not measured and not given in the step's documents: a first pass running
 * beside a check may land up to this much later.
 */
const SHARED_GPU_S = 1.5;

/**
 * Runs one case from its own starting state on a new call. A blank first pass is dropped first, as the
 * console drops it before the copilot sees it (store.ts). With `checks: "all"` (a replay that checked
 * every caller line), the copilot uses a checked text only where the console would have asked for it.
 * The line times are an estimate, so the case runs again with other times: every check taking as long as
 * the console waits (9 s); every check landing early (after the engine's own time, a timed-out check after
 * its own wait, or at once when neither is recorded); every later first pass 1.5 s late; and each later
 * first pass 1.5 s late on its own, with the check times as estimated and with checks landing early. When
 * any of these changes which caller lines the console would check, the case is timing-dependent and the
 * note says which run changed it and its L4. `combined` marks the replay's combined pass, whose engine
 * times include both sides' overlap.
 */
export function runCase(c: DevCase, given: CaseLine[], opts: { timed?: boolean; checks?: "console" | "all"; times?: TimesMethod; combined?: boolean } = {}): WorkflowResult {
  const pack = evalPack(c.record);
  const built = startState(c, pack);
  const heard = given.filter((l) => l.first.trim());
  if (opts.checks !== "all") return { ...judge(c, pack, built, heard, opts.timed), timingDependent: false };
  const callers = heard.filter((l) => l.side === "caller").length;
  const callerChecks = (r: { checked: number[] }) => r.checked.filter((i) => heard[i].side === "caller");
  const own = consoleChecks(c, pack, built, heard);
  const result = judge(c, pack, built, own.lines, opts.timed);
  const hasCheck = (l: CaseLine) => l.checked !== undefined || !!l.checkFailed;
  const slowest = (l: CaseLine): CaseLine => (hasCheck(l) ? { ...l, checkedAt: firstAtOf(l) + CHECK_TIMEOUT_MS / 1000 } : l);
  const earliest = (l: CaseLine): CaseLine => (hasCheck(l) ? { ...l, checkedAt: firstAtOf(l) + (l.checkEngineS ?? 0) } : l);
  /** The line's first text at `t`, its check (if any) keeping its duration. */
  const moved = (l: CaseLine, t: number): CaseLine => ({ ...l, firstAt: t, ...(l.checkedAt !== undefined ? { checkedAt: l.checkedAt + t - firstAtOf(l) } : {}) });
  // A first pass landing after the case's first caller check could start may share the GPU with a check
  // (two engine processes on one GPU), so it may come up to the assumed slowdown later.
  const firstCheck = Math.min(...heard.filter((l) => l.side === "caller" && hasCheck(l)).map(firstAtOf));
  const later = (l: CaseLine): CaseLine => (firstAtOf(l) > firstCheck ? moved(l, firstAtOf(l) + SHARED_GPU_S) : l);
  // One first pass slowed on its own, while the checks already running keep their times: the slowdown can
  // then change which lands first. That side's later first passes wait behind it, as in its queue (store.ts).
  const lateOne = (lines: CaseLine[], k: number): CaseLine[] => {
    const t = firstAtOf(lines[k]) + SHARED_GPU_S;
    return lines.map((l, i) => (i === k ? moved(l, t) : i > k && l.side === lines[k].side && firstAtOf(l) < t ? moved(l, t) : l));
  };
  const lineName = (k: number) => `${heard[k].side} line ${heard.slice(0, k + 1).filter((l) => l.side === heard[k].side).length}`;
  const lateLines = heard.flatMap((l, k) => (firstAtOf(l) > firstCheck ? [k] : []));
  const variants: [string, CaseLine[]][] = [
    [`with ${CHECK_TIMEOUT_MS / 1000} s checks`, heard.map(slowest)],
    ["with checks landing early (after the engine's own time, a timed-out check after its own wait, or at once when neither is recorded)", heard.map(earliest)],
    [`with every later first pass ${SHARED_GPU_S} s late (a GPU shared with a running check)`, heard.map(later)],
    ...lateLines.flatMap((k): [string, CaseLine[]][] => [
      [`with only ${lineName(k)}'s first pass ${SHARED_GPU_S} s late`, lateOne(heard, k)],
      [`with only ${lineName(k)}'s first pass ${SHARED_GPU_S} s late and checks landing early`, lateOne(heard.map(earliest), k)],
    ]),
  ];
  // Two runs with the same times (one later first pass in all) are one run.
  const runs = variants.filter(([, lines], i) => !variants.slice(0, i).some(([, other]) => JSON.stringify(other) === JSON.stringify(lines)));
  const changed = runs.flatMap(([label, lines]) => {
    const r = consoleChecks(c, pack, built, lines);
    return callerChecks(r).join() === callerChecks(own).join() ? [] : [`${label} the console would check ${callerChecks(r).length} of ${callers} caller line(s), L4 ${judge(c, pack, built, r.lines).l4}`];
  });
  const notes = [result.note, `console would check: ${callerChecks(own).length} of ${callers} caller line(s)`, opts.combined && opts.times === "estimated" ? COMBINED_NOTE : TIMES_NOTE[opts.times ?? "synthesized"]];
  if (changed.length) notes.push(`timing-dependent: ${changed.join("; ")}`);
  return { ...result, note: notes.filter(Boolean).join("; "), timingDependent: changed.length > 0 };
}
