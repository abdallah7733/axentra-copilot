/*
  Axentra copilot: shared types. Plain TypeScript with no React or browser APIs,
  so the same core can later sit behind Zendesk, Freshdesk or any other source of
  transcript events. A client is data (a "client pack"); the copilot is the same
  for every client.
*/

import type { Sop } from "@/lib/demo-data";

export type Side = "caller" | "agent";

/** One final transcript line. The copilot consumes these; it never reads the page. */
export type TranscriptEvent = {
  /** The call this line belongs to (the Twilio CallSid on a live call). */
  callId: string;
  /** Arrival order within the call, from 1. */
  seq: number;
  key: string;
  side: Side;
  text: string;
  /** Epoch milliseconds when the speech began and ended. */
  startedAt: number;
  endedAt: number;
  final: true;
  /** Mean word probability from recognition, or null when unknown. */
  confidence: number | null;
  /** A key answer the second speech model is re-checking: the copilot waits for it. */
  checking?: boolean;
  /** What the fast model heard, when the second model's check replaced it. */
  firstHeard?: string;
  /** The check failed or timed out: the fast model's text stands, as a doubtful line. */
  checkFailed?: boolean;
  /** The second model's check finished and its text stands, changed or not. Unset while checking, after a failed check, or when no check ran. */
  checked?: boolean;
  /** The agent typed what the caller said; this is what speech recognition heard instead. */
  typedFrom?: string;
  /** Epoch milliseconds when the agent typed it. */
  typedAt?: number;
  /**
   * An agent line that may be the name read-back misheard, heard again by the second model without being held back
   * (23 Oct call: "So it's Samuel Wright." for "So it's Sam Miller, right?"). `text` stays the fast model's, and every
   * other rule uses it; only the read-back rule reads this. `text: null`: the check failed. `at`: when it finished.
   */
  reheard?: { text: string | null; confidence: number | null; at: number };
  /** That check is still running; the line counts as heard meanwhile. */
  probing?: boolean;
  /** Epoch milliseconds when that check started: before then, the line was plainly heard. */
  probedAt?: number;
  /**
   * Epoch milliseconds when this text reached the copilot: when the line arrived, or when the
   * second model's check finished. Defaults to `endedAt`. Speech time places a line in the
   * conversation; this is when it could first be used for a decision.
   */
  availableAt?: number;
};

/** Things the agent does in the panel. Suggestions never act on their own. */
export type AgentAction =
  | {
      type: "confirm";
      target: "issue" | "name" | "address" | "order" | "choice";
      at: number;
      /** For the issue: what the agent heard the problem is. Without it, the copilot's reading is confirmed as it stands. */
      issue?: "damaged" | "other";
    }
  /** The agent types what the caller actually said, in place of what recognition heard. The latest one per line counts. */
  | { type: "correct"; key: string; text: string; at: number }
  | { type: "approve"; at: number }
  /**
   * The agent takes back their latest Confirm press for the name, the address or the item (an
   * accidental press, call 9). What depended on it relocks, and an approval given while it stood
   * doesn't come back when it is confirmed again.
   */
  | { type: "undo"; target: "name" | "address" | "order"; at: number };

export type Customer = {
  id: string;
  name: string;
  emailMasked: string;
  emailFull: string;
  phoneMasked: string;
  address: { street: string; city: string; state: string };
  customerSince: string;
  status: string;
  damageClaimsLast90Days: number;
};

export type Order = {
  id: string;
  customerId: string;
  /** Kept only so tests can prove a stranger's order is never shown. */
  customerName: string;
  item: string;
  /** The product name without size and colour: "Sunlake Tab 11". */
  shortName: string;
  /** How the agent would say it: "tablet", "earbuds". */
  noun: string;
  price: number;
  /** Relative, so "it came yesterday" stays true whenever the demo runs. */
  placedDaysAgo: number;
  deliveredDaysAgo: number | null;
  status: "Delivered" | "In transit";
  inStock: boolean;
  stockUnits?: number;
  payment?: string;
  shipping?: string;
};

export type AuthorityBand = {
  /** Inclusive upper limit in dollars; null for no limit. */
  upTo: number | null;
  approver: string;
  agentCanApprove: boolean;
  /** Row in the SOP's authority table. */
  row: number;
};

/** Numbers the rules read. They restate the SOP so eligibility is computed, not guessed. */
export type Policy = {
  claimWindowDays: number;
  /** Orders at or above this need the photo before any resolution. */
  photoRequiredFrom: number;
  photoDays: number;
  repeatClaimWindowDays: number;
  maxVerificationAttempts: number;
  /**
   * The agent saying the caller's full name back, word for word, and the caller's clear, checked yes verify the name,
   * labelled "name read back by agent, confirmed by caller", never as recognition. Off unless the client's verification
   * rules allow it (stage call review, 21 Oct: the caller's name arrives as phone audio, the agent's words don't).
   */
  nameReadBack?: boolean;
  authority: AuthorityBand[];
  refundTiming: string;
  /** A verb phrase that follows "it": "ships the same day by expedited shipping". Say when it ships, never when it arrives. */
  replacementShipping: string;
  returnDays: number;
  escalationCallbackHours: number;
};

export type ClientPack = {
  company: { name: string; fictionalNote: string; description: string; spokenName: string };
  agent: { name: string; id: string; team: string };
  caseId: string;
  sop: Sop;
  policy: Policy;
  references: { replacement: string; refund: string };
  customers: Customer[];
  orders: Order[];
  /** Every live call is treated as this customer ("caller ID match simulated"). Identity is still checked by voice. */
  callerCustomerId: string;
};
