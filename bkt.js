/**
 * bkt.js — Bayesian Knowledge Tracing engine
 *
 * This is the "real machine learning" core of Mentora: a probabilistic latent-variable
 * model of student knowledge (Corbett & Anderson, 1994), used in real intelligent
 * tutoring systems (e.g. Carnegie Learning). It is NOT an LLM call — it's a small,
 * transparent, testable statistical model that turns a stream of right/wrong answers
 * into a calibrated probability that the student has actually mastered a concept.
 *
 * Parameters (per concept, can be tuned or learned from data):
 *   pInit  (P(L0))  — prior probability the student already knows the concept
 *   pLearn (P(T))   — probability of transitioning from "not known" to "known"
 *                      after one learning opportunity (e.g. an explanation)
 *   pSlip  (P(S))   — probability of answering incorrectly despite knowing it
 *   pGuess (P(G))   — probability of answering correctly despite not knowing it
 *
 * Update on an observation (Bayes' rule):
 *
 *   if correct:
 *     P(L_t | correct)   = P(L_t) * (1 - pSlip) / [ P(L_t)*(1-pSlip) + (1-P(L_t))*pGuess ]
 *   if incorrect:
 *     P(L_t | incorrect) = P(L_t) * pSlip       / [ P(L_t)*pSlip + (1-P(L_t))*(1-pGuess) ]
 *
 * Then, ONLY on a correct answer, apply the learning transition on top of the
 * evidence update:
 *
 *   P(L_t+1) = P(L_t | correct) + (1 - P(L_t | correct)) * pLearn
 *
 * Why gate the transition on correctness: classic BKT applies pLearn after
 * every observation regardless of right/wrong, reasoning that any attempt is
 * a "learning opportunity." In practice, with a non-trivial pLearn, that
 * unconditional bump swamps the evidence step — a wrong answer can *still*
 * end up net-increasing mastery, which looks broken in a live demo (mastery
 * should visibly drop when you get something wrong). Gating pLearn to only
 * fire on correct answers keeps wrong answers honest: they show the real
 * Bayesian evidence-based drop, with no artificial floor pulling it back up.
 */

class ConceptTracer {
  constructor({ pInit = 0.3, pLearn = 0.25, pSlip = 0.1, pGuess = 0.2 } = {}) {
    if (pSlip >= 1 || pGuess >= 1) {
      throw new Error("pSlip and pGuess must be < 1 to avoid divide-by-zero in Bayes update");
    }
    this.pInit = pInit;
    this.pLearn = pLearn;
    this.pSlip = pSlip;
    this.pGuess = pGuess;
    this.mastery = pInit; // P(L_t)
    this.history = []; // [{correct, masteryBefore, masteryAfter}]
  }

