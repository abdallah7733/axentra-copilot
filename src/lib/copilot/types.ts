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
};

/** Things the agent does in the panel. Suggestions never act on their own. */
export type AgentAction =
  | { type: "confirm"; target: "issue" | "name" | "address" | "order" | "choice"; at: number }
  | { type: "approve"; at: number };

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
  authority: AuthorityBand[];
  refundTiming: string;
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
