/*
  Demo scenario: AtlasOne Communications (fictional), duplicate payment refund.
  All content lives here, not in components, so Interactive Demo Mode and
  Presentation Mode share one source of truth through the Zustand store.
*/

export const STEPS = [
  "idle",
  "incoming_call",
  "intent_detected",
  "verification_started",
  "email_verified",
  "customer_verified",
  "account_retrieved",
  "transactions_loaded",
  "duplicate_detected",
  "refund_recommended",
  "refund_prepared",
  "awaiting_human_approval",
  "refund_approved",
  "documentation_generated",
  "resolved",
] as const;

export type Step = (typeof STEPS)[number];

/** Alternate branches. "main" is the recorded take. */
export type Branch = "main" | "verification_failed" | "account_locked" | "unauthorized_transaction";

export const stepIndex = (s: Step) => STEPS.indexOf(s);
export const atLeast = (current: Step, target: Step) => stepIndex(current) >= stepIndex(target);

export const company = {
  name: "AtlasOne Communications",
  fictionalNote: "Fictional company, used for demonstration only",
  agent: { name: "Maya Hassan", id: "AG-1187", team: "Billing Support, Tier 1" },
  caseId: "CS-2026-091403",
};

export const customer = {
  name: "Daniel Carter",
  accountId: "AC-482901",
  emailMasked: "d.c•••••@example-mail.com",
  emailFull: "d.carter@example-mail.com",
  phoneMasked: "+1 (•••) •••-0192",
  plan: "Home Fiber 300",
  planPrice: 49,
  billingCycle: "Monthly, billed on the 14th",
  paymentMethod: "Visa ending 4471",
  cardLast4: "4471",
  customerSince: "March 2023",
  status: "Active, in good standing",
  openCases: 0,
  address: "Austin, TX",
};

export type Transaction = {
  id: string;
  date: string;
  time: string;
  description: string;
  amount: number;
  method: string;
  status: "settled" | "refunded" | "flagged";
  duplicateOf?: string;
};

export const transactions: Transaction[] = [
  { id: "TX98352", date: "2026-09-14", time: "09:14:07", description: "Home Fiber 300, monthly plan", amount: 49, method: "Visa 4471", status: "settled", duplicateOf: "TX98341" },
  { id: "TX98341", date: "2026-09-14", time: "09:12:31", description: "Home Fiber 300, monthly plan", amount: 49, method: "Visa 4471", status: "settled" },
  { id: "TX97710", date: "2026-08-14", time: "09:10:52", description: "Home Fiber 300, monthly plan", amount: 49, method: "Visa 4471", status: "settled" },
  { id: "TX97088", date: "2026-07-14", time: "09:11:18", description: "Home Fiber 300, monthly plan", amount: 49, method: "Visa 4471", status: "settled" },
  { id: "TX96455", date: "2026-06-14", time: "09:09:44", description: "Home Fiber 300, monthly plan", amount: 49, method: "Visa 4471", status: "settled" },
];

export const duplicate = {
  original: "TX98341",
  duplicateId: "TX98352",
  amount: 49,
  gapSeconds: 96,
  refundReference: "RF-2026-091403-01",
  settlementDays: "3 to 5 business days",
};

export type SopScenario = { id: string; title: string; conditions: string[]; action: string; authority: string };

export const sop = {
  id: "BIL-SOP-4.2",
  title: "Duplicate and Disputed Payment Handling",
  version: "Rev. 3, effective 2026-07-01",
  owner: "Billing Operations",
  verification: {
    title: "Two-factor identity verification (required before any account data is shown)",
    factors: ["Email address on file", "Last four digits of the payment method on file"],
    failure: "Two failed attempts lock the account view for this session. Escalate to the Identity team. Do not disclose which factor failed.",
  },
  authority: [
    { range: "$0 to $100", approver: "Agent (Tier 1)", note: "Self-approve, log reason code" },
    { range: "$100.01 to $500", approver: "Team Lead", note: "Same-day review" },
    { range: "Over $500", approver: "Billing Manager", note: "Written justification" },
  ],
  scenarios: [
    {
      id: "A",
      title: "Confirmed duplicate charge",
      conditions: [
        "Two charges of the same amount to the same payment method",
        "Within 24 hours of each other",
        "Same product or plan line item",
        "Customer recognises the original charge",
      ],
      action: "Refund the later charge in full to the original payment method. Keep the original charge. Inform the customer of the settlement window.",
      authority: "Per the refund authority matrix. Under $100, the agent approves.",
    },
    {
      id: "B",
      title: "Charge not recognised by customer",
      conditions: [
        "Customer does not recognise one or more charges",
        "Or the charge does not match plan, amount, or payment method on file",
      ],
      action: "Do not refund at agent level. Place a temporary hold on the payment method, open a Fraud and Risk case, and hand the customer to the Fraud queue.",
      authority: "Fraud and Risk team only. Agents cannot approve.",
    },
  ] satisfies SopScenario[],
  documentation: [
    "Case summary with customer, intent, and verification method",
    "Transaction IDs involved and the action taken",
    "Approval record: who approved, authority band, timestamp",
    "Customer communication sent",
  ],
};

export const intent = {
  label: "Billing: duplicate charge",
  category: "Billing and Payments",
  confidence: 96,
  evidence: [
    "\"charged twice\" and \"internet bill this month\" in the first customer turn",
    "Caller phone matched an active account with a payment on 2026-09-14",
    "Two same-amount charges present within 24 hours",
  ],
};

export type Speaker = "agent" | "customer" | "system";

export type TranscriptTurn = {
  step: Step;
  speaker: Speaker;
  time: string;
  text: string;
};

