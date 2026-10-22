"use client";

import { create } from "zustand";
import { classifyMessages, parseIntentLabel, replyMessages, sameWording, wordingProblem } from "@/lib/copilot/assist";
import { ANSWER_GAP_MS, analyze, type CopilotView, type ModelHints } from "@/lib/copilot/copilot";
import type { AgentAction, TranscriptEvent } from "@/lib/copilot/types";
import { assistChat } from "./engine";
import { epochNow, liveEvents, useLive } from "./store";
import { sunlake } from "./sunlake-data";

/*
  The live copilot. It subscribes to the transcript event boundary and rebuilds
  its view from the call's final lines on every event. State is page memory only:
  nothing is stored or sent anywhere except the local engine on this Mac.

  When the engine runs the optional local model (AXENTRA_ASSIST=local), the model
  rewords the rules' suggested reply when the line is neutral (no amounts, outcomes
  or order facts), and reads caller lines the rules could not. If it is slow (over
  4 s from when the suggestion appeared) or unavailable, the panel keeps the rules'
  wording.
*/

/** The suggestion target from the plan: a suggestion within 4 s. */
export const ASSIST_TIMEOUT_MS = 4000;

/** `seq`: the appearance of the suggestion it rewords; shown only while that same suggestion is up (I-26). */
type Worded = { seq: number; draft: string; text: string; ms: number; model: string };
/** What became of each rewording request, for the call details and the review. */
export type AssistRecord = {
  draft: string;
  text?: string;
  /** From the moment the suggestion appeared. */
  ms: number;
  outcome: "shown" | "rejected" | "replaced" | "late" | "timeout" | "failed";
  reason?: string;
};
type AssistStatus = "off" | "loading" | "ready" | "working" | "fallback";

type CopilotState = {
  callId: string | null;
  lines: TranscriptEvent[];
  actions: AgentAction[];
  hints: ModelHints;
  view: CopilotView;
  /** Milliseconds the last rules pass took, shown for the speed target. */
  lastMs: number | null;
  /** Transcript line to highlight while its evidence is hovered in the panel. */
  highlightKey: string | null;
  assist: AssistStatus;
  /** The model's wording of the current suggested reply, if it passed the check. */
  worded: Worded | null;
  /** Counts each new suggested reply, so a rewording belongs to one appearance of its draft. */
  draftSeq: number;
  /** Milliseconds from a suggestion appearing to the model's answer, this call. */
  assistTimes: number[];
  /** Every rewording request this call, including rejected, late and failed ones. */
  assistLog: AssistRecord[];
  /** For the issue, `issue` is what the agent heard the problem is. */
  confirm: (target: "issue" | "name" | "address" | "order" | "choice", issue?: "damaged" | "other") => void;
  /** The agent types what the caller said on a line recognition got wrong. */
  correct: (key: string, text: string) => void;
  approve: () => void;
  /** Takes back the agent's latest Confirm press for the name, the address or the item. */
  undo: (target: "name" | "address" | "order") => void;
  setHighlight: (key: string | null) => void;
};

export const pack = sunlake;

const run = (lines: TranscriptEvent[], actions: AgentAction[], hints: ModelHints) => {
  const began = performance.now();
  const view = analyze(pack, lines, actions, epochNow(), hints);
  return { view, lastMs: performance.now() - began };
};

const NAMES = [...pack.customers.map((c) => c.name.split(" ")[0]), ...pack.orders.map((o) => o.shortName)];
/** Every person in the client pack: the model may never add one of these to a reply. */
const PEOPLE = [...pack.customers.map((c) => c.name), ...pack.orders.map((o) => o.customerName), pack.agent.name];

