import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { analyze } from "@/lib/copilot/copilot";
import { CASES, CASES_V1_SHA256, callerParts } from "./cases";
import { collapsedTokens, tagReference } from "./normalize";
import { evalPack } from "./records";
import { startState } from "./workflow";

/*
  The harness's cases are the frozen Step 7 v1 cases, value for value, and each starting state is
  the one the package defines (03_EXPECTED_OUTCOMES, section 2a). Harness checks, not speech results.
*/

const raw = readFileSync(new URL("./step7-cases-v1.json", import.meta.url));
const frozen = JSON.parse(raw.toString("utf8"));

test("the repo copy of the cases is byte-identical to the frozen v1 package", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), CASES_V1_SHA256);
  assert.equal(frozen.version, "v1");
});

test("every case equals the frozen JSON: texts, spans, expected fields, workflow, record, start state", () => {
  assert.deepEqual(CASES.map((c) => c.id), frozen.cases.map((c: { id: string }) => c.id));
  for (const c of CASES) {
    const f = frozen.cases.find((x: { id: string }) => x.id === c.id);
    assert.equal(c.tests, f.tests, c.id);
    assert.equal(c.agent, f.segments.A.text, c.id);
    assert.equal(c.caller, f.segments.C.text, c.id);
    assert.deepEqual(c.spans, f.spans, c.id);
    assert.deepEqual(c.expected, f.expected.fields, c.id);
    assert.equal(c.workflow, f.expected.workflow, c.id);
    assert.equal(c.record, f.expected.record ?? f.workflow_start_state.split(":")[0], c.id);
    assert.ok(f.workflow_start_state.startsWith(`${c.record}:`), c.id);
    assert.equal(c.startStateText, f.workflow_start_state, c.id);
    assert.deepEqual(c.issues, f.issues, c.id);
  }
});

test("the evaluation records carry the frozen names, order numbers, streets and decoys", () => {
  for (const [id, r] of Object.entries(frozen.evaluation_records) as [Parameters<typeof evalPack>[0], { customer: string; orders?: string[]; decoy_orders?: string[]; street?: string; city?: string; decoy_customers?: string[] }][]) {
    const pack = evalPack(id);
    const caller = pack.customers.find((c) => c.id === pack.callerCustomerId)!;
    assert.equal(caller.name, r.customer, id);
    assert.deepEqual(pack.orders.filter((o) => o.customerId === caller.id).map((o) => o.id), r.orders ?? [], id);
    assert.deepEqual(pack.orders.filter((o) => o.customerId !== caller.id).map((o) => o.id), r.decoy_orders ?? [], id);
    if (r.street) assert.deepEqual([caller.address.street, caller.address.city], [r.street, r.city], id);
    for (const d of r.decoy_customers ?? []) assert.ok(pack.customers.some((c) => c.name === d && c.id !== caller.id), `${id} decoy ${d}`);
    // The same SOP and policy as the stage pack: only the records differ.
    assert.equal(pack.sop.id, "CS-SOP-3.1");
    assert.equal(pack.policy.maxVerificationAttempts, 2);
  }
});

test("every reference tags cleanly: each number and range in it has exactly one span", () => {
  for (const c of CASES) assert.doesNotThrow(() => tagReference(collapsedTokens(c.caller), c.spans), c.id);
  assert.deepEqual(callerParts(CASES[4].caller), [{ text: "Order seven one four", pauseBeforeS: 0 }, { text: "two six.", pauseBeforeS: 1 }]);
  assert.deepEqual(callerParts(""), []);
});

test("each starting state is the one the package defines, set by typing and panel actions only", () => {
  for (const c of CASES) {
    const pack = evalPack(c.record);
    const { lines, actions } = startState(c, pack);
    const v = analyze(pack, lines, actions, Date.parse("2026-10-19T09:01:30.000Z"));
    const [name, address] = v.verification.factors;
    const want = { none: ["idle", "idle"], name: ["ok", "idle"], both: ["ok", "ok"] }[c.start.identity];
    assert.deepEqual([name.state, address.state], want, c.id);
    assert.equal(name.attempts + address.attempts, 0, c.id);
    if (c.start.identity !== "none") assert.match(name.method ?? "", /typed by the agent/, c.id);
    assert.equal(v.intent?.id === "damaged" && v.intent.certainty === "high", c.start.damage, c.id);
    assert.equal(v.recommendation?.approval.state === "approved", c.start.replacementApproved, c.id);
    if (c.start.replacementApproved) assert.equal(v.choice?.value, "replacement", c.id);
    // No speech counts in a starting state: every caller line in it was typed over.
    for (const l of lines.filter((x) => x.side === "caller")) assert.ok(actions.some((a) => a.type === "correct" && a.key === l.key), `${c.id} ${l.key}`);
  }
});
