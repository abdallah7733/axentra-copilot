"use client";

import { createContext, createElement, useContext, useState, type ReactNode } from "react";
import { createStore, useStore, type StoreApi } from "zustand";
import { STEPS, stepIndex, type Branch, type Step } from "@/lib/demo-data";

/*
  One store, two drivers. Interactive Demo Mode advances the step machine by
  clicks; Presentation Mode advances it from a scene timeline. Both read the
  same state, so the product UI is literally the same component tree.
*/

export type Factor = "idle" | "pending" | "ok" | "fail";

export type SceneKind = "title" | "context" | "workspace" | "outro";
export type Scene = { id: string; kind: SceneKind; durationMs: number; step?: Step; caption?: string };

export const scenes: Scene[] = [
  { id: "title", kind: "title", durationMs: 3200 },
  { id: "context", kind: "context", durationMs: 4800 },
  { id: "incoming", kind: "workspace", durationMs: 2600, step: "incoming_call", caption: "A call arrives. The copilot is already listening." },
  { id: "intent", kind: "workspace", durationMs: 3400, step: "intent_detected", caption: "Intent classified from the first customer sentence, with evidence." },
  { id: "verify", kind: "workspace", durationMs: 2600, step: "verification_started", caption: "Nothing unlocks until the customer is verified." },
  { id: "email", kind: "workspace", durationMs: 2200, step: "email_verified", caption: "Factor one confirmed." },
  { id: "verified", kind: "workspace", durationMs: 3200, step: "customer_verified", caption: "Factor two confirmed. Account context unlocks." },
  { id: "account", kind: "workspace", durationMs: 2600, step: "account_retrieved", caption: "CRM and billing context, pulled without leaving the call." },
  { id: "transactions", kind: "workspace", durationMs: 2800, step: "transactions_loaded", caption: "Recent transactions load into the workspace." },
  { id: "duplicate", kind: "workspace", durationMs: 3400, step: "duplicate_detected", caption: "Two identical charges, 96 seconds apart. Flagged." },
  { id: "recommend", kind: "workspace", durationMs: 3600, step: "refund_recommended", caption: "The recommendation cites the SOP scenario it is based on." },
  { id: "prepare", kind: "workspace", durationMs: 3000, step: "refund_prepared", caption: "Refund pre-filled. The copilot never submits on its own." },
  { id: "approval", kind: "workspace", durationMs: Infinity, step: "awaiting_human_approval", caption: "The human decides. Presenter clicks Approve to continue." },
  { id: "approved", kind: "workspace", durationMs: 2600, step: "refund_approved", caption: "Approved within the agent's authority band." },
  { id: "document", kind: "workspace", durationMs: 4200, step: "documentation_generated", caption: "Case summary written automatically." },
  { id: "resolved", kind: "workspace", durationMs: 2800, step: "resolved", caption: "Resolved. Under two minutes of talk time." },
  { id: "outro", kind: "outro", durationMs: 5000 },
];

export type DemoState = {
  step: Step;
  branch: Branch;
  loading: boolean;
  email: Factor;
  last4: Factor;
  attempts: number;
  approvalOpen: boolean;
  sopOpen: boolean;
  approvedAt: string | null;
  escalated: boolean;
  /** Interactive Demo auto-advance */
  autoPlay: boolean;
  /** Presentation timeline */
  sceneIndex: number;
  isPlaying: boolean;
  hasStarted: boolean;

  setStep: (step: Step) => void;
  next: () => void;
  prev: () => void;
  reset: () => void;
  failVerification: () => void;
  lockAccount: () => void;
  flagUnauthorized: () => void;
  resumeMain: () => void;
  openApproval: (open: boolean) => void;
  approve: () => void;
  escalate: () => void;
  setSop: (open: boolean) => void;
  setAutoPlay: (on: boolean) => void;

  play: () => void;
  pause: () => void;
  restart: () => void;
  setScene: (i: number) => void;
  nextScene: () => void;
  prevScene: () => void;
};

const LOADING_STEPS: Step[] = ["account_retrieved", "transactions_loaded", "documentation_generated"];
const LOADING_MS = 750;

function factorsFor(step: Step): Pick<DemoState, "email" | "last4"> {
  const i = stepIndex(step);
  return {
    email: i >= stepIndex("email_verified") ? "ok" : i >= stepIndex("verification_started") ? "pending" : "idle",
    last4: i >= stepIndex("customer_verified") ? "ok" : i >= stepIndex("email_verified") ? "pending" : "idle",
  };
}

const initial = {
  step: "idle" as Step,
  branch: "main" as Branch,
  loading: false,
  email: "idle" as Factor,
  last4: "idle" as Factor,
  attempts: 0,
  approvalOpen: false,
  sopOpen: false,
  approvedAt: null as string | null,
  escalated: false,
  autoPlay: false,
  sceneIndex: 0,
  isPlaying: false,
  hasStarted: false,
};

