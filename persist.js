/**
 * persist.js — full-session persistence to localStorage.
 *
 * Lets a student close the tab mid-lesson and resume exactly where they
 * left off (concepts, quizzes, material, calibration log, spaced-repetition
 * schedule, and per-concept BKT answer histories). Pulled out of app.js as
 * its own concern; unlike providers.js this still operates on app.js's
 * session state shape directly (it's inherently about *that* state), but
 * takes it as an explicit `state` argument rather than reaching into a
 * global, so what it reads/writes is visible at the call site.
 *
 * Exposed as a `Session` namespace (same pattern as `LLM` in providers.js):
 * Session.save(state), Session.load(state), Session.clear().
 */

const Session = (() => {
  const SAVE_KEY = "mentora_session_v1";

  /**
   * Serializes the whole lesson to localStorage. Only the raw `correct`
   * booleans are saved per concept — masteryBefore/masteryAfter are
   * recomputed on replay (see load()), since ConceptTracer.observe() is
   * deterministic.
   */
  function save(state) {
    if (!state.model) return;
    const params = state.lastFit?.params || BKT_PARAMS;
    const histories = {};
    state.concepts.forEach((c) => {
      histories[c.id] = (state.model.tracers[c.id]?.history || []).map((h) => h.correct);
    });
    const payload = {
      concepts: state.concepts,
      quizzes: state.quizzes,
      misconceptions: state.misconceptions,
      material: state.material,
      demoMode: state.demoMode,
      calibration: state.calibration,
      schedule: state.schedule,
      clockOffset: state.clockOffset,
      params,
      histories,
    };
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
    } catch (err) {
      console.error("Session.save failed", err);
    }
  }

  /**
   * Rebuilds `state` in place from a saved session: reconstructs the
   * MasteryModel with the saved (learned) BKT params, then replays each
   * concept's saved answer history through recordAnswer so mastery,
   * history, and everything derived from it end up bit-for-bit identical
   * to where the student left off. Returns false (and leaves state
   * untouched) if there's no valid save.
   */
  function load(state) {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.error("Session.load: corrupt saved session", err);
      return false;
    }
    if (!data || !Array.isArray(data.concepts) || !data.concepts.length) return false;

    state.concepts = data.concepts;
    state.quizzes = data.quizzes || {};
    state.misconceptions = data.misconceptions || {};
    state.material = data.material || "";
    state.demoMode = !!data.demoMode;
    state.calibration = data.calibration || [];
    state.schedule = data.schedule || {};
    state.clockOffset = data.clockOffset || 0;
    state.reviewMode = false;
    state.reviewQueue = [];

    const params = data.params || BKT_PARAMS;
    state.model = new MasteryModel(state.concepts, params);
    state.concepts.forEach((c) => {
      (data.histories?.[c.id] || []).forEach((correct) => state.model.recordAnswer(c.id, correct));
    });
    // Let advanceToRecommended's learnAndApply() re-derive lastFit/paramReadout
    // from the replayed history rather than guessing at a stale observation count.

    return true;
  }

  /** Clears the saved session (fresh material, or explicit "start over"). */
  function clear() {
    localStorage.removeItem(SAVE_KEY);
  }

  /** Whether a resumable session exists — used to show/hide the "Resume" button. */
  function exists() {
    return !!localStorage.getItem(SAVE_KEY);
  }

  return { save, load, clear, exists };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = Session;
} else if (typeof window !== "undefined") {
  window.Session = Session;
}