export const useCopilot = create<CopilotState>((set, get) => {
  // One model request at a time (llama-server runs a single slot); newer work replaces queued work.
  let busy = false;
  let queued: (() => Promise<void>) | null = null;
  // When the current suggested reply appeared, and the last appearance sent for rewording.
  let draftShownAt = 0;
  let askedSeq = -1;
  let classified = new Set<string>();
  let healthCheckedAt = 0;
  // Re-check once the caller has been quiet long enough for an identity answer to be complete.
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  // Lines already sent for the second model's check (or found uncheckable) this call: each at most once.
  let requested = new Set<string>();

  /**
   * Asks for the check on a line, once; the line is held back while it runs. Caller lines while an answer is
   * awaited; agent lines only when the rules name them (an approval or terms that may have been misheard).
   */
  const requestCheck = (line: TranscriptEvent, named = false): TranscriptEvent => {
    if (requested.has(line.key) || (line.side !== "caller" && !named) || line.firstHeard !== undefined || line.checkFailed) return line;
    requested.add(line.key);
    return useLive.getState().checkLine(line.key) === "started" ? { ...line, checking: true } : line;
  };

  const assistOn = () => useLive.getState().health?.assist === "local";

  async function assistReady(): Promise<boolean> {
    if (!assistOn()) return false;
    if (useLive.getState().health?.assistReady) return true;
    if (Date.now() - healthCheckedAt > 3000) {
      healthCheckedAt = Date.now();
      await useLive.getState().checkEngine();
    }
    const ready = !!useLive.getState().health?.assistReady;
    set({ assist: ready ? "ready" : "loading" });
    return ready;
  }

  function schedule(job: () => Promise<void>) {
    if (busy) {
      queued = job;
      return;
    }
    busy = true;
    set({ assist: "working" });
    job()
      .catch(() => set({ assist: "fallback" }))
      .finally(() => {
        busy = false;
        if (get().assist === "working") set({ assist: "ready" });
        const next = queued;
        queued = null;
        if (next) schedule(next);
      });
  }

  /** Sets a new view; a changed suggested reply is a new appearance, with its own clock and no old wording. */
  function setView(next: Partial<CopilotState> & { view: CopilotView }) {
    if (next.view.suggestedReply?.text !== get().view.suggestedReply?.text) {
      draftShownAt = performance.now();
      set({ ...next, draftSeq: get().draftSeq + 1, worded: null });
    } else set(next);
  }

  const record = (r: AssistRecord) => set({ assistLog: [...get().assistLog, r] });

  function askModel() {
    const { view, lines, callId } = get();
    const last = lines[lines.length - 1];
    // Read a caller line the rules could not classify.
    if (last && last.side === "caller" && !view.intent && !classified.has(last.key)) {
      classified.add(last.key);
      const line = last;
      schedule(async () => {
        const result = await assistChat(classifyMessages(line.text), 4, ASSIST_TIMEOUT_MS);
        const id = parseIntentLabel(result.text);
        if (id && get().callId === callId && !get().view.intent) {
          const hints = { ...get().hints, intent: { id, key: line.key } };
          setView({ hints, ...run(get().lines, get().actions, hints) });
        }
      });
    }
    // Reword the rules' suggested reply, only when it has no amounts, outcomes or order facts (I-21).
    const suggestion = view.suggestedReply;
    const seq = get().draftSeq;
    if (suggestion?.rewordable && seq !== askedSeq) {
      askedSeq = seq;
      const draft = suggestion.text;
      const since = draftShownAt;
      schedule(async () => {
        if (get().draftSeq !== seq) return;
        // The 4 s run from when the suggestion appeared, queue included (I-26).
        const left = ASSIST_TIMEOUT_MS - (performance.now() - since);
        if (left <= 0) return record({ draft, ms: performance.now() - since, outcome: "late", reason: "waited in the queue past 4 s" });
        let result: Awaited<ReturnType<typeof assistChat>>;
        try {
          result = await assistChat(replyMessages(pack, get().lines, draft), 96, Math.ceil(left));
        } catch (error) {
          if (get().callId === callId) {
            const timedOut = (error as { name?: string } | null)?.name === "TimeoutError";
            record({ draft, ms: performance.now() - since, outcome: timedOut ? "timeout" : "failed", reason: timedOut ? "no answer within 4 s" : String(error) });
          }
          throw error;
        }
        const ms = performance.now() - since;
        if (get().callId !== callId) return;
        const problem = wordingProblem(draft, result.text, NAMES, PEOPLE, true);
        set({ assistTimes: [...get().assistTimes, ms] });
        if (get().draftSeq !== seq) record({ draft, text: result.text, ms, outcome: "replaced", reason: "the suggestion changed while the model worked" });
        else if (ms > ASSIST_TIMEOUT_MS) record({ draft, text: result.text, ms, outcome: "late", reason: "answered after 4 s" });
        else if (problem) record({ draft, text: result.text, ms, outcome: "rejected", reason: problem });
        else {
          const text = result.text.trim().replace(/^["“]|["”]$/g, "").trim();
          record({ draft, text, ms, outcome: "shown", ...(sameWording(draft, text) ? { reason: "kept the draft's wording" } : {}) });
          set({ worded: { seq, draft, text, ms, model: result.model } });
        }
      });
    }
  }

  const update = (lines: TranscriptEvent[], actions: AgentAction[], hints: ModelHints) => {
    setView({ lines, actions, hints, ...run(lines, actions, hints) });
    // A read-back waits a fixed time for the caller's yes: look again when it runs out, even if nobody speaks.
    clearTimeout(expiryTimer);
    const until = get().view.nameEntry?.readBackUntil;
    if (until !== undefined) expiryTimer = setTimeout(() => setView(run(get().lines, get().actions, get().hints)), Math.max(0, until - epochNow()) + 50);
    void assistReady().then((ready) => ready && askModel());
  };
  const act = (action: AgentAction) => update(get().lines, [...get().actions, action], get().hints);

  const reset = (callId: string | null) => {
    clearTimeout(settleTimer);
    clearTimeout(expiryTimer);
    queued = null;
    classified = new Set();
    requested = new Set();
    set({ callId, highlightKey: null, worded: null, assistTimes: [], assistLog: [], assist: assistOn() ? "ready" : "off" });
    update([], [], {});
  };

  liveEvents.subscribe((event) => {
    if (event.type === "call-started") reset(event.callId);
    else if (event.type === "cleared") reset(null);
    else if (event.type === "line" && event.line.callId === get().callId) {
      let line = event.line;
      const known = get().lines.some((l) => l.key === line.key);
      // A key answer (the problem, name, address or choice) waits for the second speech model's check:
      // short answers heard on their own are where the fast model goes wrong.
      if (!known && get().view.awaiting) line = requestCheck(line);
      // A checked line replaces the one it re-checked.
      let lines = [...get().lines.filter((l) => l.key !== line.key), line];
      // The two sides are transcribed separately, so an answer can arrive before the agent's question.
      // Once the conversation in speech order shows a line is a key answer, it gets its check too.
      const late = run(lines, get().actions, get().hints).view.keyAnswers.filter((key) => !requested.has(key));
      if (late.length) lines = lines.map((l) => (late.includes(l.key) ? requestCheck(l, true) : l));
      update(lines, get().actions, get().hints);
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => setView(run(get().lines, get().actions, get().hints)), ANSWER_GAP_MS + 100);
    }
  });

  return {
    callId: null,
    lines: [],
    actions: [],
    hints: {},
    ...run([], [], {}),
    lastMs: null,
    highlightKey: null,
    assist: "off",
    worded: null,
    draftSeq: 0,
    assistTimes: [],
    assistLog: [],
    confirm: (target, issue) => act({ type: "confirm", target, at: epochNow(), ...(issue ? { issue } : {}) }),
    correct: (key, text) => act({ type: "correct", key, text, at: epochNow() }),
    approve: () => act({ type: "approve", at: epochNow() }),
    undo: (target) => act({ type: "undo", target, at: epochNow() }),
    setHighlight: (key) => set({ highlightKey: key }),
  };
});
