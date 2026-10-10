"use client";

import { create } from "zustand";
import { checkWording, classifyMessages, parseIntentLabel, replyMessages } from "@/lib/copilot/assist";
import { ANSWER_GAP_MS, analyze, type CopilotView, type ModelHints } from "@/lib/copilot/copilot";
import type { AgentAction, TranscriptEvent } from "@/lib/copilot/types";
import { assistChat } from "./engine";
import { liveEvents, useLive } from "./store";
import { sunlake } from "./sunlake-data";

/*
  The live copilot. It subscribes to the transcript event boundary and rebuilds
  its view from the call's final lines on every event. State is page memory only:
  nothing is stored or sent anywhere except the local engine on this Mac.

  When the engine runs the optional local model (AXENTRA_ASSIST=local), the model
  rewords the rules' suggested reply and reads caller lines the rules could not.
  If it is slow (over 4 s) or unavailable, the panel keeps the rules' wording.
*/

/** The suggestion target from the plan: a suggestion within 4 s of the caller's line. */
export const ASSIST_TIMEOUT_MS = 4000;

type Worded = { draft: string; text: string; ms: number; model: string };
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
  /** Milliseconds from a line appearing to the model's suggestion, this call. */
  assistTimes: number[];
  confirm: (target: "issue" | "name" | "address" | "order" | "choice") => void;
  /** The agent types what the caller said on a line recognition got wrong. */
  correct: (key: string, text: string) => void;
  approve: () => void;
  setHighlight: (key: string | null) => void;
};

export const pack = sunlake;

const run = (lines: TranscriptEvent[], actions: AgentAction[], hints: ModelHints) => {
  const began = performance.now();
  const view = analyze(pack, lines, actions, Date.now(), hints);
  return { view, lastMs: performance.now() - began };
};

const NAMES = [...pack.customers.map((c) => c.name.split(" ")[0]), ...pack.orders.map((o) => o.shortName)];

export const useCopilot = create<CopilotState>((set, get) => {
  // One model request at a time (llama-server runs a single slot); newer work replaces queued work.
  let busy = false;
  let queued: (() => Promise<void>) | null = null;
  let lineArrivedAt = 0;
  let lastDraft = "";
  let classified = new Set<string>();
  let healthCheckedAt = 0;
  // Re-check once the caller has been quiet long enough for an identity answer to be complete.
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

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
          set({ hints, ...run(get().lines, get().actions, hints) });
        }
      });
    }
    // Reword the rules' suggested reply.
    const draft = view.suggestedReply?.text;
    if (draft && draft !== lastDraft) {
      lastDraft = draft;
      const since = lineArrivedAt;
      schedule(async () => {
        if (get().view.suggestedReply?.text !== draft) return;
        const result = await assistChat(replyMessages(pack, get().lines, draft), 96, ASSIST_TIMEOUT_MS);
        const text = checkWording(draft, result.text, NAMES);
        const ms = performance.now() - since;
        if (get().callId !== callId) return;
        set({ assistTimes: [...get().assistTimes, ms] });
        if (text && get().view.suggestedReply?.text === draft) set({ worded: { draft, text, ms, model: result.model } });
      });
    }
  }

  const update = (lines: TranscriptEvent[], actions: AgentAction[], hints: ModelHints) => {
    set({ lines, actions, hints, ...run(lines, actions, hints) });
    void assistReady().then((ready) => ready && askModel());
  };
  const act = (action: AgentAction) => update(get().lines, [...get().actions, action], get().hints);

  const reset = (callId: string | null) => {
    clearTimeout(settleTimer);
    queued = null;
    lastDraft = "";
    classified = new Set();
    set({ callId, highlightKey: null, worded: null, assistTimes: [], assist: assistOn() ? "ready" : "off" });
    update([], [], {});
  };

  liveEvents.subscribe((event) => {
    if (event.type === "call-started") reset(event.callId);
    else if (event.type === "cleared") reset(null);
    else if (event.type === "line" && event.line.callId === get().callId) {
      let line = event.line;
      const known = get().lines.some((l) => l.key === line.key);
      // A key answer (name, address or choice) waits for the second speech model's check:
      // short answers heard on their own are where the fast model goes wrong.
      if (!known && line.side === "caller" && get().view.awaiting && useLive.getState().checkLine(line.key)) line = { ...line, checking: true };
      lineArrivedAt = performance.now();
      // A checked line replaces the one it re-checked.
      update([...get().lines.filter((l) => l.key !== line.key), line], get().actions, get().hints);
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => set(run(get().lines, get().actions, get().hints)), ANSWER_GAP_MS + 100);
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
    assistTimes: [],
    confirm: (target) => act({ type: "confirm", target, at: Date.now() }),
    correct: (key, text) => act({ type: "correct", key, text, at: Date.now() }),
    approve: () => act({ type: "approve", at: Date.now() }),
    setHighlight: (key) => set({ highlightKey: key }),
  };
});
