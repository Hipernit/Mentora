/**
 * spaced.js — spaced-repetition scheduling layered on top of BKT mastery.
 *
 * Pure functions, no DOM, no network. BKT tells us whether a concept is
 * currently mastered; this module decides WHEN it should come back for review,
 * and models forgetting so long-unreviewed concepts resurface. Two classic
 * ideas: an expanding (Leitner-style) review interval that grows each time a
 * concept is successfully reviewed, and an Ebbinghaus exponential forgetting
 * curve for estimating current retention between reviews.
 */

// Interval before a concept is "due" again, indexed by how many times it has
// been successfully reviewed. Expands with each successful review.
const REVIEW_INTERVALS_MS = [
  1 * 24 * 60 * 60 * 1000, //  1 day  (after first mastery)
  3 * 24 * 60 * 60 * 1000, //  3 days
  7 * 24 * 60 * 60 * 1000, //  1 week
  16 * 24 * 60 * 60 * 1000, // ~2 weeks
  35 * 24 * 60 * 60 * 1000, // ~5 weeks
];

function reviewIntervalMs(reviewCount) {
  const i = Math.max(0, Math.min((reviewCount || 1) - 1, REVIEW_INTERVALS_MS.length - 1));
  return REVIEW_INTERVALS_MS[i];
}

// Memory "stability" (the time constant of forgetting), chosen so retention
// decays to ~50% exactly at the review interval — a standard spacing target.
function stabilityMs(reviewCount) {
  return reviewIntervalMs(reviewCount) / Math.LN2;
}

// Ebbinghaus forgetting curve: R = exp(-elapsed / stability), in [0, 1].
function retention(elapsedMs, reviewCount) {
  if (elapsedMs <= 0) return 1;
  return Math.exp(-elapsedMs / stabilityMs(reviewCount));
}

function nextDueMs(lastReviewed, reviewCount) {
  return lastReviewed + reviewIntervalMs(reviewCount);
}

// Due when estimated retention has fallen to/below dueRetention (default 70%).
function isDue(now, lastReviewed, reviewCount, dueRetention = 0.7) {
  return retention(now - lastReviewed, reviewCount) <= dueRetention;
}

const Spaced = { REVIEW_INTERVALS_MS, reviewIntervalMs, stabilityMs, retention, nextDueMs, isDue };

if (typeof module !== "undefined" && module.exports) {
  module.exports = Spaced;
} else if (typeof window !== "undefined") {
  window.Spaced = Spaced;
}
