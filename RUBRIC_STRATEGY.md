# Mentora — Rubric Strategy (Prometheus July AI Challenge)

Hackathon: **Prometheus July AI Challenge** (Devpost), Jul 17–30, 2026. Prompt: build an educational AI/ML tool. Judged 25/25/25/25 across four categories. Below is exactly how Mentora is built to hit each one, and what to emphasize in the submission and video.

## 1. Educational Impact (25 pts)

**Judge question:** does it genuinely help people learn, teach, or understand a concept better?

Mentora's core claim: most "AI tutors" just chat with the student and hope something sticks. Mentora instead *measures* whether the student actually understood something, and only advances once they have — the same principle behind real intelligent tutoring systems used in schools (Carnegie Learning, ALEKS).

What to say / show:
- The dependency-aware concept graph means Mentora never lets a student "master" the Calvin cycle while still shaky on the light-dependent reactions it depends on — it enforces real prerequisite learning order.
- The analogy re-explanation (cooking/sports/gaming/music) is triggered specifically by a wrong answer on a specific concept, not generic — this is remediation, not just content delivery.
- Works on **any** input material (paste your own class notes), so it's not a fixed-content demo — it generalizes to any subject a student is struggling with.
- Frame the pitch around a real pain point: students don't know what they don't know, and self-reported "I get it" is unreliable. Mentora replaces self-report with an evidence-based probability.

## 2. Creative Use of AI/ML (25 pts)

**Judge question:** is AI core to functionality, not an afterthought? Is it clever/meaningful?

This is the category most hackathon education projects lose points on, because "wrap ChatGPT in a UI" reads as an afterthought. Mentora's differentiator: **it pairs an LLM with a genuine statistical ML model.**

- `bkt.js` implements **Bayesian Knowledge Tracing** (Corbett & Anderson, 1994) — a real probabilistic latent-variable model with four learned/tunable parameters (`pInit`, `pLearn`, `pSlip`, `pGuess`) and a proper Bayesian posterior update. This is a legitimate, citable ML technique used in production tutoring systems, not a scoring gimmick. It's fully unit-tested (`bkt.test.js`, 9/9 passing).
- Claude is used for three *distinct* generative tasks, each feeding the ML model rather than replacing it: concept-graph extraction, adaptive quiz generation, and on-demand personalized analogy generation targeted at the student's demonstrated weak point (chosen by the BKT model's `recommendNext()`, not by the student).
- The two systems are genuinely coupled: BKT's output (which concept is weakest, whether prerequisites are met) drives what Claude is asked to generate next. Removing either half breaks the product — that's the bar for "AI core to functionality."

When judges ask technical questions, be ready to explain the Bayes update formula in `bkt.js` — that's your strongest differentiation moment.

## 3. Technical Execution (25 pts)

**Judge question:** functional, stable, intuitive, quality codebase/UI/UX?

- Clean separation of concerns: `bkt.js` (pure ML logic, zero DOM dependencies, unit-testable in Node) vs `app.js` (UI + API orchestration) vs `index.html`/`style.css` (presentation). This is the kind of separation judges look for when they open the repo.
- Runs with **zero backend** — static HTML/CSS/JS, deployable to GitHub Pages / Vercel / Netlify in one click, which matters for a judge who wants to try it live without spinning up a server.
- **Demo Mode**: works instantly with zero API key and zero network dependency (bundled photosynthesis lesson), so judging never fails due to rate limits, cost, or a missing key — a common way hackathon demos die mid-judging.
- Defensive coding: API errors surface as visible status messages, not silent failures; BKT constructor validates parameters; mastery is clamped to `[0,1]`.
- UI: live mastery dashboard (color-coded bars), concept dependency graph, single clear CTA per screen (no clutter) — built for a judge to understand instantly without narration.

Before submitting: deploy it live (GitHub Pages is fastest), add a README with setup + architecture diagram, and make sure the demo-mode path is the one you show first in case wifi is unreliable during judging.

## 4. The Pitch & Demo (25 pts)

**Judge question:** clear, concise, engaging 2-minute video; explains the "why" and "how"?

Structure (see `PITCH_SCRIPT.md` for full script):
1. **Hook (0:00–0:15)** — the real problem: students say "I get it" and are wrong, and generic AI tutors can't tell the difference.
2. **Live demo (0:15–1:30)** — paste material → concept graph appears → answer a question wrong → watch mastery bar move → analogy re-explanation appears → answer correctly → mastery crosses threshold → next concept auto-recommended.
3. **The "how" (1:30–1:50)** — 10 seconds on Bayesian Knowledge Tracing, framed simply: "under the hood, a real probabilistic model — not just a chat log — tracks the actual likelihood you've learned each concept."
4. **Close (1:50–2:00)** — impact statement + what's next (multi-student classroom dashboard, spaced repetition scheduling).

Keep energy up, screen-record at 1080p, caption the BKT formula on-screen for 3 seconds during the "how" section — judges skim video and a visible equation signals technical depth fast.

## Time Budget (today is Jul 11; hackathon runs Jul 17–30)

- Before Jul 17: rehearse the demo, deploy the static site, get a Claude API key with a small budget cap, record a backup demo-mode video in case live API fails.
- Jul 17–20: polish UI, add 2–3 more subject-area demo datasets (e.g. history, algebra) so the video isn't limited to photosynthesis.
- Jul 21–27: build lightweight teacher/classroom view if time allows (stretch goal, strengthens Educational Impact further).
- Jul 28–29: record and edit the 2-minute video, write final Devpost submission text.
- Jul 30: submit early, not at the deadline — Devpost has had last-minute upload failures in past hackathons.
