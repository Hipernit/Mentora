/**
 * bktFit.js — parameter LEARNING for the BKT engine in bkt.js
 *
 * The problem this solves: ConceptTracer ships with hand-picked defaults
 * (pInit=0.3, pLearn=0.25, pSlip=0.1, pGuess=0.2). Those are guesses. A model
 * that never updates its own parameters from data isn't really "learning" —
 * it's a fixed formula. This module fits the four BKT parameters to a
 * student's actual observed answers by maximum likelihood, so the numbers the
 * model reports are grounded in evidence instead of assumption.
 *
 * How it fits: for a given parameter set we run the SAME forward recursion the
 * engine uses in ConceptTracer.observe() — including Mentora's convention of
 * applying the pLearn transition only after a correct answer — and score how
 * likely the observed answer sequence was. We then search parameter space
 * (coarse-to-fine grid) for the set that maximizes total log-likelihood across
 * all supplied sequences. Grid search is used deliberately over gradient
 * methods: it's transparent, deterministic, has no learning-rate to tune, and
 * the space is only 4-dimensional, so it's cheap enough to run in the browser.
 *
 * Identifiability guard: BKT is only identifiable when a knowing student is
 * more likely to answer correctly than a non-knowing one, i.e. pSlip and pGuess
 * must each stay below 0.5 (otherwise the "known" and "unknown" states swap and
 * mastery becomes meaningless). The search ranges enforce this.
 *
 * Small-data guard: fitting 4 parameters to a handful of answers overfits
 * badly. Below `minObservations` total answers, fitParameters() returns the
 * defaults untouched and flags fitted:false, so the app can honestly show
 * "still using defaults — not enough data yet" rather than a bogus fit.
 */

const DEFAULT_PARAMS = { pInit: 0.3, pLearn: 0.25, pSlip: 0.1, pGuess: 0.2 };

// Parameter bounds. slip/guess capped below 0.5 for identifiability.
const BOUNDS = {
  pInit: [0.01, 0.9],
  pLearn: [0.01, 0.9],
  pSlip: [0.01, 0.49],
  pGuess: [0.01, 0.49],
};

/**
 * Log-likelihood of one answer sequence under a parameter set, using the exact
 * forward dynamics of ConceptTracer (pLearn gated on correct answers).
 * @param {boolean[]} seq  ordered answers, true = correct
 * @param {object} params  { pInit, pLearn, pSlip, pGuess }
 * @returns {number} sum of log P(answer) over the sequence
 */
function seqLogLikelihood(seq, { pInit, pLearn, pSlip, pGuess }) {
  let L = pInit; // P(known) before the current observation
  let ll = 0;
  for (const correct of seq) {
    const pCorrect = L * (1 - pSlip) + (1 - L) * pGuess;
    const pObs = correct ? pCorrect : 1 - pCorrect;
    ll += Math.log(Math.max(pObs, 1e-12)); // floor guards log(0)

    // Bayes posterior on the latent "known" state given this answer
    let posterior;
    if (correct) {
      posterior = (L * (1 - pSlip)) / Math.max(pCorrect, 1e-12);
    } else {
      posterior = (L * pSlip) / Math.max(1 - pCorrect, 1e-12);
    }
    // Learning transition fires only after a correct answer (Mentora convention)
    L = correct ? posterior + (1 - posterior) * pLearn : posterior;
    L = Math.max(0, Math.min(1, L));
  }
  return ll;
}

/** Total log-likelihood across many sequences. */
function totalLogLikelihood(sequences, params) {
  let sum = 0;
  for (const seq of sequences) sum += seqLogLikelihood(seq, params);
  return sum;
}

function linspace(a, b, n) {
  if (n <= 1) return [(a + b) / 2];
  const out = [];
  for (let i = 0; i < n; i++) out.push(a + ((b - a) * i) / (n - 1));
  return out;
}

