/**
 * spaced.test.js — sanity tests for the spaced-repetition scheduling module.
 * Run with: node spaced.test.js
 */
const Spaced = require("./spaced.js");
const { retention, reviewIntervalMs, nextDueMs, isDue, REVIEW_INTERVALS_MS } = Spaced;

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  ok -", msg); }
  else { failed++; console.error("  FAIL:", msg); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }

// 1. retention(0, n) === 1 — no time elapsed means no forgetting yet, for every
// review-count bucket (including negative/zero edge inputs, which clamp to bucket 0).
for (const n of [1, 2, 3, 4, 5, 6, 0, -1]) {
  assert(retention(0, n) === 1, `retention(0, reviewCount=${n}) === 1`);
}

// 2. retention at exactly the review interval for a given reviewCount decays to ~50%
// — stabilityMs is chosen specifically so this holds (R = exp(-interval/stability),
// stability = interval/ln2 => R = exp(-ln2) = 0.5).
for (let n = 1; n <= REVIEW_INTERVALS_MS.length; n++) {
  const interval = reviewIntervalMs(n);
  const r = retention(interval, n);
  assert(approx(r, 0.5, 1e-9), `retention at exactly reviewIntervalMs(${n}) is ~0.5 (got ${r})`);
}

// 3. retention is monotonically decreasing as elapsed time increases, for a fixed
// reviewCount — forgetting never reverses with more elapsed time.
{
  const n = 2;
  const samples = [0, 1000, 60_000, 3_600_000, 86_400_000, 10 * 86_400_000, 100 * 86_400_000];
  let prev = Infinity;
  let monotone = true;
  for (const ms of samples) {
    const r = retention(ms, n);
    if (r > prev + 1e-12) monotone = false;
    prev = r;
  }
  assert(monotone, "retention is monotonically non-increasing as elapsed time grows");
}

// 4. reviewIntervalMs is non-decreasing in reviewCount — each successful review
// should never shrink the next interval, and here it strictly expands through the
// defined ladder before flattening out at the max bucket.
{
  let prev = 0;
  let nonDecreasing = true;
  for (let n = 1; n <= REVIEW_INTERVALS_MS.length + 3; n++) {
    const interval = reviewIntervalMs(n);
    if (interval < prev) nonDecreasing = false;
    prev = interval;
  }
  assert(nonDecreasing, "reviewIntervalMs(reviewCount) is non-decreasing in reviewCount");
  // Also confirm it plateaus at the last defined interval once reviewCount exceeds
  // the ladder length, rather than throwing or going out of bounds.
  const last = REVIEW_INTERVALS_MS[REVIEW_INTERVALS_MS.length - 1];
  assert(reviewIntervalMs(REVIEW_INTERVALS_MS.length + 5) === last, "reviewIntervalMs plateaus at the longest defined interval past the ladder's length");
}

// 5. isDue becomes true once enough time has elapsed that retention drops to/below
// the due threshold (default 0.7), and is false right after a review.
{
  const reviewCount = 2;
  const lastReviewed = 0;
  assert(isDue(lastReviewed, lastReviewed, reviewCount) === false, "isDue is false immediately after review (elapsed = 0)");

  // Find the elapsed time at which retention crosses 0.7 analytically:
  // R = exp(-elapsed/stability) <= 0.7  =>  elapsed >= -stability * ln(0.7)
  const stability = Spaced.stabilityMs(reviewCount);
  const crossingMs = -stability * Math.log(0.7);

  const justBefore = Math.floor(crossingMs * 0.9);
  const justAfter = Math.ceil(crossingMs * 1.1);

  assert(isDue(lastReviewed + justBefore, lastReviewed, reviewCount) === false, "isDue is false shortly before the retention crosses the due threshold");
  assert(isDue(lastReviewed + justAfter, lastReviewed, reviewCount) === true, "isDue is true once elapsed time pushes retention at/below the due threshold");
}

// 6. nextDueMs is simply lastReviewed + reviewIntervalMs(reviewCount) — sanity check
// the two pieces compose the way isDue/renderReviewPanel assume they do.
{
  const lastReviewed = 1_000_000;
  const reviewCount = 3;
  assert(nextDueMs(lastReviewed, reviewCount) === lastReviewed + reviewIntervalMs(reviewCount), "nextDueMs === lastReviewed + reviewIntervalMs(reviewCount)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
