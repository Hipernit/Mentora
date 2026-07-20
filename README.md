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

To use your own material, pick a provider and paste an API key into the key field — it's stored only in your browser's `localStorage`, never sent anywhere but that provider's API. Gemini is the default (free tier, no card, no expiration); Claude, DeepSeek, and GitHub Models are also supported as fallbacks if a free tier's rate limit gets hit mid-lesson.

## Pages

- `index.html` — the live lesson: paste material (or try the demo), get quizzed, watch mastery update
- `how-it-works.html` — an interactive BKT simulator explaining how the model works
- `teacher.html` — a classroom rollup: simulates a class of synthetic students through the same model to show a mastery heatmap
- `eval.html` — an evaluation harness that measures how much faster/more reliably adaptive ordering converges than random-order quizzing

## Architecture

```
index.html, how-it-works.html, teacher.html, eval.html  — the four pages above
style.css, explainer.css, teacher.css, eval.css          — per-page styling

bkt.js        — Bayesian Knowledge Tracing engine (pure logic, no DOM)
bktFit.js     — fits BKT parameters to a student's actual answers by maximum likelihood
spaced.js     — spaced-repetition scheduling (retention decay, due dates)
demo-data.js  — the bundled photosynthesis demo lesson + BKT tuning defaults,
                shared by app.js/eval.js/teacher.js so their three "simulations"
                of the same lesson can't drift out of sync with each other

providers.js  — multi-provider LLM API layer (Claude/Gemini/DeepSeek/GitHub
                Models), state-free like bkt.js — takes provider/key/prompt as
                plain arguments, returns text or throws
persist.js    — full-session persistence to localStorage (resume mid-lesson)
app.js        — UI orchestration + state for the live lesson (index.html)

eval.js       — drives eval.html's simulated evaluation harness
teacher.js    — drives teacher.html's classroom simulator
explainer.js  — drives how-it-works.html's interactive BKT simulator
```

`bkt.js`, `bktFit.js`, `spaced.js`, `demo-data.js`, and `providers.js` have zero dependency on the DOM — each is a standalone module that could be reused outside the browser. `app.js`, `eval.js`, `teacher.js`, and `explainer.js` are the only files that touch the page (and `providers.js`, only via `app.js`, ever touches the network).
