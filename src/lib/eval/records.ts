/*
  The evaluation record set (03_EXPECTED_OUTCOMES, section 2): one fictional customer per case,
  plus decoys, each wrapped in its own client pack. A pack keeps Sunlake's SOP, policy and
  references exactly as the stage pack has them, so the copilot rules are measured unchanged;
  only the customer, orders and caller differ.

  These records never enter the stage pack. This module imports from sunlake-data.ts (read only);
  nothing in the app imports this module (isolation.test.ts checks both directions).

  Names, order numbers and the record street and city come from the frozen v1 package. Emails,
  states, items, prices and the streets for R-D03 to R-D06 are harness additions (v1 doesn't give
  them); they are listed in README.md. Record streets carry no house number, like "Hill Road".
*/

import type { ClientPack, Customer, Order } from "@/lib/copilot/types";
import { sunlake } from "@/lib/live/sunlake-data";
import type { RecordId } from "./cases";

type Spec = {
  id: RecordId;
  name: string;
  street: string;
  city: string;
  state: string;
  email: string;
  orders: { id: string; item: string; shortName: string; noun: string; price: number; deliveredDaysAgo: number }[];
  decoyOrders?: string[];
  decoyCustomers?: { name: string; street: string; city: string; state: string }[];
};

const SPECS: Spec[] = [
  {
    id: "R-D03",
    name: "Ines Duarte",
    street: "Bay Street",
    city: "Seattle",
    state: "WA",
    email: "i.duarte@example-mail.com",
    orders: [{ id: "30418", item: "Sunlake Wave wireless speaker", shortName: "Sunlake Wave", noun: "speaker", price: 84, deliveredDaysAgo: 0 }],
  },
  {
    id: "R-D04",
    name: "Leila Mansour",
    street: "Oak Avenue",
    city: "Phoenix",
    state: "AZ",
    email: "l.mansour@example-mail.com",
    orders: [{ id: "58316", item: "Sunlake Pad keyboard case", shortName: "Sunlake Pad case", noun: "keyboard case", price: 129, deliveredDaysAgo: 1 }],
    decoyOrders: ["58361"],
  },
  {
    id: "R-D05",
    name: "Owen Brooks",
    street: "Pine Drive",
    city: "Chicago",
    state: "IL",
    email: "o.brooks@example-mail.com",
    orders: [{ id: "71426", item: "Sunlake Buds Pro earbuds", shortName: "Sunlake Buds Pro", noun: "earbuds", price: 99, deliveredDaysAgo: 2 }],
    decoyOrders: ["71462"],
  },
  {
    id: "R-D06",
    name: "Hannah Cole",
    street: "Lake Road",
    city: "Miami",
    state: "FL",
    email: "h.cole@example-mail.com",
    orders: [{ id: "06294", item: "Sunlake Charge power bank", shortName: "Sunlake Charge", noun: "power bank", price: 45, deliveredDaysAgo: 1 }],
    decoyOrders: ["06291"],
  },
  {
    id: "R-D07",
    name: "Mariam Haddad",
    street: "Cedar Court",
    city: "Austin",
    state: "TX",
    email: "m.haddad@example-mail.com",
    orders: [],
    decoyCustomers: [{ name: "Marian Hadley", street: "Birch Lane", city: "Austin", state: "TX" }],
  },
  {
    id: "R-D08",
    name: "Lucas Ferreira",
    street: "Willow Lane",
    city: "Portland",
    state: "OR",
    email: "l.ferreira@example-mail.com",
    orders: [],
    decoyCustomers: [{ name: "Nadia Price", street: "Willow Way", city: "Portland", state: "OR" }],
  },
  {
    id: "R-D09",
    name: "Grace Whitfield",
    street: "Elm Row",
    city: "Denver",
    state: "CO",
    email: "g.whitfield@example-mail.com",
    orders: [],
    decoyCustomers: [{ name: "Grace Whitford", street: "Ash Street", city: "Denver", state: "CO" }],
  },
];

const customerOf = (id: string, c: { name: string; street: string; city: string; state: string }, email: string): Customer => ({
  id,
  name: c.name,
  emailMasked: `${email.slice(0, 4)}•••@${email.split("@")[1]}`,
  emailFull: email,
  phoneMasked: "+1 (•••) •••-0000",
  address: { street: c.street, city: c.city, state: c.state },
  customerSince: "March 2024",
  status: "Active, no open cases",
  damageClaimsLast90Days: 0,
});

/** The client pack for one evaluation record: the caller is that record's customer. */
export function evalPack(recordId: RecordId): ClientPack {
  const spec = SPECS.find((s) => s.id === recordId);
  if (!spec) throw new Error(`Unknown evaluation record ${recordId}`);
  const customerId = `EV-${recordId}`;
  const customer = customerOf(customerId, spec, spec.email);
  const decoyCustomers = (spec.decoyCustomers ?? []).map((d, i) => customerOf(`${customerId}-decoy-${i + 1}`, d, `decoy${i + 1}@example-mail.com`));
  const orders: Order[] = [
    ...spec.orders.map((o) => ({
      ...o,
      customerId,
      customerName: spec.name,
      placedDaysAgo: o.deliveredDaysAgo + 3,
      status: "Delivered" as const,
      inStock: true,
      stockUnits: 12,
      payment: "Visa ending 1111",
      shipping: "Standard ground",
    })),
    // Decoys: another customer's orders, one transposition or digit away. They must never match.
    ...(spec.decoyOrders ?? []).map((id) => ({
      id,
      customerId: `${customerId}-decoy-order`,
      customerName: "Decoy customer",
      item: "Decoy item",
      shortName: "Decoy item",
      noun: "item",
      price: 60,
      placedDaysAgo: 5,
      deliveredDaysAgo: 2,
      status: "Delivered" as const,
      inStock: true,
    })),
  ];
  return {
    ...sunlake,
    caseId: `EVAL-${recordId}`,
    company: { ...sunlake.company, fictionalNote: "Fictional evaluation record set (Step 7 harness), never used on a call" },
    customers: [customer, ...decoyCustomers],
    orders,
    callerCustomerId: customerId,
  };
}

/** Every value the record set adds, for the check that none of it reaches the stage pack. */
export const RECORD_MARKERS: string[] = SPECS.flatMap((s) => [
  s.name,
  s.street,
  s.email,
  ...s.orders.map((o) => o.id),
  ...(s.decoyOrders ?? []),
  ...(s.decoyCustomers ?? []).flatMap((d) => [d.name, d.street]),
]);
