/*
  Live-call client: Sunlake Electronics (fictional), damaged delivery.
  Taken word for word from MILESTONE3_SUNLAKE_CONTENT.md, approved by Abdallah
  on 27 Sep 2026. Change the content document first, then this file.
  Everything here is invented: the company, customers, orders, products and SOP.
*/

import type { Sop } from "@/lib/demo-data";
import type { ClientPack, Customer, Order } from "@/lib/copilot/types";

export const sunlakeSop = {
  id: "CS-SOP-3.1",
  title: "Damaged on Arrival: Replacement, Refund and Escalation",
  version: "Rev. 2, effective 2026-08-01",
  owner: "Customer Care Operations",
  verification: {
    title: "Identity check (required before any order details are discussed)",
    factors: ["Full name on the order", "Email address on the order, or the delivery street and city"],
    failure:
      "If either factor doesn't match after two attempts, don't discuss the order. Offer a call back to the phone number on the order, and log the attempt. Don't say which detail didn't match.",
  },
  rules: {
    title: "Claim rules",
    items: [
      "Damage must be reported within 30 days of delivery.",
      "Photo: orders under $500 can be resolved before a photo arrives; the customer is asked to upload one within 7 days using the link in the confirmation email. Orders of $500 or more need the photo before any resolution.",
      "The customer never pays for shipping on a damaged item, in either direction.",
    ],
  },
  authorityTitle: "Resolution authority",
  authority: [
    { range: "$0 to $500", approver: "Agent (Tier 1)", note: "Self-approve; reason code DOA-01" },
    { range: "$500.01 to $1,500", approver: "Team Lead", note: "Same-day review; photo required first" },
    { range: "Over $1,500", approver: "Customer Care Manager", note: "Written justification" },
  ],
  scenarios: [
    {
      id: "A",
      title: "Replacement (default)",
      conditions: [
        "Damage reported within 30 days of delivery",
        "The same item is in stock",
        "Order value is within the approver's authority",
        "The customer wants a replacement, or has no preference",
      ],
      action:
        "Create a replacement order at no charge. It ships within 1 business day by expedited shipping. Email a prepaid return label for the damaged item; the customer has 30 days to send it back.",
      authority: "Per the resolution authority table. Under $500, the agent approves.",
    },
    {
      id: "B",
      title: "Refund",
      conditions: ["Damage reported within 30 days of delivery", "The item is out of stock, or the customer prefers a refund"],
      action:
        "Refund the full order amount to the original payment method, including shipping. Email a prepaid return label. The refund is issued when the carrier scans the return and takes 3 to 5 business days to appear.",
      authority: "Per the resolution authority table.",
    },
    {
      id: "C",
      title: "Escalate to Tier 2 (overrides A and B)",
      conditions: [
        "More than 30 days since delivery",
        "A second damage claim on the account within 90 days",
        "Order value above the agent's authority",
        "The customer mentions a chargeback, a lawyer or fraud",
        "Safety: the customer reports heat, smoke, swelling, a burning smell or an injury",
      ],
      action:
        "Don't promise a replacement or refund. Open a Tier 2 case and transfer the call, or book a call back within 4 business hours. For a safety report, tell the customer to stop using and unplug the device first.",
      authority: "Team Lead or Customer Care Manager. Agents can't approve.",
    },
  ],
  documentation: [
    "Case summary: customer, order, damage described, verification method",
    "Resolution: replacement order number or refund reference",
    "Approval record: who approved, authority band, time",
    "Customer communication sent: confirmation email and return label",
  ],
} satisfies Sop;

export const samMiller: Customer = {
  id: "CU-310582",
  name: "Sam Miller",
  emailMasked: "s.mi•••@example-mail.com",
  emailFull: "s.miller@example-mail.com",
  phoneMasked: "+1 (•••) •••-0417",
  address: { street: "Hill Road", city: "Dallas", state: "TX" },
  customerSince: "January 2025",
  status: "Active, no open cases",
  damageClaimsLast90Days: 0,
};

const samOrder = { customerId: samMiller.id, customerName: samMiller.name, payment: "Visa ending 2208", shipping: "Standard ground" } as const;

