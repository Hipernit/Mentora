/**
 * confidence.test.js — tests for confidence-weighted BKT updates (the optional
 * `confident` argument to ConceptTracer.observe() / MasteryModel.recordAnswer()).
 * Run with: node confidence.test.js
 */
const { ConceptTracer, MasteryModel } = require("./bkt.js");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  ok -", msg); }
  else { failed++; console.error("  FAIL:", msg); }
}
function approx(a, b, eps = 1e-12) { return Math.abs(a - b) < eps; }

const PARAMS = { pInit: 0.4, pLearn: 0.2, pSlip: 0.1, pGuess: 0.2 };

// 1. Backward compatibility: calling observe(correct) with NO confidence arg
// must produce byte-identical mastery to observe(correct, null) — existing
// callers (app.js's original flow, bkt.test.js) never pass a third argument,
// so this must be a total no-op unless confidence is explicitly true/false.
{
  const a = new ConceptTracer(PARAMS);
  const b = new ConceptTracer(PARAMS);
  const seq = [true, false, true, true, false, true];
  seq.forEach((correct) => a.observe(correct));
  seq.forEach((correct) => b.observe(correct, null));
  assert(approx(a.mastery, b.mastery), "observe(correct) with no confidence arg matches observe(correct, null) exactly");
}

// 2. Backward compatibility part 2: the SAME sequence run through observe()
// with no confidence arg reproduces the mastery trajectory from before this
// feature existed (hand-computed via the original unweighted formula).
{
  const t = new ConceptTracer(PARAMS);
  let L = PARAMS.pInit;
  const seq = [true, false, true, true];
  const expectedTrajectory = seq.map((correct) => {
    let posterior;
    if (correct) {
      posterior = (L * (1 - PARAMS.pSlip)) / (L * (1 - PARAMS.pSlip) + (1 - L) * PARAMS.pGuess);
    } else {
      posterior = (L * PARAMS.pSlip) / (L * PARAMS.pSlip + (1 - L) * (1 - PARAMS.pGuess));
    }
    L = correct ? posterior + (1 - posterior) * PARAMS.pLearn : posterior;
    return L;
  });
  seq.forEach((correct, i) => {
    const m = t.observe(correct);
    assert(approx(m, expectedTrajectory[i]), `unweighted observe() step ${i + 1} matches hand-computed original BKT formula`);
  });
}

// 3. Correct & confident should give MORE mastery credit than correct & unsure,
// starting from the same state (lower effective guess-chance assumed).
{
  const confident = new ConceptTracer(PARAMS);
  const unsure = new ConceptTracer(PARAMS);
  const mConfident = confident.observe(true, true);
  const mUnsure = unsure.observe(true, false);
  assert(mConfident > mUnsure, `correct+confident (${mConfident.toFixed(4)}) yields higher mastery than correct+unsure (${mUnsure.toFixed(4)})`);
}

// 4. Incorrect & confident should DROP mastery more than incorrect & unsure —
// a sure-but-wrong answer looks like a real misconception (lower effective
// slip-chance assumed => bigger penalty); an unsure-but-wrong guess going
// wrong is the expected/default case and should sting less.
{
  const confident = new ConceptTracer(PARAMS);
  const unsure = new ConceptTracer(PARAMS);
  const mConfident = confident.observe(false, true);
  const mUnsure = unsure.observe(false, false);
  assert(mConfident < mUnsure, `incorrect+confident (${mConfident.toFixed(4)}) drops mastery more than incorrect+unsure (${mUnsure.toFixed(4)})`);
}

// 5. Both confidence-weighted branches still stay within [0,1] and never
// invert the basic correct-vs-incorrect direction (correct always nets >= the
// unweighted incorrect outcome would, regardless of confidence flavor).
{
  for (const confident of [true, false, null]) {
    const t = new ConceptTracer(PARAMS);
    const m = t.observe(true, confident);
    assert(m >= 0 && m <= 1, `observe(true, confident=${confident}) stays within [0,1] (got ${m})`);
  }
  for (const confident of [true, false, null]) {
    const t = new ConceptTracer(PARAMS);
    const m = t.observe(false, confident);
    assert(m >= 0 && m <= 1, `observe(false, confident=${confident}) stays within [0,1] (got ${m})`);
  }
}

// 6. Regression guard carried over from bkt.test.js: a wrong answer must never
// net-increase mastery, REGARDLESS of confidence flavor (pLearn still only
// fires on correct answers; confidence only touches pSlip/pGuess).
{
  for (const confident of [true, false, null]) {
    const t = new ConceptTracer({ pInit: 0.25, pLearn: 0.3, pSlip: 0.1, pGuess: 0.22 });
    const start = t.mastery;
    t.observe(false, confident);
    assert(t.mastery < start, `a wrong answer decreases mastery even with confident=${confident}`);
  }
}

// 7. history records the confident flag correctly (true/false/null), which is
// what a future analysis pass (or saveSession) would rely on.
{
  const t = new ConceptTracer(PARAMS);
  t.observe(true, true);
  t.observe(false, false);
  t.observe(true); // no arg at all
  t.observe(true, null); // explicit null
  const flags = t.history.map((h) => h.confident);
  assert(JSON.stringify(flags) === JSON.stringify([true, false, null, null]), `history.confident correctly records [true, false, null, null] (got ${JSON.stringify(flags)})`);
}

// 8. MasteryModel.recordAnswer passes confidence through to the right tracer.
{
  const concepts = [{ id: "x", label: "X", dependsOn: [] }];
  const modelA = new MasteryModel(concepts, PARAMS);
  const modelB = new MasteryModel(concepts, PARAMS);
  modelA.recordAnswer("x", true, true);
  modelB.recordAnswer("x", true, false);
  assert(modelA.getMastery("x") > modelB.getMastery("x"), "MasteryModel.recordAnswer(id, correct, confident) forwards confidence to the right ConceptTracer");
  assert(modelA.tracers.x.history[0].confident === true, "MasteryModel.recordAnswer records confident=true on the tracer history");
}

// 9. Constructor/param guard still applies with confidence in play — an
// invalid pSlip/pGuess still throws before confidence ever comes into it.
{
  let threw = false;
  try { new ConceptTracer({ pSlip: 1 }); } catch (e) { threw = true; }
  assert(threw, "constructor still throws on invalid pSlip regardless of the new confidence feature");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
