/**
 * bktFit.test.js — tests for the parameter-fitting module.
 * Run: node bktFit.test.js
 */
const {
  DEFAULT_PARAMS,
  seqLogLikelihood,
  totalLogLikelihood,
  fitParameters,
  fitModel,
} = require("./bktFit");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log("  ✓ " + msg);
  } else {
    failed++;
    console.log("  ✗ " + msg);
  }
}

// Deterministic RNG so tests are reproducible.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Generate a synthetic BKT answer sequence from a known generative HMM:
 * latent "known" state starts known w.p. pInit; each opportunity it can
 * transition not-known -> known w.p. pLearn; answers emitted with slip/guess.
 */
function simulate(params, length, rng) {
  const { pInit, pLearn, pSlip, pGuess } = params;
  let known = rng() < pInit;
  const seq = [];
  for (let i = 0; i < length; i++) {
    const correct = known ? rng() > pSlip : rng() < pGuess;
    seq.push(correct);
    if (!known && rng() < pLearn) known = true;
  }
  return seq;
}

function simulateMany(params, nSeq, length, rng) {
  const out = [];
  for (let i = 0; i < nSeq; i++) out.push(simulate(params, length, rng));
  return out;
}

console.log("seqLogLikelihood — sanity");
{
  const p = DEFAULT_PARAMS;
  const ll = seqLogLikelihood([true, true, true], p);
  assert(ll < 0 && Number.isFinite(ll), "log-likelihood is a finite negative number");
  // A strong-learner sequence should be more likely under low-slip params
  // than under high-slip params.
  const strong = [true, true, true, true, true, true];
  const llLowSlip = seqLogLikelihood(strong, { pInit: 0.6, pLearn: 0.3, pSlip: 0.05, pGuess: 0.2 });
  const llHighSlip = seqLogLikelihood(strong, { pInit: 0.6, pLearn: 0.3, pSlip: 0.45, pGuess: 0.2 });
  assert(llLowSlip > llHighSlip, "all-correct run is more likely under low slip than high slip");
}

console.log("fitParameters — small-data guard");
{
  const res = fitParameters([[true, false, true]], { minObservations: 8 });
  assert(res.fitted === false, "flags fitted:false below minObservations");
  assert(
    res.params.pInit === DEFAULT_PARAMS.pInit && res.params.pSlip === DEFAULT_PARAMS.pSlip,
    "returns untouched defaults when data is too thin"
  );
}

console.log("fitParameters — never worse than defaults");
{
  const rng = makeRng(42);
  const truth = { pInit: 0.2, pLearn: 0.35, pSlip: 0.08, pGuess: 0.15 };
  const data = simulateMany(truth, 40, 12, rng);
  const res = fitParameters(data);
  assert(res.fitted === true, "fits when data is sufficient");
  assert(
    res.logLikelihood >= res.baselineLogLikelihood - 1e-9,
    "fitted log-likelihood is >= default-parameter log-likelihood"
  );
}

console.log("fitParameters — recovers a low-slip / high-mastery regime");
{
  const rng = makeRng(7);
  // Strong learners: known early, rarely slip.
  const truth = { pInit: 0.7, pLearn: 0.4, pSlip: 0.05, pGuess: 0.15 };
  const data = simulateMany(truth, 60, 15, rng);
  const res = fitParameters(data);
  assert(res.params.pSlip < 0.2, `recovers low slip (got ${res.params.pSlip.toFixed(3)})`);
  assert(res.params.pInit > 0.4, `recovers high prior knowledge (got ${res.params.pInit.toFixed(3)})`);
}

console.log("fitParameters — distinguishes weak from strong cohorts");
{
  const rng = makeRng(99);
  const strongTruth = { pInit: 0.7, pLearn: 0.4, pSlip: 0.05, pGuess: 0.15 };
  const weakTruth = { pInit: 0.1, pLearn: 0.1, pSlip: 0.25, pGuess: 0.2 };
  const strongFit = fitParameters(simulateMany(strongTruth, 60, 15, rng));
  const weakFit = fitParameters(simulateMany(weakTruth, 60, 15, rng));
  assert(
    strongFit.params.pInit > weakFit.params.pInit,
    `strong cohort fits higher prior than weak (${strongFit.params.pInit.toFixed(2)} > ${weakFit.params.pInit.toFixed(2)})`
  );
}

console.log("fitModel — pulls sequences from a MasteryModel");
{
  const { MasteryModel } = require("./bkt");
  const concepts = [
    { id: "a", label: "A", dependsOn: [] },
    { id: "b", label: "B", dependsOn: ["a"] },
  ];
  const model = new MasteryModel(concepts);
  const answers = [true, false, true, true, false, true, true, true, true, false, true, true];
  answers.forEach((c, i) => model.recordAnswer(i % 2 === 0 ? "a" : "b", c));
  const res = fitModel(model, { minObservations: 8 });
  assert(res.observations === answers.length, "pools all recorded answers across concepts");
  assert(res.fitted === true, "fits from a live MasteryModel");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
