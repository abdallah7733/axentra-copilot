"use client";

import { create } from "zustand";
import { analyze, type CopilotView } from "@/lib/copilot/copilot";
import type { AgentAction, TranscriptEvent } from "@/lib/copilot/types";
import { liveEvents } from "./store";
import { sunlake } from "./sunlake-data";

/*
  The live copilot. It subscribes to the transcript event boundary and rebuilds
  its view from the call's final lines on every event. State is page memory only:
  nothing is stored or sent anywhere.
*/

type CopilotState = {
  callId: string | null;
  lines: TranscriptEvent[];
  actions: AgentAction[];
  view: CopilotView;
  /** Milliseconds the last rules pass took, shown for the speed target. */
  lastMs: number | null;
  /** Transcript line to highlight while its evidence is hovered in the panel. */
  highlightKey: string | null;
  confirm: (target: "issue" | "name" | "address" | "order" | "choice") => void;
  approve: () => void;
  setHighlight: (key: string | null) => void;
};

export const pack = sunlake;

const run = (lines: TranscriptEvent[], actions: AgentAction[]) => {
  const began = performance.now();
  const view = analyze(pack, lines, actions);
  return { view, lastMs: performance.now() - began };
};

export const useCopilot = create<CopilotState>((set, get) => {
  const update = (lines: TranscriptEvent[], actions: AgentAction[]) => set({ lines, actions, ...run(lines, actions) });
  const act = (action: AgentAction) => update(get().lines, [...get().actions, action]);

  liveEvents.subscribe((event) => {
    if (event.type === "call-started") {
      set({ callId: event.callId, highlightKey: null });
      update([], []);
    } else if (event.type === "line" && event.line.callId === get().callId) {
      update([...get().lines, event.line], get().actions);
    } else if (event.type === "cleared") {
      set({ callId: null, highlightKey: null });
      update([], []);
    }
  });

  return {
    callId: null,
    lines: [],
    actions: [],
    ...run([], []),
    lastMs: null,
    highlightKey: null,
    confirm: (target) => act({ type: "confirm", target, at: Date.now() }),
    approve: () => act({ type: "approve", at: Date.now() }),
    setHighlight: (key) => set({ highlightKey: key }),
  };
});
