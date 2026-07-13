/**
 * persist.test.js — verifies the replay logic behind loadSession() in app.js:
 * a MasteryModel's state can be fully reconstructed from (a) the BKT params it
 * was built with and (b) the per-concept sequence of `correct` booleans, with
 * no loss of precision. app.js itself isn't require()-able (it's a browser
 * script with DOM/localStorage side effects), so this exercises the exact
 * same replay pattern loadSession() uses, directly against bkt.js.
 *
 * Run with: node persist.test.js
 */
const { MasteryModel } = require("./bkt.js");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  ok -", msg); }
  else { failed++; console.error("  FAIL:", msg); }
}
function approx(a, b, eps = 1e-12) { return Math.abs(a - b) < eps; }

/** Pulls out the same {conceptId: [bool,...]} shape saveSession() stores. */
function extractHistories(model) {
  const histories = {};
  model.concepts.forEach((c) => {
    histories[c.id] = model.tracers[c.id].history.map((h) => h.correct);
  });
  return histories;
}

/** Mirrors loadSession(): rebuild a fresh model with the same params, replay. */
function rebuildAndReplay(concepts, params, histories) {
  const rebuilt = new MasteryModel(concepts, params);
  concepts.forEach((c) => {
    (histories[c.id] || []).forEach((correct) => rebuilt.recordAnswer(c.id, correct));
  });
  return rebuilt;
}

const concepts = [
  { id: "c1", label: "Concept 1", dependsOn: [] },
  { id: "c2", label: "Concept 2", dependsOn: ["c1"] },
  { id: "c3", label: "Concept 3 (never answered)", dependsOn: ["c1"] },
];

// 1. Default BKT params, a realistic mixed answer pattern per concept.
{
  const params = { pInit: 0.2, pLearn: 0.22, pSlip: 0.08, pGuess: 0.25 };
  const original = new MasteryModel(concepts, params);
  const answers = {
    c1: [true, true, false, true, true, true, false, true],
    c2: [false, false, true, true, true],
    c3: [], // untouched concept — replay must reproduce the untouched pInit state
  };
  concepts.forEach((c) => answers[c.id].forEach((correct) => original.recordAnswer(c.id, correct)));

  const histories = extractHistories(original);
  const rebuilt = rebuildAndReplay(concepts, params, histories);

  concepts.forEach((c) => {
    const a = original.getMastery(c.id);
    const b = rebuilt.getMastery(c.id);
    assert(approx(a, b), `[default params] concept ${c.id} mastery matches after replay (orig=${a}, rebuilt=${b})`);
  });

  // The whole history array (not just final mastery) should match exactly too,
  // since it's what would be re-serialized on the next saveSession() call.
  concepts.forEach((c) => {
    const origSeq = original.tracers[c.id].history.map((h) => h.correct);
    const rebuiltSeq = rebuilt.tracers[c.id].history.map((h) => h.correct);
    assert(JSON.stringify(origSeq) === JSON.stringify(rebuiltSeq), `[default params] concept ${c.id} replayed history sequence matches original`);
  });

  assert(approx(original.overallMastery(), rebuilt.overallMastery()), "[default params] overallMastery matches after replay");
}

// 2. A different (e.g. learned/fitted) params set — replay must use the SAVED
// params, not the module defaults, exactly like loadSession() passing `data.params`.
{
  const learnedParams = { pInit: 0.35, pLearn: 0.18, pSlip: 0.05, pGuess: 0.12 };
  const original = new MasteryModel(concepts, learnedParams);
  const answers = {
    c1: [true, false, true, true, false, false, true],
    c2: [true, true, true, true],
    c3: [false, false],
  };
  concepts.forEach((c) => answers[c.id].forEach((correct) => original.recordAnswer(c.id, correct)));

  const histories = extractHistories(original);
  const rebuilt = rebuildAndReplay(concepts, learnedParams, histories);

  concepts.forEach((c) => {
    assert(approx(original.getMastery(c.id), rebuilt.getMastery(c.id)), `[learned params] concept ${c.id} mastery matches after replay`);
  });
}

// 3. Regression guard: replaying with the WRONG params (e.g. forgetting to save
// the learned params and falling back to defaults) should generally NOT match —
// this proves the test above is actually sensitive to params being carried
// through correctly, rather than trivially passing regardless of params.
{
  const learnedParams = { pInit: 0.35, pLearn: 0.18, pSlip: 0.05, pGuess: 0.12 };
  const wrongParams = { pInit: 0.2, pLearn: 0.22, pSlip: 0.08, pGuess: 0.25 };
  const original = new MasteryModel(concepts, learnedParams);
  const answers = { c1: [true, false, true, true, false], c2: [true, true], c3: [] };
  concepts.forEach((c) => answers[c.id].forEach((correct) => original.recordAnswer(c.id, correct)));

  const histories = extractHistories(original);
  const mismatched = rebuildAndReplay(concepts, wrongParams, histories);

  const mismatchFound = concepts.some((c) => !approx(original.getMastery(c.id), mismatched.getMastery(c.id), 1e-9));
  assert(mismatchFound, "replaying with mismatched params does NOT reproduce original mastery (sanity check that the test is meaningful)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