/** Turns appear once the store reaches their step. */
export const transcript: TranscriptTurn[] = [
  { step: "incoming_call", speaker: "system", time: "00:00", text: "Incoming call. Caller ID matched to account AC-482901." },
  { step: "incoming_call", speaker: "agent", time: "00:02", text: "Thank you for calling AtlasOne Communications, this is Maya. How can I help you today?" },
  { step: "intent_detected", speaker: "customer", time: "00:07", text: "Hi. I'm looking at my card statement and I was charged twice for my internet bill this month. Both on the 14th." },
  { step: "verification_started", speaker: "agent", time: "00:15", text: "I'm sorry about that, I can look into it right away. First I need to verify the account. Can you confirm the email address on file?" },
  { step: "email_verified", speaker: "customer", time: "00:22", text: "It's d.carter at example-mail dot com." },
  { step: "email_verified", speaker: "agent", time: "00:26", text: "Thank you. And the last four digits of the card used for payment?" },
  { step: "customer_verified", speaker: "customer", time: "00:30", text: "4471." },
  { step: "account_retrieved", speaker: "system", time: "00:31", text: "Identity verified. Account context unlocked." },
  { step: "transactions_loaded", speaker: "agent", time: "00:34", text: "You're verified, Daniel. I have your account open. Let me pull up the recent payments." },
  { step: "duplicate_detected", speaker: "system", time: "00:38", text: "Copilot flagged TX98352 as a duplicate of TX98341." },
  { step: "refund_recommended", speaker: "agent", time: "00:41", text: "I can see two charges of $49 about a minute and a half apart on September 14. The second one is a duplicate, you should only have been charged once." },
  { step: "refund_prepared", speaker: "agent", time: "00:52", text: "I can refund the duplicate to your Visa right now. It usually shows up within 3 to 5 business days." },
  { step: "awaiting_human_approval", speaker: "customer", time: "00:58", text: "That would be great, thank you." },
  { step: "refund_approved", speaker: "system", time: "01:04", text: "Refund of $49.00 approved by Maya Hassan (AG-1187). Reference RF-2026-091403-01." },
  { step: "documentation_generated", speaker: "agent", time: "01:06", text: "Done. The $49 refund for the duplicate charge is processed and you'll get an email confirmation in a few minutes." },
  { step: "resolved", speaker: "customer", time: "01:14", text: "Perfect. Thanks, Maya." },
  { step: "resolved", speaker: "agent", time: "01:16", text: "You're welcome. Is there anything else I can help with today?" },
];

/** Branch-specific turns, appended when a branch is active. */
export const branchTranscript: Record<Exclude<Branch, "main">, TranscriptTurn[]> = {
  verification_failed: [
    { step: "verification_started", speaker: "system", time: "00:32", text: "Verification attempt 1 failed. One attempt remaining. Do not disclose which factor failed." },
    { step: "verification_started", speaker: "agent", time: "00:34", text: "I wasn't able to match those details. Could you check the email address and card on file and try once more?" },
  ],
  account_locked: [
    { step: "verification_started", speaker: "system", time: "00:52", text: "Verification attempt 2 failed. Account view locked for this session. Escalate to Identity team." },
    { step: "verification_started", speaker: "agent", time: "00:54", text: "For your security I can't open the account on this call. I'll transfer you to our identity team who can verify you another way." },
  ],
  unauthorized_transaction: [
    { step: "duplicate_detected", speaker: "customer", time: "00:44", text: "Actually, wait. I only recognise one of those. I never made a second payment." },
    { step: "duplicate_detected", speaker: "system", time: "00:46", text: "Customer does not recognise TX98352. Scenario B applies. Refund path closed at agent level." },
    { step: "duplicate_detected", speaker: "agent", time: "00:49", text: "Understood. I'm placing a temporary hold on that card and opening a case with our fraud team, who will call you back today." },
  ],
};

/** The nine-step solution sequence used on the landing page and the workflow tracker. */
export const workflow: { key: string; label: string; step: Step; detail: string }[] = [
  { key: "listen", label: "Listen", step: "incoming_call", detail: "Joins the call and follows the conversation in real time." },
  { key: "understand", label: "Understand", step: "intent_detected", detail: "Classifies the intent and shows its confidence and evidence." },
  { key: "verify", label: "Verify", step: "customer_verified", detail: "Walks the agent through two-factor identity checks before anything unlocks." },
  { key: "retrieve", label: "Retrieve", step: "account_retrieved", detail: "Pulls account context from CRM and billing once identity is confirmed." },
  { key: "analyze", label: "Analyze", step: "duplicate_detected", detail: "Reads the transaction history and flags what matters." },
  { key: "recommend", label: "Recommend", step: "refund_recommended", detail: "Proposes the SOP-backed action and explains why." },
  { key: "prepare", label: "Prepare", step: "refund_prepared", detail: "Pre-fills the refund with the right IDs, amount, and reason code." },
  { key: "approve", label: "Approve", step: "refund_approved", detail: "Waits. A human approves, escalates, or cancels." },
  { key: "document", label: "Document", step: "documentation_generated", detail: "Writes the case summary and closes the loop." },
];

export const stepTitles: Record<Step, string> = {
  idle: "Ready",
  incoming_call: "Incoming call",
  intent_detected: "Intent detected",
  verification_started: "Verifying identity",
  email_verified: "Email confirmed",
  customer_verified: "Customer verified",
  account_retrieved: "Account retrieved",
  transactions_loaded: "Transactions loaded",
  duplicate_detected: "Duplicate detected",
  refund_recommended: "Refund recommended",
  refund_prepared: "Refund prepared",
  awaiting_human_approval: "Awaiting your approval",
  refund_approved: "Refund approved",
  documentation_generated: "Documentation generated",
  resolved: "Resolved",
};

export const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
