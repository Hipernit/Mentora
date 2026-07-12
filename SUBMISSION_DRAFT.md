# Devpost Submission Draft — Mentora

*(Fill in bracketed items before submitting: team name, repo URL, video URL.)*

## Project name
Mentora — Adaptive AI Learning Companion

## Elevator pitch (one line)
Mentora turns any study material into an adaptive lesson that actually knows what you understand — using a real Bayesian probability model, not guesswork, to decide what to teach you next.

## Inspiration
Every student has said "I get it" right before bombing the quiz. Most AI tutoring tools are just chatbots — they generate explanations but have no real model of whether the explanation worked. We wanted to build something closer to how real intelligent tutoring systems (like the ones used in university CS and math courses) work: pair a generative AI with an actual statistical model of student knowledge, so the system can tell the difference between "explained it" and "the student learned it."

## What it does
1. You paste any study material — class notes, a textbook excerpt, an article.
2. Claude extracts a dependency-ordered concept graph (e.g., you must understand light-dependent reactions before the Calvin cycle).
3. Claude generates quiz questions per concept.
4. As you answer, a Bayesian Knowledge Tracing engine updates a live probability that you've mastered each concept — accounting for the chance you guessed right or slipped on something you know.
5. Get something wrong, and Mentora identifies your actual weak point and asks Claude to re-explain it through an analogy you choose (cooking, sports, gaming, or music) — targeted remediation, not a repeated definition.
6. Once your mastery probability crosses threshold on a concept, and only once its prerequisites are also mastered, Mentora unlocks the next concept.

## How we built it
- **Frontend:** vanilla HTML/CSS/JS — zero framework overhead, deployable as a static site with zero backend.
- **AI/ML core (`bkt.js`):** a Bayesian Knowledge Tracing implementation (Corbett & Anderson, 1994) — a probabilistic latent-variable model with four parameters (prior knowledge, learning rate, slip rate, guess rate) that performs a proper Bayesian posterior update after every observed answer. Fully unit tested (9 passing tests covering mastery bounds, prerequisite gating, and edge cases).
- **Generative layer (`app.js`):** calls the Claude API for three tasks — concept extraction, quiz generation, and on-demand analogy-based re-explanation — each driven by what the mastery model determines the student needs next.
- **Demo mode:** a bundled offline lesson (photosynthesis) so the whole adaptive loop can be demoed instantly with no API key, no network dependency, and no risk of a live demo failing during judging.

## Challenges we ran into
- Balancing "AI does the creative generation" against "the system, not the LLM, decides pedagogy" — we deliberately kept the BKT engine in pure, dependency-free JS so it's the sole source of truth for what the student sees next, and Claude is only ever called to *generate content for* a decision the model already made.
- Getting reliable structured JSON out of the LLM for concept graphs and quizzes required tight prompt constraints and a JSON-extraction fallback.
- Prerequisite-aware recommendation (`recommendNext()`) needed to avoid recommending a concept whose dependencies aren't mastered yet, which meant treating the concept list as a lightweight dependency graph rather than a flat list.

## Accomplishments we're proud of
- A real, citable, testable ML technique (BKT) driving a hackathon education project, not just an LLM wrapper.
- The full adaptive loop — generate, quiz, trace mastery, remediate, gate progression — working end-to-end in a framework-free static app.
- A demo mode that makes the project fully judge-able offline in under 10 seconds.

## What we learned
How to couple a classical probabilistic ML model with a modern LLM so each does what it's actually good at: the LLM generates open-ended content, the statistical model makes the deterministic, explainable pedagogical decisions.

## What's next for Mentora
- Multi-student classroom dashboard for teachers to see mastery heatmaps across a whole class.
- Spaced-repetition scheduling layered on top of BKT mastery estimates.
- Support for image/PDF upload (diagrams, textbook photos) as source material.
- Parameter learning: fit `pSlip`/`pGuess`/`pLearn` per student from real answer history instead of using fixed defaults.

## Built with
`javascript`, `html5`, `css3`, `claude-api`, `anthropic`, `bayesian-knowledge-tracing`, `machine-learning`, `education`

## Team
[Your name / team members]

## Links
- GitHub: [repo URL]
- Live demo: [deployed URL, e.g. GitHub Pages]
- Video: [YouTube/Vimeo unlisted link]