function clampToBounds(x, key) {
  const [lo, hi] = BOUNDS[key];
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Fit BKT parameters to observed answer sequences by maximum likelihood.
 *
 * @param {boolean[][]} sequences  one or more answer sequences (true=correct)
 * @param {object} [opts]
 *   opts.minObservations  min total answers before we trust a fit (default 8)
 *   opts.gridSteps        grid resolution per parameter per pass (default 6)
 *   opts.refinePasses     coarse-to-fine passes (default 4)
 * @returns {{params, fitted, logLikelihood, observations, baselineLogLikelihood, reason?}}
 */
function fitParameters(sequences, opts = {}) {
  const minObservations = opts.minObservations ?? 8;
  const gridSteps = opts.gridSteps ?? 6;
  const refinePasses = opts.refinePasses ?? 4;

  const observations = sequences.reduce((n, s) => n + s.length, 0);
  const baselineLogLikelihood = totalLogLikelihood(sequences, DEFAULT_PARAMS);

  if (observations < minObservations) {
    return {
      params: { ...DEFAULT_PARAMS },
      fitted: false,
      reason: `only ${observations} observations (need ${minObservations})`,
      logLikelihood: baselineLogLikelihood,
      baselineLogLikelihood,
      observations,
    };
  }

  // Start from the full identifiable range for each parameter.
  const ranges = {
    pInit: [...BOUNDS.pInit],
    pLearn: [...BOUNDS.pLearn],
    pSlip: [...BOUNDS.pSlip],
    pGuess: [...BOUNDS.pGuess],
  };

  let best = { ...DEFAULT_PARAMS };
  let bestLL = baselineLogLikelihood;

  for (let pass = 0; pass < refinePasses; pass++) {
    const grid = {};
    for (const k of Object.keys(ranges)) {
      grid[k] = linspace(ranges[k][0], ranges[k][1], gridSteps);
    }
    for (const pInit of grid.pInit) {
      for (const pLearn of grid.pLearn) {
        for (const pSlip of grid.pSlip) {
          for (const pGuess of grid.pGuess) {
            const cand = { pInit, pLearn, pSlip, pGuess };
            const ll = totalLogLikelihood(sequences, cand);
            if (ll > bestLL) {
              bestLL = ll;
              best = cand;
            }
          }
        }
      }
    }
    // Narrow each range to a window around the current best for the next pass.
    for (const k of Object.keys(ranges)) {
      const span = (ranges[k][1] - ranges[k][0]) / gridSteps;
      ranges[k] = [clampToBounds(best[k] - span, k), clampToBounds(best[k] + span, k)];
    }
  }

  return {
    params: best,
    fitted: true,
    logLikelihood: bestLL,
    baselineLogLikelihood,
    observations,
  };
}

/**
 * Pull answer sequences out of a live MasteryModel (from bkt.js).
 * Returns per-concept sequences plus a pooled list (all concepts together),
 * which is what you fit on when any single concept is too sparse.
 * @param {object} masteryModel  instance of MasteryModel
 */
function sequencesFromModel(masteryModel) {
  const perConcept = {};
  const pooled = [];
  for (const c of masteryModel.concepts) {
    const tracer = masteryModel.tracers[c.id];
    const seq = tracer.history.map((h) => h.correct);
    perConcept[c.id] = seq;
    if (seq.length) pooled.push(seq);
  }
  return { perConcept, pooled };
}

/**
 * Convenience: fit parameters directly from a MasteryModel by pooling answers
 * across all concepts (the realistic single-student case, where per-concept
 * data is too thin to fit on its own).
 */
function fitModel(masteryModel, opts = {}) {
  const { pooled } = sequencesFromModel(masteryModel);
  return fitParameters(pooled, opts);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DEFAULT_PARAMS,
    BOUNDS,
    seqLogLikelihood,
    totalLogLikelihood,
    fitParameters,
    sequencesFromModel,
    fitModel,
  };
}