  /**
   * Feed one observed answer and return updated mastery probability.
   *
   * @param {boolean} correct
   * @param {boolean|null} [confident] Optional self-reported confidence ("sure"
   *   vs "unsure"). Omitted/null (the default) reproduces the exact original
   *   BKT update below — this parameter is purely additive.
   *
   * Confidence-weighting rationale: pSlip/pGuess are fixed per-concept
   * constants, but a single student answer carries more information than just
   * right/wrong when they also say how sure they were. Rather than changing
   * the BKT recursion itself, confidence locally re-weights which explanation
   * (know-it vs. guessed-it, slipped vs. genuinely-doesn't-know) is more
   * plausible for THIS observation, by scaling the effective pGuess/pSlip
   * used in that single update:
   *   - correct & confident   -> lower effective pGuess  -> more credit (guessing is a less likely explanation)
   *   - correct & unsure      -> higher effective pGuess -> less credit (looks more like a lucky guess)
   *   - incorrect & confident -> lower effective pSlip   -> bigger penalty (looks like a real misconception, not a slip)
   *   - incorrect & unsure    -> higher effective pSlip  -> smaller penalty (an unsure guess going wrong is the expected case)
   * Only the parameter relevant to the observed outcome is touched (pGuess on
   * correct answers, pSlip on incorrect ones) — the other stays at its base
   * value, exactly as in the unweighted formula. The learning transition
   * (pLearn) is untouched by confidence and still gates on correctness only,
   * so the "a wrong answer can never net-increase mastery" invariant holds
   * regardless of confidence.
   */
  observe(correct, confident = null) {
    const L = this.mastery;
    const hasConfidence = confident === true || confident === false;
    const CONFIDENCE_STRENGTH = 0.5; // how hard sure/unsure discounts or amplifies the assumed slip/guess rate
    let posterior;
    if (correct) {
      const effGuess = !hasConfidence
        ? this.pGuess
        : confident
          ? this.pGuess * (1 - CONFIDENCE_STRENGTH)
          : Math.min(0.49, this.pGuess * (1 + CONFIDENCE_STRENGTH));
      const num = L * (1 - this.pSlip);
      const den = num + (1 - L) * effGuess;
      posterior = den === 0 ? L : num / den;
    } else {
      const effSlip = !hasConfidence
        ? this.pSlip
        : confident
          ? Math.max(0.01, this.pSlip * (1 - CONFIDENCE_STRENGTH))
          : Math.min(0.49, this.pSlip * (1 + CONFIDENCE_STRENGTH));
      const num = L * effSlip;
      const den = num + (1 - L) * (1 - this.pGuess);
      posterior = den === 0 ? L : num / den;
    }
    // Learning transition only applies after a correct answer — see note above.
    const updated = correct ? posterior + (1 - posterior) * this.pLearn : posterior;
    this.history.push({ correct, confident: hasConfidence ? confident : null, masteryBefore: L, masteryAfter: updated });
    this.mastery = clamp01(updated);
    return this.mastery;
  }

  /** Has the student crossed the "mastered" threshold? */
  isMastered(threshold = 0.9) {
    return this.mastery >= threshold;
  }

  reset() {
    this.mastery = this.pInit;
    this.history = [];
  }
}

/** Tracks mastery across a whole concept graph and decides what to teach next. */
class MasteryModel {
  constructor(concepts, bktParams = {}) {
    // concepts: [{ id, label, dependsOn: [id,...] }]
    this.concepts = concepts;
    this.tracers = {};
    concepts.forEach((c) => {
      this.tracers[c.id] = new ConceptTracer(bktParams);
    });
  }

  recordAnswer(conceptId, correct, confident = null) {
    if (!this.tracers[conceptId]) throw new Error(`Unknown concept: ${conceptId}`);
    return this.tracers[conceptId].observe(correct, confident);
  }

  getMastery(conceptId) {
    return this.tracers[conceptId]?.mastery ?? null;
  }

  snapshot() {
    return this.concepts.map((c) => ({
      id: c.id,
      label: c.label,
      mastery: this.tracers[c.id].mastery,
      mastered: this.tracers[c.id].isMastered(),
      attempts: this.tracers[c.id].history.length,
    }));
  }

  /**
   * Adaptive next-step recommendation: pick the lowest-mastery concept whose
   * prerequisites (dependsOn) are already mastered — a topological-sort-aware
   * weakest-link strategy, so we never recommend reviewing something the
   * student can't understand yet for lack of foundation.
   */
  recommendNext(threshold = 0.9) {
    const ready = this.concepts.filter((c) => {
      if (this.tracers[c.id].isMastered(threshold)) return false;
      const deps = c.dependsOn || [];
      return deps.every((d) => this.tracers[d]?.isMastered(threshold));
    });
    if (ready.length === 0) return null;
    ready.sort((a, b) => this.tracers[a.id].mastery - this.tracers[b.id].mastery);
    return ready[0];
  }

  overallMastery() {
    const vals = this.concepts.map((c) => this.tracers[c.id].mastery);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { ConceptTracer, MasteryModel };
}
