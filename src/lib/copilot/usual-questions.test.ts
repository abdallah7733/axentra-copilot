import { test } from "node:test";
import assert from "node:assert/strict";
import { QUESTION_WORDS, USUAL_QUESTIONS, isQuestionWord, questionGap, usualDetail, usualQuestion } from "./usual-questions";
import { words } from "./text";
import { sunlake } from "@/lib/live/sunlake-data";

/*
  C12 (his "Build C12", 23 Nov 2026): his line goes in front of a name or address answer only when the fast model's
  words for it closely match one of his usual questions. A list of allowed questions, not a screen for names.
*/
const RECORD = new Set(
  [...sunlake.customers.flatMap((c) => [c.name, c.address.street, c.address.city, c.address.state]), ...sunlake.orders.map((o) => o.customerName)].flatMap((t) => words(t))
);

test("every usual question counts for its own detail and not the other, with Sunlake's record words to avoid", () => {
  for (const detail of ["name", "address"] as const)
    for (const q of USUAL_QUESTIONS[detail]) {
      assert.ok(usualQuestion(q, detail, RECORD), `${detail}: ${q}`);
      assert.ok(!usualQuestion(q, detail === "name" ? "address" : "name", RECORD), `not the other detail: ${q}`);
    }
});

test("his lines on the test calls count, lead-ins included, and as the fast model wrote them on 11 Nov", () => {
  for (const q of [
    "First, can I have your full name, please?",
    "I'm sorry to hear that. First, can I have your full name, please?",
    "Thank you. And your full name, please?",
    "Okay, could you repeat your full name",
    "Full name?",
  ])
    assert.ok(usualQuestion(q, "name", RECORD), q);
  for (const q of [
    "Thank you. And the street and city for the delivery?",
    "First, can I have the street and city for the delivery?",
    "Sorry, could you repeat the street and city.",
    // The 11 Nov calls' fast-model words for his address question: articles dropped or swapped, one word missing.
    "and the street and city for delivery.",
    "and street and city for delivery.",
    "And a street and city for the delivery.",
    "and the city for delivery.",
  ])
    assert.ok(usualQuestion(q, "address", RECORD), q);
});

test("read-backs, echoes, names, garbled lines and other questions never count", () => {
  const never = [
    // Read-backs and lines with the record's words, even one ("Hill").
    "So it's Sam Miller, right?",
    "So your name is Sam Miller, right?",
    "Hill Road in Dallas, correct?",
    "What's the street and city, Hill Road?",
    "Could you repeat your full name, Sam?",
    // A re-ask with a name that isn't on the record is no usual question either.
    "Could you repeat your full name, Mona?",
    // The caller's words on the agent's microphone (I-47).
    "Sam Miller.",
    "Hill Road, in Dallas.",
    // Garbled by the fast model, or another question.
    "Can I have your full knee, please?",
    "Could you spell your last name?",
    "Can I have your full name and the street and city?",
    "Can I have your full name, thank you?",
    "Can I have your full name today?",
    "Name?",
    "City?",
    "Thank you.",
    "",
  ];
  for (const q of never) for (const detail of ["name", "address"] as const) assert.ok(!usualQuestion(q, detail, RECORD), `${detail}: ${q}`);
});

test("a word of the records keeps a usual question out, even an ordinary word", () => {
  assert.ok(usualQuestion("May I have your full name, please?", "name"));
  assert.ok(!usualQuestion("May I have your full name, please?", "name", new Set(["may"])), "a customer named May");
  assert.ok(!usualQuestion("The street and city for the delivery?", "address", new Set(["city"])));
  // Screened before articles and "please" are dropped (independent check of C12, finding 3): a two-letter name "An".
  assert.ok(usualQuestion("An, could you repeat your full name?", "name"), "without the record, the article is dropped");
  assert.ok(!usualQuestion("An, could you repeat your full name?", "name", new Set(["an"])), "a customer named An");
});

test("the detail a line asks for, and how far a line is from his usual questions", () => {
  assert.equal(usualDetail("First, can I have your full name?"), "name");
  assert.equal(usualDetail("And the street and city?"), "address");
  assert.equal(usualDetail("So it's Sam Miller, right?"), null);
  assert.equal(questionGap("First, can I have your full name, please?", "name"), 0);
  assert.equal(questionGap("Can I have the full name", "name"), 1);
  assert.equal(questionGap("Can I have the full name on the account?", "name"), 0);
  assert.equal(questionGap("Can I have your full name? Name?", "name"), 1, "an echo takes it further");
  assert.equal(questionGap("And the street and city for the delivery?", "address"), 0);
  assert.ok(isQuestionWord("please") && isQuestionWord("delivery") && isQuestionWord("the"));
  assert.ok(!isQuestionWord("sam") && !isQuestionWord("my") && !isQuestionWord("it's"));
});

test("at most two words missing, and one word changed or added only from his questions' own words", () => {
  assert.ok(usualQuestion("Can I have the street and city?", "address"), "two missing");
  assert.ok(!usualQuestion("Can I have city?", "address"), "more than two missing");
  assert.ok(usualQuestion("Can I have your full name on?", "name"), "one added, from his questions' words");
  assert.ok(!usualQuestion("Can I have your full name for the account?", "name"), "two changed or added");
  // The vocabulary holds no Sunlake record word, so his usual questions never collide with the records.
  for (const w of RECORD) assert.ok(!QUESTION_WORDS.has(w), w);
});
