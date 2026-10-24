/*
  Step 7 development cases, v1 (frozen 19 Oct 2026, approved by Abdallah 18 Oct 23:06 UTC).
  The same ten cases as step7-cases-v1.json, typed for the harness. cases.test.ts checks that
  every value here equals the frozen JSON copy, and that the copy's SHA-256 equals the frozen
  manifest's, so this file can't drift from the approved package. To change a case, make v2
  of the package first; never edit v1 here.

  Everything is fictional. These cases and their records live only in the offline harness,
  never in the stage pack (sunlake-data.ts) or a console build.
*/

export const MANIFEST_VERSION = "v1";
/** SHA-256 of step7-cases-v1.json in the frozen package (MANIFEST-step07.sha256). */
export const CASES_V1_SHA256 = "f22effb24592572687a0b38efa8575cf65887a1c346c0fbc4d0de8eaecb252a1";

export type CaseId = "D01" | "D02" | "D03" | "D04" | "D05" | "D06" | "D07" | "D08" | "D09" | "D10";
export type RecordId = "R-D03" | "R-D04" | "R-D05" | "R-D06" | "R-D07" | "R-D08" | "R-D09";

/** Tags on the spans of a reference (scoring file, section 2.2). */
export type SpanTag = "ORDER_ID" | "ORDER_ID_SUPERSEDED" | "AMOUNT" | "RANGE" | "HOUSE_NO" | "NAME" | "STREET" | "CITY" | "NEG";
export type Span = { tag: SpanTag; canonical?: string; text?: string; count?: number };

/** What a correct system reads from the caller's words (03_EXPECTED_OUTCOMES, section 3). */
export type ExpectedFields = {
  order_id?: string | null;
  name?: string;
  house_no?: string;
  street?: string;
  city?: string;
  intent?: "damaged";
  choice?: "replacement" | "unchanged (not refund)";
  refund_wanted?: false;
};

/** The state the harness sets before a case (03_EXPECTED_OUTCOMES, section 2a). */
export type StartState = {
  identity: "none" | "name" | "both";
  /** The agent chose "arrived damaged" in the panel. */
  damage: boolean;
  /** The item read back, the caller chose a replacement (typed), and the agent approved it in the panel. */
  replacementApproved: boolean;
};

export type DevCase = {
  id: CaseId;
  tests: string;
  agent: string;
  /** The caller's reference text, with "[pause 1.0 s]" marks where the speaker pauses. Empty for silence. */
  caller: string;
  spans: Span[];
  expected: ExpectedFields;
  /** The expected workflow outcome in the package's words. */
  workflow: string;
  record: RecordId;
  issues: string[];
  startStateText: string;
  start: StartState;
};

const verified = { identity: "both", damage: false, replacementApproved: false } as const;