export function createDemoStore() {
  let loadingTimer: ReturnType<typeof setTimeout> | undefined;

  return createStore<DemoState>((set, get) => {
    const applyStep = (step: Step) => {
      clearTimeout(loadingTimer);
      const loading = LOADING_STEPS.includes(step);
      set({ step, ...factorsFor(step), loading, approvalOpen: false });
      if (loading) loadingTimer = setTimeout(() => set({ loading: false }), LOADING_MS);
    };

    return {
      ...initial,

      setStep: (step) => applyStep(step),

      next: () => {
        const { step, branch } = get();
        if (branch !== "main") return;
        if (step === "awaiting_human_approval") {
          set({ approvalOpen: true });
          return;
        }
        const i = stepIndex(step);
        if (i < STEPS.length - 1) applyStep(STEPS[i + 1]);
      },

      prev: () => {
        const { step } = get();
        const i = stepIndex(step);
        if (i > 0) {
          applyStep(STEPS[i - 1]);
          if (stepIndex(STEPS[i - 1]) < stepIndex("refund_approved")) set({ approvedAt: null, escalated: false });
        }
      },

      reset: () => {
        clearTimeout(loadingTimer);
        set({ ...initial });
      },

      failVerification: () => {
        const { step } = get();
        if (!["verification_started", "email_verified"].includes(step)) return;
        set({ branch: "verification_failed", attempts: 1, email: "fail", last4: "fail", step: "verification_started" });
      },

      lockAccount: () => {
        set({ branch: "account_locked", attempts: 2, email: "fail", last4: "fail", step: "verification_started" });
      },

      flagUnauthorized: () => {
        const { step } = get();
        if (stepIndex(step) < stepIndex("transactions_loaded")) return;
        set({ branch: "unauthorized_transaction", step: "duplicate_detected", approvalOpen: false });
      },

      resumeMain: () => {
        const { branch } = get();
        const back: Step = branch === "unauthorized_transaction" ? "transactions_loaded" : "verification_started";
        set({ branch: "main", attempts: 0, escalated: false });
        applyStep(back);
      },

      openApproval: (open) => set({ approvalOpen: open }),

      approve: () => {
        set({ approvedAt: new Date().toISOString(), escalated: false });
        applyStep("refund_approved");
      },

      escalate: () => set({ escalated: true, approvalOpen: false }),

      setSop: (open) => set({ sopOpen: open }),
      setAutoPlay: (on) => set({ autoPlay: on }),

      /* Presentation timeline. Scenes with a step drive the same machine. */
      play: () => {
        const { hasStarted, sceneIndex } = get();
        if (!hasStarted) {
          set({ hasStarted: true, isPlaying: true });
          get().setScene(0);
        } else {
          set({ isPlaying: true });
          const scene = scenes[sceneIndex];
          if (scene.step) applyStep(scene.step);
        }
      },
      pause: () => set({ isPlaying: false }),
      restart: () => {
        clearTimeout(loadingTimer);
        set({ ...initial, hasStarted: true, isPlaying: true });
      },
      setScene: (i) => {
        const clamped = Math.max(0, Math.min(scenes.length - 1, i));
        const scene = scenes[clamped];
        set({ sceneIndex: clamped, hasStarted: true, sopOpen: false });
        if (scene.step) {
          if (stepIndex(scene.step) < stepIndex("refund_approved")) set({ approvedAt: null, escalated: false });
          else if (!get().approvedAt) set({ approvedAt: new Date().toISOString() });
          applyStep(scene.step);
        } else {
          clearTimeout(loadingTimer);
          set({ step: scene.kind === "outro" ? "resolved" : "idle", ...factorsFor(scene.kind === "outro" ? "resolved" : "idle"), loading: false, approvalOpen: false });
        }
      },
      nextScene: () => {
        const { sceneIndex } = get();
        if (sceneIndex >= scenes.length - 1) {
          set({ isPlaying: false });
          return;
        }
        get().setScene(sceneIndex + 1);
      },
      prevScene: () => get().setScene(get().sceneIndex - 1),
    };
  });
}

export type DemoStore = StoreApi<DemoState>;

/* Context so the landing-page hero can run its own auto-cycling instance
   while /demo and /presentation share the default one. */
const DemoStoreContext = createContext<DemoStore | null>(null);
let defaultStore: DemoStore | null = null;
const getDefaultStore = () => (defaultStore ??= createDemoStore());

export function DemoStoreProvider({ children, store }: { children: ReactNode; store?: DemoStore }) {
  const [value] = useState(() => store ?? createDemoStore());
  return createElement(DemoStoreContext.Provider, { value }, children);
}

export function useDemoStore(): DemoStore {
  return useContext(DemoStoreContext) ?? getDefaultStore();
}

export function useDemo<T>(selector: (s: DemoState) => T): T {
  return useStore(useDemoStore(), selector);
}
