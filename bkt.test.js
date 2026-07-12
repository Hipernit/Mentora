/**
 * bkt.test.js — sanity tests for the Bayesian Knowledge Tracing engine.
 * Run with: node bkt.test.js
 */
const { ConceptTracer, MasteryModel } = require("./bkt.js");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${msg}`); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }

// 1. Mastery increases on repeated correct answers
{
  const t = new ConceptTracer();
  const start = t.mastery;
  for (let i = 0; i < 5; i++) t.observe(true);
  assert(t.mastery > start, "mastery should increase after 5 correct answers");
  assert(t.mastery <= 1 && t.mastery >= 0, "mastery must stay within [0,1]");
}

// 2. Mastery stays lower with repeated incorrect answers than with correct ones
{
  const tGood = new ConceptTracer();
  const tBad = new ConceptTracer();
  for (let i = 0; i < 5; i++) { tGood.observe(true); tBad.observe(false); }
  assert(tGood.mastery > tBad.mastery, "correct-answer trace should end with higher mastery than incorrect-answer trace");
}

// 3. Mastery never goes negative or above 1 even with alternating evidence
{
  const t = new ConceptTracer({ pInit: 0.5, pLearn: 0.2, pSlip: 0.1, pGuess: 0.2 });
  for (let i = 0; i < 20; i++) t.observe(i % 2 === 0);
  assert(t.mastery >= 0 && t.mastery <= 1, "mastery bounded in [0,1] under alternating evidence");
}

// 4. isMastered threshold behaves correctly
{
  const t = new ConceptTracer({ pInit: 0.9 });
  assert(t.isMastered(0.85) === true, "high pInit should count as mastered at 0.85 threshold");
}

// 5. MasteryModel.recommendNext respects prerequisite gating
{
  const concepts = [
    { id: "a", label: "A", dependsOn: [] },
    { id: "b", label: "B", dependsOn: ["a"] },
  ];
  const model = new MasteryModel(concepts, { pInit: 0.05, pLearn: 0.1, pSlip: 0.1, pGuess: 0.1 });
  const first = model.recommendNext();
  assert(first.id === "a", "with low pInit, concept A (no deps) should be recommended before B");

  // Master A directly, then B should become recommendable
  for (let i = 0; i < 15; i++) model.recordAnswer("a", true);
  const next = model.recommendNext();
  assert(next && next.id === "b", "once A is mastered, B should be recommended next");
}

// 6. recommendNext returns null when everything is mastered
{
  const concepts = [{ id: "a", label: "A", dependsOn: [] }];
  const model = new MasteryModel(concepts, { pInit: 0.95 });
  assert(model.recommendNext() === null, "recommendNext should return null when all concepts already mastered");
}

// 7. Constructor guards against invalid slip/guess params
{
  let threw = false;
  try { new ConceptTracer({ pSlip: 1 }); } catch (e) { threw = true; }
  assert(threw, "constructor should throw when pSlip >= 1 (would divide by zero)");
}

// 8. Regression: a wrong answer must never net-increase mastery. Earlier this
// engine applied the pLearn transition unconditionally, so a high pLearn
// (e.g. 0.3) could swamp the evidence-based drop from a wrong answer and
// leave mastery *higher* than before — visibly broken in a live demo.
{
  const t = new ConceptTracer({ pInit: 0.25, pLearn: 0.3, pSlip: 0.1, pGuess: 0.22 });
  const start = t.mastery;
  t.observe(false);
  assert(t.mastery < start, "a single wrong answer must decrease mastery, not increase it");
  const afterOne = t.mastery;
  t.observe(false);
  assert(t.mastery <= afterOne, "repeated wrong answers must not creep mastery upward");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
