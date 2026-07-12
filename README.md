# Mentora

Adaptive AI learning companion built for the **Prometheus July AI Challenge** (Jul 17–30, 2026).

Paste any study material and Mentora builds a concept-dependency graph, quizzes you, and tracks your real mastery of each concept using a **Bayesian Knowledge Tracing** model — then adapts what you see next based on evidence, not self-report.

## Quick start

No build step. Just open `index.html` in a browser, or serve it locally:

```bash
cd mentora
python3 -m http.server 8000
# open http://localhost:8000
```

Click **"Try Demo"** to run the full adaptive-learning loop instantly with a bundled photosynthesis lesson — no API key required.

To use your own material, paste a Claude API key (get one at console.anthropic.com) into the key field — it's stored only in your browser's `localStorage`, never sent anywhere but Anthropic's API.

## Architecture

```
index.html   — UI shell
style.css    — styling
bkt.js       — Bayesian Knowledge Tracing engine (pure logic, no DOM, unit-tested)
app.js       — Claude API calls + UI orchestration + demo dataset
bkt.test.js  — unit tests for bkt.js (run: node bkt.test.js)
```

`bkt.js` has zero dependency on the DOM or Claude — it's a standalone, reusable mastery-tracking library. `app.js` is the only file that touches the network or the page.

## Run tests

```bash
node bkt.test.js
```

## Files in this submission

- `RUBRIC_STRATEGY.md` — how each feature maps to the hackathon's 4 judging categories
- `PITCH_SCRIPT.md` — full 2-minute demo video script + shot list
- `SUBMISSION_DRAFT.md` — Devpost submission text, ready to paste in
