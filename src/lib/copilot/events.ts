import type { TranscriptEvent } from "./types";

/*
  The transcript event boundary. A source (the live console today; Zendesk,
  Freshdesk or a replay later) emits; the copilot subscribes. The copilot never
  reads the rendered transcript.
*/

export type LiveEvent =
  | { type: "call-started"; callId: string; at: number }
  | { type: "line"; line: TranscriptEvent }
  | { type: "call-ended"; callId: string; at: number }
  | { type: "cleared" };

export type Listener = (event: LiveEvent) => void;

export function createEventBus() {
  const listeners = new Set<Listener>();
  return {
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit(event: LiveEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

export type EventBus = ReturnType<typeof createEventBus>;