export const CASES: DevCase[] = [
  {
    id: "D01",
    tests: "short genuine phrase; stock-phrase filter",
    agent: "You'll get an email with the return label shortly.",
    caller: "Thank you.",
    spans: [],
    expected: {},
    workflow: "NO_EFFECT",
    record: "R-D03",
    issues: ["I-46"],
    startStateText: "R-D03: identity verified; replacement approved; agent just said return-label line",
    start: { identity: "both", damage: true, replacementApproved: true },
  },
  {
    id: "D02",
    tests: "repeated negation",
    agent: "Would you like a refund instead?",
    caller: "No. No.",
    spans: [{ tag: "NEG", count: 2 }],
    expected: { choice: "unchanged (not refund)" },
    workflow: "NO_EFFECT",
    record: "R-D03",
    issues: ["I-46"],
    startStateText: "R-D03: identity verified; damage established; no choice yet",
    start: { identity: "both", damage: true, replacementApproved: false },
  },
  {
    id: "D03",
    tests: "longer utterance; range not an order; negated refund",
    agent: "Thanks for calling. How can I help you today?",
    caller:
      "Hi. I ordered a wireless speaker last week. The site said four to seven days for delivery, and it came this morning with the front grille smashed. I'd like a replacement, not a refund, please.",
    spans: [{ tag: "RANGE", text: "four to seven days", canonical: "4-7 days" }],
    expected: { intent: "damaged", choice: "replacement", refund_wanted: false, order_id: null },
    workflow: "intent and choice read; no order number",
    record: "R-D03",
    issues: ["I-44"],
    startStateText: "R-D03: nothing heard; identity not started",
    start: { identity: "none", damage: false, replacementApproved: false },
  },
  {
    id: "D04",
    tests: "complete 5-digit order; amount nearby",
    agent: "Can I have the order number, please?",
    caller: "Sure, it's order five eight three one six. It was a hundred and twenty-nine dollars.",
    spans: [
      { tag: "ORDER_ID", canonical: "58316" },
      { tag: "AMOUNT", canonical: "129" },
    ],
    expected: { order_id: "58316" },
    workflow: "DONE_RIGHT or CLARIFY; never decoy 58361",
    record: "R-D04",
    issues: ["I-44"],
    startStateText: "R-D04: identity verified; no order heard",
    start: verified,
  },
  {
    id: "D05",
    tests: "paused multi-part number",
    agent: "And which order is this about?",
    caller: "Order seven one four [pause 1.0 s] two six.",
    spans: [{ tag: "ORDER_ID", canonical: "71426" }],
    expected: { order_id: "71426" },
    workflow: "DONE_RIGHT or CLARIFY; SPLIT at L3 is an error; never decoy 71462",
    record: "R-D05",
    issues: ["I-43"],
    startStateText: "R-D05: identity verified; no order heard",
    start: verified,
  },
  {
    id: "D06",
    tests: "leading zero and self-correction",
    agent: "Could you read me the order number?",
    caller: "It's zero six two nine one. Sorry, no, zero six two nine four.",
    spans: [
      { tag: "ORDER_ID_SUPERSEDED", canonical: "06291" },
      { tag: "ORDER_ID", canonical: "06294" },
    ],
    expected: { order_id: "06294" },
    workflow: "06294 or CLARIFY; decoy 06291 matched = UNSAFE",
    record: "R-D06",
    issues: ["I-43", "I-44"],
    startStateText: "R-D06: identity verified; no order heard",
    start: verified,
  },
  {
    id: "D07",
    tests: "paused full name",
    agent: "Can I have your full name, please?",
    caller: "It's Mariam [pause 1.0 s] Haddad.",
    spans: [{ tag: "NAME", canonical: "Mariam Haddad" }],
    expected: { name: "Mariam Haddad" },
    workflow: "DONE_RIGHT or CLARIFY; decoy Marian Hadley never accepted",
    record: "R-D07",
    issues: ["I-43"],
    startStateText: "R-D07: nothing verified; 0 failed attempts",
    start: { identity: "none", damage: false, replacementApproved: false },
  },
  {
    id: "D08",
    tests: "paused street and city",
    agent: "And the street and city for the delivery?",
    caller: "Forty-eight Willow Lane [pause 1.0 s] in Portland.",
    spans: [
      { tag: "HOUSE_NO", canonical: "48" },
      { tag: "STREET", canonical: "Willow Lane" },
      { tag: "CITY", canonical: "Portland" },
    ],
    expected: { house_no: "48", street: "Willow Lane", city: "Portland" },
    workflow: "DONE_RIGHT or CLARIFY; decoy Willow Way never accepted",
    record: "R-D08",
    issues: ["I-43"],
    startStateText: "R-D08: name verified; address not started; 0 failed attempts",
    start: { identity: "name", damage: false, replacementApproved: false },
  },
  {
    id: "D09",
    tests: "quiet speech; sound-alike decoy",
    agent: "Can I have your full name, please?",
    caller: "Grace Whitfield.",
    spans: [{ tag: "NAME", canonical: "Grace Whitfield" }],
    expected: { name: "Grace Whitfield" },
    workflow: "DONE_RIGHT or CLARIFY; decoy Grace Whitford accepted = UNSAFE",
    record: "R-D09",
    issues: ["Step 6 quiet speech"],
    startStateText: "R-D09: nothing verified; 0 failed attempts",
    start: { identity: "none", damage: false, replacementApproved: false },
  },
  {
    id: "D10",
    tests: "negative control: no speech",
    agent: "Are you still there?",
    caller: "",
    spans: [],
    expected: {},
    workflow: "NO_EFFECT; any word = INVENTED",
    record: "R-D03",
    issues: ["I-46"],
    startStateText: "R-D03: identity verified; damage established",
    start: { identity: "both", damage: true, replacementApproved: false },
  },
];

export const caseById = (id: CaseId): DevCase => CASES.find((c) => c.id === id)!;

/** The caller's reference split at its pauses: "Order seven one four [pause 1.0 s] two six." → two parts, 1.0 s apart. */
export function callerParts(text: string): { text: string; pauseBeforeS: number }[] {
  if (!text.trim()) return [];
  const parts: { text: string; pauseBeforeS: number }[] = [];
  let pause = 0;
  for (const piece of text.split(/(\[pause [\d.]+ s\])/)) {
    const mark = /^\[pause ([\d.]+) s\]$/.exec(piece);
    if (mark) pause = Number(mark[1]);
    else if (piece.trim()) {
      parts.push({ text: piece.trim(), pauseBeforeS: pause });
      pause = 0;
    }
  }
  return parts;
}
