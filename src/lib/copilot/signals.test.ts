import { test } from "node:test";
import assert from "node:assert/strict";
import { agentAsksFor, agentCommits, agentDisclosesFactor, agentOffers, escalationWords, readChoice, readIntent, safetyWords } from "./signals";
import { matchAddress, matchName, soundsLikeRecord } from "./verification";
import { samMiller } from "@/lib/live/sunlake-data";

const damaged = (text: string) => readIntent(text).find((i) => i.id === "damaged");

// Off-script phrasings the rules must still catch (content §8).
for (const text of [
  "the screen is cracked",
  "the screen has a crack",
  "the glass is broken",
  "it came damaged",
  "it's broken",
  "the box was crushed and the tablet is damaged",
]) {
  test(`damaged: "${text}"`, () => assert.ok((damaged(text)?.score ?? 0) >= 0.5));
}

test("real mis-heard caller lines still read as damaged", () => {
  assert.ok(damaged("I need help to the order 427, it arrive to the track screen.")!.score >= 0.5);
  assert.ok(damaged("It arards with a track screen.")!.score >= 0.5);
  assert.ok(damaged("I need help with order 527. Arised with a crack.")!.score >= 0.5);
  // ...but "track screen" alone is weaker evidence than "cracked".
  assert.ok(damaged("It arards with a track screen.")!.score < 0.8);
  assert.ok(damaged("The tablet came yesterday, and the screen is cracked.")!.score >= 0.8);
});

test("not damage", () => {
  assert.equal(damaged("Hello. How are you?"), undefined);
  assert.equal(damaged("The screen is not cracked, it just won't turn on."), undefined);
});

for (const text of ["a new one", "send me another one", "replace it", "exchange it"]) {
  test(`wants replacement: "${text}"`, () => assert.equal(readChoice(text)?.choice, "replacement"));
}
for (const text of ["my money back", "a refund", "cancel it and pay me back", "return it for a refund"]) {
  test(`wants refund: "${text}"`, () => assert.equal(readChoice(text)?.choice, "refund"));
}
test("asking about both is not a choice", () => {
  assert.equal(readChoice("Yes, only the screen. Can I get a new one, or my money back?")?.choice, "both");
});
test("negated wish is ignored", () => {
  assert.equal(readChoice("I don't want a refund, just a new one.")?.choice, "replacement");
});

for (const text of ["chargeback", "I will call my bank", "I'll get a lawyer", "this is fraud", "This is the second time."]) {
  test(`escalation words: "${text}"`, () => assert.ok(escalationWords(text).length > 0));
}
for (const text of ["it's getting hot", "there was smoke", "a burning smell", "the battery looks swollen", "the battery", "I hurt my hand on the glass"]) {
  test(`safety words: "${text}"`, () => assert.ok(safetyWords(text).length > 0));
}
test("no false safety or escalation alarms on the main script", () => {
  for (const text of ["Thank you for calling Sunlake. How can I help you today?", "The tablet came yesterday, and the screen is cracked.", "A new one, please.", "Great, thank you."]) {
    assert.deepEqual(safetyWords(text), []);
    assert.deepEqual(escalationWords(text), []);
  }
  assert.deepEqual(safetyWords("It's not hot or anything."), []);
});

test("agent offers", () => {
  assert.ok(agentOffers("I'm sorry to hear that. I can send you a new one today."));
  assert.ok(agentOffers("I'm sorry to hear that I can send a replacement for order 4 to 7 today."));
  assert.ok(agentOffers("Would you like a replacement?"));
  assert.equal(agentOffers("Thank you for calling Sunlake. How can I help you today?"), null);
  assert.equal(agentOffers("Thank you, Sam. I can see the tablet on order 427. Is the damage only on the screen?"), null);
  assert.equal(agentOffers("First, can I have your full name, please?"), null);
});

test("agent asks for identity details", () => {
  assert.equal(agentAsksFor("First, can I have your full name, please?"), "name");
  assert.equal(agentAsksFor("Thank you. And the street and city for the delivery?"), "address");
  assert.equal(agentAsksFor("What's the email on the order?"), "address");
  assert.equal(agentAsksFor("Can you give me the order number?"), "order");
  assert.equal(agentAsksFor("Thank you for calling Sunlake. How can I help you today?"), null);
});

test("agent commits and discloses", () => {
  assert.ok(agentCommits("Done. The new tablet ships today. You'll get an email with a free return label for the damaged one."));
  assert.ok(agentDisclosesFactor("Sorry, the city doesn't match what we have."));
  assert.ok(agentDisclosesFactor("That's the wrong street."));
  assert.equal(agentDisclosesFactor("I wasn't able to match those details."), null);
});

test("identity factors", () => {
  assert.equal(matchName("Sam Miller.", samMiller), "match");
  assert.equal(matchName("My name is Sam Millar.", samMiller), "match");
  assert.equal(matchName("Sam.", samMiller), "partial");
  assert.equal(matchName("John Smith.", samMiller), "mismatch");
  assert.equal(matchName("Sorry, what?", samMiller), "none");
  assert.equal(matchAddress("Hill Road, in Dallas.", samMiller), "match");
  assert.equal(matchAddress("It's Hill Road in Dallas, Texas.", samMiller), "match");
  assert.equal(matchAddress("The street is Hill Road and the city is Dallas.", samMiller), "match");
  assert.equal(matchAddress("s dot miller at example mail dot com", samMiller), "match");
  assert.equal(matchAddress("Lake Road, in Houston.", samMiller), "mismatch");
  assert.equal(matchAddress("Hill Road, in Houston.", samMiller), "mismatch");
  assert.equal(matchAddress("Hill Street, Dallas.", samMiller), "mismatch");
  assert.equal(matchAddress("Dallas.", samMiller), "partial");
  // Heard on the Milestone 3 accuracy read (27 Sep): "Hill Road" came out as "Hel Road".
  assert.equal(matchAddress("Hel Road in Dallas.", samMiller), "match");
  assert.equal(matchAddress("Lake Road, in Dallas.", samMiller), "mismatch");
});

test("answers that only sound like the record", () => {
  assert.equal(soundsLikeRecord("address", "Helrout. Indalis.", samMiller), true);
  assert.equal(soundsLikeRecord("address", "Elroad indale", samMiller), true);
  assert.equal(soundsLikeRecord("address", "Lake Road, in Houston.", samMiller), false);
  assert.equal(soundsLikeRecord("address", "Hill Road, in Houston.", samMiller), false);
  assert.equal(soundsLikeRecord("name", "Semiler.", samMiller), true);
  assert.equal(soundsLikeRecord("name", "John Smith.", samMiller), false);
});
