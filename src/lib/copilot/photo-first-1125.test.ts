import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, approvalReadiness } from "./copilot";
import type { AgentAction, ClientPack, TranscriptEvent } from "./types";
import { scriptV2, sunlake } from "@/lib/live/sunlake-data";

/*
  The photo rule (his "Approved, Option A", 25 Nov 2026). CS-SOP-3.1, Claim rules: "Orders under $500 can be resolved
  before a photo arrives; the customer is asked to upload one within 7 days ... Orders of $500 or more need the photo
  before any resolution." Resolution authority: $0 to $500 the agent; $500.01 to $1,500 the Team Lead, "photo required
  first"; Scenario C: value above the agent's authority, agents can't approve. Expected results below are the written
  policy's, at $499.99, $500.00 and $500.01, each with and without the photo. Sunlake evaluation scenario S06 found the
  $500.00 order approved with no photo.
*/

const NOW = Date.UTC(2026, 10, 25, 12);
const T = (i: number) => NOW - 600_000 + i * 5000;
const lines = (upTo = 11): TranscriptEvent[] =>
  scriptV2
    .filter((l) => l.n <= upTo)
    .map((l, i) => ({ callId: "CA-photo", seq: i + 1, key: `t${i + 1}`, side: l.side, text: l.text, startedAt: T(i), endedAt: T(i) + 3000, final: true, confidence: 0.95 }));
const AFTER = T(11) + 1000;

const packAt = (price: number, photoRule = true, devSwitches = false): ClientPack => ({
  ...sunlake,
  policy: {
    ...sunlake.policy,
    photoBeforeResolution: photoRule,
    ...(devSwitches ? { nameReadBack: true, addressReadBack: true, agentConfirmsMatch: true, strictMatch: true, questionInCheck: true, noNameNotCounted: true } : {}),
  },
  orders: sunlake.orders.map((o) => (o.id === "427" ? { ...o, price } : o)),
});
const photo = (at: number): AgentAction => ({ type: "confirm", target: "photo", at });
const approve = (at: number): AgentAction => ({ type: "approve", at });
const run = (price: number, actions: AgentAction[], photoRule = true) => analyze(packAt(price, photoRule), lines(), actions, AFTER + 10_000);

test("$499.99 without the photo: the agent can resolve now, and the photo is requested within 7 days", () => {
  const v = run(499.99, [approve(AFTER)]);
  const rec = v.recommendation!;
  assert.equal(rec.scenario, "A");
  assert.equal(rec.agentCanApprove, true);
  assert.equal(rec.photoPending, undefined);
  assert.equal(rec.approval.state, "approved");
  assert.ok(rec.prepared!.lines.some((l) => /Photo of the damage requested within 7 days/.test(l)));
  assert.equal(v.checks.find((c) => c.id === "photo")!.pass, true);
});

test("$499.99 with the photo: the same, the photo changes nothing", () => {
  const v = run(499.99, [photo(AFTER - 500), approve(AFTER)]);
  assert.equal(v.recommendation!.scenario, "A");
  assert.equal(v.recommendation!.approval.state, "approved");
});

test("$500.00 without the photo: nothing is prepared and the approval doesn't count", () => {
  const v = run(500, [approve(AFTER)]);
  const rec = v.recommendation!;
  assert.equal(rec.scenario, "A");
  assert.equal(rec.agentCanApprove, true, "$500.00 is in the agent's band ($0 to $500)");
  assert.equal(rec.photoPending, true);
  assert.equal(rec.prepared, undefined);
  assert.equal(rec.approval.state, "not-ready");
  assert.match(rec.staleApproval!.reason, /photo of the damage hadn't arrived/);
  assert.match(approvalReadiness(v)!, /photo of the damage is needed first/);
  const check = v.checks.find((c) => c.id === "photo")!;
  assert.equal(check.pass, false);
  assert.match(check.detail, /photo first/);
});

test("$500.00 with the photo recorded before the approval: the approval counts", () => {
  const v = run(500, [photo(AFTER - 500), approve(AFTER)]);
  const rec = v.recommendation!;
  assert.equal(rec.photoPending, undefined);
  assert.equal(rec.prepared?.kind, "replacement");
  assert.equal(rec.approval.state, "approved");
  assert.match(v.checks.find((c) => c.id === "photo")!.detail, /photo received/);
});

test("$500.00 approved before the photo arrived: that approval stays uncounted; approving again after the photo counts", () => {
  const early = run(500, [approve(AFTER), photo(AFTER + 2000)]);
  assert.equal(early.recommendation!.approval.state, "awaiting");
  assert.equal(early.recommendation!.history?.[0]?.counted, false);
  assert.match(early.recommendation!.history![0].reason!, /photo of the damage hadn't arrived/);
  const again = run(500, [approve(AFTER), photo(AFTER + 2000), approve(AFTER + 4000)]);
  assert.equal(again.recommendation!.approval.state, "approved");
  assert.equal(again.recommendation!.approval.at, AFTER + 4000);
});

test("$500.00 on the dev console's switches (every match confirmed by the agent): the same rule holds", () => {
  const press = (target: "name" | "address", at: number): AgentAction => ({ type: "confirm", target, at });
  const actions = [press("name", T(4) + 3500), press("address", T(6) + 3500)];
  const without = analyze(packAt(500, true, true), lines(), [...actions, approve(AFTER)], AFTER + 10_000);
  assert.equal(without.verification.verified, true);
  assert.equal(without.recommendation!.approval.state, "not-ready");
  const withPhoto = analyze(packAt(500, true, true), lines(), [...actions, photo(AFTER - 500), approve(AFTER)], AFTER + 10_000);
  assert.equal(withPhoto.recommendation!.approval.state, "approved");
});

test("$500.01 without the photo: Team Lead band, Scenario C, the agent can't approve", () => {
  const v = run(500.01, [approve(AFTER)]);
  const rec = v.recommendation!;
  assert.equal(rec.scenario, "C");
  assert.equal(rec.agentCanApprove, false);
  assert.notEqual(rec.approval.state, "approved");
  assert.match(v.checks.find((c) => c.id === "value")!.detail, /Team Lead/);
});

test("$500.01 with the photo: still Scenario C; the photo never moves approval to the agent", () => {
  const v = run(500.01, [photo(AFTER - 500), approve(AFTER)]);
  const rec = v.recommendation!;
  assert.equal(rec.scenario, "C");
  assert.equal(rec.agentCanApprove, false);
  assert.notEqual(rec.approval.state, "approved");
});

test("the switch off keeps the earlier behaviour (as on stage and the public site): $500.00 is approved without a photo", () => {
  const v = run(500, [approve(AFTER)], false);
  assert.equal(v.recommendation!.approval.state, "approved");
  assert.equal(v.recommendation!.photoPending, undefined);
});