export const sunlakeOrders: Order[] = [
  {
    ...samOrder,
    id: "427",
    item: "Sunlake Tab 11 tablet, 128 GB, grey",
    shortName: "Sunlake Tab 11",
    noun: "tablet",
    price: 329,
    placedDaysAgo: 4,
    deliveredDaysAgo: 1,
    status: "Delivered",
    inStock: true,
    stockUnits: 18,
  },
  {
    ...samOrder,
    id: "398",
    item: "Sunlake Buds wireless earbuds",
    shortName: "Sunlake Buds",
    noun: "earbuds",
    price: 59,
    placedDaysAgo: 65,
    deliveredDaysAgo: 62,
    status: "Delivered",
    inStock: true,
  },
  // Decoys: other customers' orders. They prove the order matcher only searches the
  // verified customer's orders. They never appear on screen.
  { id: "527", customerId: "CU-decoy-1", customerName: "Laura King", item: "15-inch laptop", shortName: "15-inch laptop", noun: "laptop", price: 899, placedDaysAgo: 6, deliveredDaysAgo: 2, status: "Delivered", inStock: true },
  { id: "247", customerId: "CU-decoy-2", customerName: "James Reed", item: "TV wall mount", shortName: "TV wall mount", noun: "wall mount", price: 45, placedDaysAgo: 9, deliveredDaysAgo: 5, status: "Delivered", inStock: true },
  { id: "472", customerId: "CU-decoy-3", customerName: "Nora Hill", item: "Phone case", shortName: "Phone case", noun: "phone case", price: 19, placedDaysAgo: 12, deliveredDaysAgo: 8, status: "Delivered", inStock: true },
];

export const sunlake: ClientPack = {
  company: {
    name: "Sunlake Electronics",
    spokenName: "Sunlake",
    fictionalNote: "Fictional company, used for demonstration only",
    description:
      "US online electronics store: tablets, laptops, audio and accessories, plus its own \"Sunlake\" house-brand products. Ships nationwide. Axentra runs its Tier 1 phone support.",
  },
  agent: { name: "Abdallah", id: "AG-2001", team: "Sunlake Electronics support, Tier 1 · Axentra" },
  caseId: "SL-2026-092701",
  sop: sunlakeSop,
  policy: {
    claimWindowDays: 30,
    photoRequiredFrom: 500,
    photoDays: 7,
    repeatClaimWindowDays: 90,
    maxVerificationAttempts: 2,
    authority: [
      { upTo: 500, approver: "Agent (Tier 1)", agentCanApprove: true, row: 0 },
      { upTo: 1500, approver: "Team Lead", agentCanApprove: false, row: 1 },
      { upTo: null, approver: "Customer Care Manager", agentCanApprove: false, row: 2 },
    ],
    refundTiming: "3 to 5 business days",
    replacementShipping: "expedited shipping, within 1 business day",
    returnDays: 30,
    escalationCallbackHours: 4,
  },
  references: { replacement: "RP-2026-092701-01", refund: "RF-2026-092701-01" },
  customers: [samMiller],
  orders: sunlakeOrders,
  callerCustomerId: samMiller.id,
};

/** Live call script v2 (content doc §5). C = Caller on a mobile phone, A = Agent on the MacBook. */
export const scriptV2: { n: number; side: "caller" | "agent"; text: string }[] = [
  { n: 1, side: "agent", text: "Thank you for calling Sunlake. How can I help you today?" },
  { n: 2, side: "caller", text: "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked." },
  { n: 3, side: "agent", text: "I'm sorry to hear that. I can send you a new one today." },
  { n: 4, side: "agent", text: "First, can I have your full name, please?" },
  { n: 5, side: "caller", text: "Sam Miller." },
  { n: 6, side: "agent", text: "Thank you. And the street and city for the delivery?" },
  { n: 7, side: "caller", text: "Hill Road, in Dallas." },
  { n: 8, side: "agent", text: "Thank you, Sam. I can see the tablet on order 427. Is the damage only on the screen?" },
  { n: 9, side: "caller", text: "Yes, only the screen. Can I get a new one, or my money back?" },
  { n: 10, side: "agent", text: "You can have either. A new tablet ships today at no cost, or a full refund in 3 to 5 business days. Which do you prefer?" },
  { n: 11, side: "caller", text: "A new one, please." },
  { n: 12, side: "agent", text: "Done. The new tablet ships today. You'll get an email with a free return label for the damaged one." },
  { n: 13, side: "caller", text: "Great, thank you." },
  { n: 14, side: "agent", text: "You're welcome. Is there anything else I can help with?" },
  { n: 15, side: "caller", text: "No, that's all. Bye." },
];
