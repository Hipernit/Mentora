/**
 * app.js — Mentora application logic
 *
 * Flow:
 *  1. Student pastes/uploads study material (notes, textbook excerpt, article).
 *  2. Claude extracts a concept dependency graph (5-8 concepts) from the material.
 *  3. Claude generates 3 multiple-choice questions per concept.
 *  4. As the student answers, the BKT engine (bkt.js) updates a live mastery
 *     probability per concept — this is real ML, not a score tally.
 *  5. Mentora recommends the next concept to study (weakest concept whose
 *     prerequisites are already mastered) and, on request, asks Claude to
 *     re-explain that concept using an analogy domain the student chooses
 *     (sports / cooking / gaming / music) — personalization driven by the
 *     mastery model's actual weak point, not a generic "explain again".
 *
 * No API key? Mentora falls back to a bundled demo dataset (DEMO_MODE) so the
 * whole adaptive-learning loop is still fully demoable offline.
 */

// Mastery bar: raised from the textbook-BKT-demo default of 0.85 so a
// concept can't be "mastered" off one or two lucky answers. See the BKT
// params on the MasteryModel construction in generateCourse() for the other
// half of this tuning (slower pLearn, more skeptical pGuess/pSlip).
const MASTERY_THRESHOLD = 0.9;
// Quiz pool per concept is 3 questions (see generateQuiz), but questions
// cycle via modulo once exhausted — raised from 3 so the harder threshold
// is still reachable within a lesson instead of force-advancing a student
// who hasn't actually crossed it yet.
const MAX_ATTEMPTS_PER_CONCEPT = 5;

// Starting BKT parameters, used until the fitter has enough of THIS student's
// answers to learn better ones (see learnAndApply). One source of truth so the
// live model and the "default vs learned" readout never drift apart.
const DEFAULT_BKT = { pInit: 0.2, pLearn: 0.22, pSlip: 0.08, pGuess: 0.25 };

// localStorage key for full-session persistence (Feature 3) — lets a student
// close the tab mid-lesson and resume exactly where they left off, including
// mastery history, learned BKT params, and the spaced-repetition schedule.
const SAVE_KEY = "mentora_session_v1";

const PROVIDERS = {
  gemini: {
    label: "Gemini",
    keyLabel: "Gemini API key (stored only in your browser) — get one free at aistudio.google.com/apikey",
    placeholder: "paste your Gemini API key",
  },
  claude: {
    label: "Claude",
    keyLabel: "Claude API key (stored only in your browser) — console.anthropic.com",
    placeholder: "sk-ant-...",
  },
  deepseek: {
    label: "DeepSeek",
    keyLabel: "DeepSeek API key (stored only in your browser) — platform.deepseek.com/api_keys",
    placeholder: "sk-...",
  },
  github: {
    label: "GitHub Models",
    keyLabel: "GitHub personal access token with 'models: read' scope (stored only in your browser) — github.com/settings/tokens",
    placeholder: "ghp_... or github_pat_...",
  },
};

const state = {
  provider: localStorage.getItem("mentora_provider") || "gemini",
  concepts: [],
  quizzes: {}, // conceptId -> [{q, choices: [{text, correct, misconceptionId}]}]
  misconceptions: {}, // conceptId -> [{id, label}] fixed taxonomy, so tags aggregate across questions
  model: null, // MasteryModel instance
  currentConcept: null,
  currentQuestionIdx: 0,
  demoMode: false,
};

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  cacheEls();
  bindEvents();
  els.providerSelect.value = state.provider;
  syncProviderUI();

  if (els.resumeSessionBtn && localStorage.getItem(SAVE_KEY)) {
    els.resumeSessionBtn.classList.remove("hidden");
    els.resumeSessionBtn.addEventListener("click", () => {
      if (!loadSession()) return;
      els.setupView.classList.add("hidden");
      els.learnView.classList.remove("hidden");
      els.headerProgress.classList.remove("hidden");
      renderGraph();
      renderDashboard();
      renderCalibration();
      updateSchedule();
      renderReviewPanel();
      advanceToRecommended();
    });
  }
});

function cacheEls() {
  [
    "providerSelect", "apiKeyLabel", "apiKeyInput", "saveKeyBtn", "keyHint", "materialInput", "generateBtn", "statusMsg",
    "setupView", "learnView", "conceptGraph", "quizPanel", "dashboard",
    "recommendation", "analogyPanel", "analogyChoices", "analogyResult",
    "paramReadout", "calibrationPanel", "reviewPanel",
    "demoBtn", "resumeSessionBtn",
    "headerProgress", "overallProgressFill", "overallProgressPct",
    "loadingOverlay", "loadingText",
  ].forEach((id) => (els[id] = document.getElementById(id)));
}

function bindEvents() {
  els.providerSelect.addEventListener("change", () => {
    state.provider = els.providerSelect.value;
    localStorage.setItem("mentora_provider", state.provider);
    syncProviderUI();
  });
  els.saveKeyBtn.addEventListener("click", () => {
    const key = els.apiKeyInput.value.trim();
    localStorage.setItem(`mentora_api_key_${state.provider}`, key);
    setStatus(`${PROVIDERS[state.provider].label} API key saved locally in your browser.`);
  });
  els.generateBtn.addEventListener("click", () => generateCourse(false));
  els.demoBtn.addEventListener("click", () => generateCourse(true));
  // Restart is only offered from the completion banner once the lesson is
  // fully mastered (see advanceToRecommended) — there's no general-purpose
  // "start over" button cluttering the UI mid-lesson.
}

function syncProviderUI() {
  const p = PROVIDERS[state.provider];
  els.apiKeyLabel.textContent = p.keyLabel;
  els.apiKeyInput.placeholder = p.placeholder;
  els.apiKeyInput.value = localStorage.getItem(`mentora_api_key_${state.provider}`) || "";
  const keyHints = {
    gemini: `Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>`,
    claude: `Get a key (with $5 free credit) at <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a>`,
    deepseek: `Get a key (5M free tokens for 30 days, no card) at <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener">platform.deepseek.com/api_keys</a>`,
    github: `Create a fine-grained token with "models: read" permission at <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a> — free, rate-limited, tied to your GitHub account (no separate signup/balance)`,
  };
  els.keyHint.innerHTML = keyHints[state.provider] || "";
}

function currentApiKey() {
  return localStorage.getItem(`mentora_api_key_${state.provider}`) || "";
}

function setStatus(msg, isError = false) {
  els.statusMsg.textContent = msg;
  els.statusMsg.style.color = isError ? "#dc2626" : "#475569";
}

/** Shows/hides the full-screen loading overlay used during API calls. */
function showLoading(visible, text = "Working...") {
  els.loadingText.textContent = text;
  els.loadingOverlay.classList.toggle("hidden", !visible);
}

/* ------------------------------ LLM dispatcher ----------------------------- */

/** Routes to whichever provider is selected. Both return plain response text. */
async function callLLM(prompt, maxTokens = 1500) {
  return withRetry(() => {
    if (state.provider === "gemini") return callGemini(prompt, maxTokens);
    if (state.provider === "deepseek") return callDeepSeek(prompt, maxTokens);
    if (state.provider === "github") return callGitHubModels(prompt, maxTokens);
    return callClaude(prompt, maxTokens);
  });
}

/**
 * Retries a rate-limited (429) call with exponential backoff. Course
 * generation makes several LLM calls back-to-back (concept extraction, then
 * one call per concept) — free-tier keys can cap requests per minute (Gemini's
 * free tier has been seen as low as 5 req/min on some models), so a single
 * 429 partway through would otherwise abort the whole lesson instead of just
 * pausing briefly. Only 429s are retried; any other error fails immediately,
 * same as before.
 */
async function withRetry(fn, { retries = 3, baseDelayMs = 4000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is429 = /\b429\b/.test(err.message) || /RESOURCE_EXHAUSTED/.test(err.message);
      if (!is429 || attempt >= retries) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      showLoading(true, `Rate limited by the API — retrying in ${Math.round(delay / 1000)}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function callClaude(prompt, maxTokens = 1500) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": currentApiKey(),
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content[0].text;
}

/**
 * Google Gemini API (free tier: no card required, no expiration, ~1500 req/day
 * on Flash models as of mid-2026). Get a key at https://aistudio.google.com/apikey
 *
 * NOTE: Google's specific model versions get deprecated/restricted to new
 * users on a rolling basis (e.g. gemini-2.0-flash, then gemini-2.5-flash both
 * stopped working for new accounts in 2026). We use the "gemini-flash-latest"
 * alias, which Google always points at its current default Flash model, so
 * this stays working across future model releases without code changes.
 */
async function callGemini(prompt, maxTokens = 1500) {
  const model = "gemini-flash-latest";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(currentApiKey())}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      // Newer Gemini Flash models "think" before answering by default, and
      // that internal reasoning counts against maxOutputTokens — with a low
      // budget (800-1500) the thinking alone can exhaust it, leaving zero
      // tokens for the actual answer. thinkingBudget: 0 disables that, and
      // we give extra headroom on maxOutputTokens as a safety margin.
      generationConfig: {
        maxOutputTokens: Math.max(maxTokens, 2048),
        temperature: 0.7,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  if (!text) {
    const reason = data?.candidates?.[0]?.finishReason;
    throw new Error(`Gemini returned no text${reason ? ` (finishReason: ${reason})` : ""} — try again, or try shorter material`);
  }
  return text;
}

/**
 * DeepSeek API — OpenAI-compatible chat completions endpoint (api.deepseek.com).
 * New accounts get a one-time 5M free token grant (30-day window, no card
 * required), then cheap pay-as-you-go pricing — a good fallback when a
 * Gemini free-tier key hits its per-minute rate limit mid-lesson.
 * Get a key at platform.deepseek.com/api_keys.
 */
async function callDeepSeek(prompt, maxTokens = 1500) {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${currentApiKey()}`,
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.7,
      // Thinking mode defaults to on and spends extra tokens on chain-of-thought
      // we don't need for structured JSON extraction/generation — disabling it
      // keeps responses fast and cheap, same rationale as Gemini's
      // thinkingBudget: 0 above.
      thinking: { type: "disabled" },
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("DeepSeek returned no text — try again, or try shorter material");
  return text;
}

/**
 * GitHub Models API — free, rate-limited inference tied to a GitHub personal
 * access token (`models: read` scope) rather than a separate account or
 * top-up balance. There's no balance to run dry, unlike DeepSeek's
 * grant-based free tier — a good fallback when another provider's free tier
 * is rate-limited or out of credit. Uses gpt-4o-mini, one of the more
 * generously-limited "low" tier models (15 req/min, 150/day on a free
 * GitHub account) rather than a "high" tier reasoning model, to avoid
 * repeating the same rate-limit problem. Get a token at
 * github.com/settings/personal-access-tokens/new.
 */
async function callGitHubModels(prompt, maxTokens = 1500) {
  const res = await fetch("https://models.github.ai/inference/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/vnd.github+json",
      authorization: `Bearer ${currentApiKey()}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
  });
  if (!res.ok) throw new Error(`GitHub Models API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("GitHub Models returned no text — try again, or try shorter material");
  return text;
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error("No JSON found in model response");
  return JSON.parse(match[0]);
}

async function extractConcepts(material) {
  const prompt = `You are building an adaptive tutor. From the study material below, extract 5 to 8 core concepts a student must understand, in dependency order (a concept can depend on earlier ones).

Return ONLY valid JSON, an array like:
[{"id":"c1","label":"Short concept name","dependsOn":[]}, {"id":"c2","label":"...","dependsOn":["c1"]}]

Study material:
"""
${material}
"""`;
  const text = await callLLM(prompt, 800);
  return extractJson(text);
}

/**
 * Validates and repairs an LLM-extracted concept graph before it ever reaches
 * the MasteryModel. Live-generated `dependsOn` arrays can reference ids that
 * don't exist, or form a cycle (A needs B needs A) — either one makes
 * recommendNext() find no ready concept forever, silently presenting a stuck
 * lesson as "end of lesson, mastered what's reachable" (see advanceToRecommended).
 * This makes the graph a guaranteed DAG over real ids before that ever runs:
 * dangling references are dropped, and cycles are broken by cutting the
 * back-edge found during a DFS pass (keeps forward edges, drops the one edge
 * that closes the loop). Returns { concepts, repaired } — repaired is true if
 * anything had to be fixed, so callers can log/flag it without alarming the UI.
 */
function validateAndRepairGraph(rawConcepts) {
  if (!Array.isArray(rawConcepts) || !rawConcepts.length) {
    throw new Error("Concept extraction returned no concepts");
  }
  let repaired = false;
  const ids = new Set(rawConcepts.map((c) => c.id));
  // Drop dangling deps (unknown ids) and self-deps.
  const concepts = rawConcepts.map((c) => {
    const before = c.dependsOn || [];
    const deps = before.filter((d) => ids.has(d) && d !== c.id);
    if (deps.length !== before.length) repaired = true;
    return { ...c, dependsOn: deps };
  });
  const byId = Object.fromEntries(concepts.map((c) => [c.id, c]));
  // DFS cycle-breaking: WHITE = unvisited, GRAY = on the current path (a dep
  // pointing back into GRAY territory is a cycle), BLACK = fully resolved.
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = Object.fromEntries(concepts.map((c) => [c.id, WHITE]));
  function dfs(id) {
    color[id] = GRAY;
    const c = byId[id];
    c.dependsOn = c.dependsOn.filter((d) => {
      if (color[d] === GRAY) {
        repaired = true; // back-edge -> cycle, cut it
        return false;
      }
      if (color[d] === WHITE) dfs(d);
      return true;
    });
    color[id] = BLACK;
  }
  concepts.forEach((c) => {
    if (color[c.id] === WHITE) dfs(c.id);
  });
  return { concepts, repaired };
}

/**
 * Generates a concept's misconception taxonomy AND its 3-question quiz in ONE
 * LLM call. This used to be two separate calls per concept (taxonomy, then
 * quiz) — but that doubles the request volume of an already-multi-call course
 * generation (1 extraction call + N concept calls becomes 1 + 2N), which is
 * enough to trip a free-tier rate limit (Gemini's free tier has been seen as
 * low as 5 requests/minute on some models) partway through a 5-8 concept
 * lesson. One combined call per concept keeps the original 1+N call budget
 * while still getting a taxonomy fixed BEFORE the quiz references it — the
 * model just does both steps in the same response instead of a round trip.
 */
async function generateConceptContent(concept, material) {
  const prompt = `You are writing quiz material for the concept "${concept.label}", based on this study material:
"""
${material}
"""

Step 1 — Misconceptions: list 3 to 4 SPECIFIC, DISTINCT misconceptions a student might genuinely hold about this concept — real conceptual errors, not "doesn't know the answer" or "picked randomly". Each is a short named category (a few words, not a full sentence), with a short id like "m1", "m2".

Step 2 — Quiz: write exactly 3 multiple-choice questions (4 options each) testing this concept. Each question has exactly one correct choice and three incorrect choices. Every incorrect choice MUST be tagged with the id of the closest-matching misconception from your Step 1 list (reuse ids across questions where they fit — don't invent new ones). Vary difficulty slightly across the 3 questions.

Return ONLY valid JSON in this exact shape:
{"misconceptions":[{"id":"m1","label":"short misconception name"},{"id":"m2","label":"..."}],
 "quiz":[{"q":"...","choices":[{"text":"...","correct":true},{"text":"...","correct":false,"misconceptionId":"m1"},{"text":"...","correct":false,"misconceptionId":"m2"},{"text":"...","correct":false,"misconceptionId":"m1"}]}, ...]}`;
  const text = await callLLM(prompt, 1600);
  const parsed = extractJson(text);
  const taxonomy =
    Array.isArray(parsed.misconceptions) && parsed.misconceptions.length
      ? parsed.misconceptions
      : [{ id: "m1", label: "general misunderstanding" }];
  const quiz = sanitizeQuiz(parsed.quiz, taxonomy);
  return { taxonomy, quiz };
}

/**
 * Defends against non-compliant LLM output before it reaches the UI/BKT:
 * guarantees every question has exactly one `correct` choice (first "correct"
 * wins if the model marked more than one; if it marked none, the first choice
 * is forced correct rather than silently shipping an unanswerable question),
 * normalizes choices to plain string-or-object input, and drops any
 * misconceptionId that doesn't exist in this concept's taxonomy (stray/typo'd
 * ids becoming untagged rather than silently corrupting aggregation later).
 */
function sanitizeQuiz(rawQuiz, taxonomy) {
  const validIds = new Set((taxonomy || []).map((m) => m.id));
  return (Array.isArray(rawQuiz) ? rawQuiz : [])
    .map((item) => {
      const rawChoices = Array.isArray(item.choices) ? item.choices : [];
      let correctSeen = false;
      const choices = rawChoices.map((ch) => {
        const isObj = ch && typeof ch === "object";
        const text = String(isObj ? ch.text ?? "" : ch ?? "").trim();
        const claimedCorrect = isObj ? !!ch.correct : false;
        const isCorrect = claimedCorrect && !correctSeen;
        if (isCorrect) correctSeen = true;
        const misconceptionId = !isCorrect && isObj && validIds.has(ch.misconceptionId) ? ch.misconceptionId : null;
        return { text, correct: isCorrect, misconceptionId };
      });
      if (!correctSeen && choices.length) choices[0].correct = true;
      return { q: String(item.q || item.question || "").trim(), choices };
    })
    .filter((item) => item.q && item.choices.filter((c) => c.text).length >= 2);
}

/** Fisher-Yates shuffles a question's choices in place. Correctness and the
 * misconception tag live ON each choice object, so shuffling the array is all
 * that's needed to randomize the answer position — nothing to remap. Fixes
 * the "correct answer is always the first/textbook-sounding option" pattern
 * that both the bundled demo data and raw LLM output are prone to, which a
 * test-wise student can exploit without understanding anything. */
function shuffleChoices(question) {
  const choices = question.choices.slice();
  for (let i = choices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  return { ...question, choices };
}

async function generateAnalogyExplanation(concept, material, domain) {
  const prompt = `Explain the concept "${concept.label}" from this material using an extended analogy based entirely on ${domain}. Keep it under 120 words, concrete, and aimed at someone who just got it wrong on a quiz and needs an intuitive re-explanation, not a repeat of the textbook definition.
Material:
"""
${material}
"""`;
  return callLLM(prompt, 400);
}

/**
 * Misconception diagnosis: the highest-value use of the LLM here. Rather than
 * just "you got concept X wrong", it reads the student's specific wrong choice
 * and names the underlying misunderstanding it reveals — the thing a plain
 * quiz-score system can never do.
 */
async function diagnoseMisconception(concept, q, chosenText, correctText) {
  const prompt = `A student studying "${concept.label}" answered a multiple-choice question incorrectly.
Question: ${q.q}
The student chose: "${chosenText}"
The correct answer: "${correctText}"
In ONE short sentence addressed to the student as "You", name the SPECIFIC misconception their wrong choice reveals — the underlying thing they misunderstand — not a restatement of the correct answer. Start with "You're likely" or "You may be".`;
  return callLLM(prompt, 120);
}

/* ------------------------------- Demo data -------------------------------- */

const DEMO_MATERIAL = `Photosynthesis is the process by which plants convert light energy into chemical energy. It occurs in two stages: the light-dependent reactions, which take place in the thylakoid membrane and produce ATP and NADPH while splitting water and releasing oxygen, and the light-independent reactions (Calvin cycle), which occur in the stroma and use ATP and NADPH to fix carbon dioxide into glucose. Chlorophyll, the main pigment involved, absorbs mostly red and blue light and reflects green light, which is why plants appear green.`;

const DEMO_CONCEPTS = [
  { id: "c1", label: "Purpose of photosynthesis", dependsOn: [] },
  { id: "c2", label: "Light-dependent reactions", dependsOn: ["c1"] },
  { id: "c3", label: "Calvin cycle (light-independent)", dependsOn: ["c2"] },
  { id: "c4", label: "Role of chlorophyll", dependsOn: ["c1"] },
  { id: "c5", label: "Why plants appear green", dependsOn: ["c4"] },
];

const DEMO_MISCONCEPTIONS = {
  c1: [
    { id: "m1", label: "You're likely conflating what photosynthesis produces with what it consumes — it stores energy in glucose, rather than only making oxygen or breaking sugar down." },
    { id: "m2", label: "You're likely mixing photosynthesis up with cellular respiration — photosynthesis builds glucose, it doesn't release energy from it." },
    { id: "m3", label: "You may be placing photosynthesis in the wrong organelle — it happens in the chloroplast, not elsewhere in the cell." },
  ],
  c2: [
    { id: "m1", label: "You may be mixing up where the light-dependent reactions happen — they run in the thylakoid membrane, not the stroma or cytoplasm." },
    { id: "m2", label: "You're likely attributing the Calvin cycle's output (glucose) to the light reactions — the light reactions produce ATP and NADPH, not glucose directly." },
    { id: "m3", label: "You may be confusing what gets split and what gets released — water is split to release oxygen, not the reverse." },
  ],
  c3: [
    { id: "m1", label: "You're likely placing the Calvin cycle in the wrong compartment — it happens in the stroma, not the thylakoid membrane." },
    { id: "m2", label: "You're likely confusing the Calvin cycle's inputs with the light reactions' — it consumes ATP and NADPH rather than using sunlight directly." },
    { id: "m3", label: "You may be mixing up the Calvin cycle's end product with one of its inputs — glucose is what comes out, not what goes in." },
  ],
  c4: [
    { id: "m1", label: "You may be naming the wrong pigment — chlorophyll, not carotene or melanin, is the main pigment driving photosynthesis." },
    { id: "m2", label: "You're likely inverting what chlorophyll absorbs — it absorbs red and blue light, not green." },
    { id: "m3", label: "You may be placing chlorophyll in the wrong structure — it sits in the thylakoid membrane." },
  ],
  c5: [
    { id: "m1", label: "You're likely inverting absorption and reflection — plants look green because chlorophyll reflects green light, not because it absorbs it." },
    { id: "m2", label: "You may be assuming plants lack pigment entirely, when the color comes from which wavelengths chlorophyll reflects versus absorbs." },
    { id: "m3", label: "You're likely reasoning about wavelengths backwards — green is the LEAST absorbed, which is why it's reflected back to your eye." },
  ],
};

const DEMO_QUIZZES = {
  c1: [
    { q: "What is the overall purpose of photosynthesis?", choices: [
      { text: "Convert light energy into chemical energy", correct: true },
      { text: "Convert CO2 into oxygen only", correct: false, misconceptionId: "m1" },
      { text: "Break down glucose for energy", correct: false, misconceptionId: "m2" },
      { text: "Absorb water from soil", correct: false, misconceptionId: "m3" },
    ] },
    { q: "Which of these is a direct product of photosynthesis?", choices: [
      { text: "Glucose", correct: true },
      { text: "Nitrogen", correct: false, misconceptionId: "m1" },
      { text: "Ozone", correct: false, misconceptionId: "m3" },
      { text: "Salt", correct: false, misconceptionId: "m2" },
    ] },
    { q: "Photosynthesis primarily occurs in which organelle?", choices: [
      { text: "Chloroplast", correct: true },
      { text: "Mitochondrion", correct: false, misconceptionId: "m2" },
      { text: "Nucleus", correct: false, misconceptionId: "m3" },
      { text: "Ribosome", correct: false, misconceptionId: "m3" },
    ] },
  ],
  c2: [
    { q: "Where do light-dependent reactions occur?", choices: [
      { text: "Thylakoid membrane", correct: true },
      { text: "Stroma", correct: false, misconceptionId: "m1" },
      { text: "Cytoplasm", correct: false, misconceptionId: "m1" },
      { text: "Cell wall", correct: false, misconceptionId: "m1" },
    ] },
    { q: "What do light-dependent reactions produce?", choices: [
      { text: "ATP and NADPH", correct: true },
      { text: "Glucose directly", correct: false, misconceptionId: "m2" },
      { text: "CO2", correct: false, misconceptionId: "m2" },
      { text: "Chlorophyll", correct: false, misconceptionId: "m2" },
    ] },
    { q: "What molecule is split during light-dependent reactions, releasing oxygen?", choices: [
      { text: "Water", correct: true },
      { text: "Glucose", correct: false, misconceptionId: "m3" },
      { text: "Carbon dioxide", correct: false, misconceptionId: "m3" },
      { text: "ATP", correct: false, misconceptionId: "m3" },
    ] },
  ],
  c3: [
    { q: "Where does the Calvin cycle occur?", choices: [
      { text: "Stroma", correct: true },
      { text: "Thylakoid membrane", correct: false, misconceptionId: "m1" },
      { text: "Mitochondria", correct: false, misconceptionId: "m1" },
      { text: "Nucleus", correct: false, misconceptionId: "m1" },
    ] },
    { q: "What does the Calvin cycle use to fix carbon dioxide?", choices: [
      { text: "ATP and NADPH", correct: true },
      { text: "Oxygen and water", correct: false, misconceptionId: "m2" },
      { text: "Chlorophyll only", correct: false, misconceptionId: "m2" },
      { text: "Sunlight directly", correct: false, misconceptionId: "m2" },
    ] },
    { q: "What is the end product of the Calvin cycle?", choices: [
      { text: "Glucose", correct: true },
      { text: "Water", correct: false, misconceptionId: "m3" },
      { text: "Oxygen gas", correct: false, misconceptionId: "m3" },
      { text: "ATP", correct: false, misconceptionId: "m3" },
    ] },
  ],
  c4: [
    { q: "What is the main pigment involved in photosynthesis?", choices: [
      { text: "Chlorophyll", correct: true },
      { text: "Carotene", correct: false, misconceptionId: "m1" },
      { text: "Melanin", correct: false, misconceptionId: "m1" },
      { text: "Hemoglobin", correct: false, misconceptionId: "m1" },
    ] },
    { q: "What does chlorophyll primarily absorb?", choices: [
      { text: "Red and blue light", correct: true },
      { text: "Green light", correct: false, misconceptionId: "m2" },
      { text: "Ultraviolet light", correct: false, misconceptionId: "m2" },
      { text: "Infrared light", correct: false, misconceptionId: "m2" },
    ] },
    { q: "Chlorophyll is located in which structure?", choices: [
      { text: "Thylakoid membrane", correct: true },
      { text: "Cell wall", correct: false, misconceptionId: "m3" },
      { text: "Nucleus", correct: false, misconceptionId: "m3" },
      { text: "Ribosome", correct: false, misconceptionId: "m3" },
    ] },
  ],
  c5: [
    { q: "Why do plants appear green?", choices: [
      { text: "Chlorophyll reflects green light", correct: true },
      { text: "Chlorophyll absorbs green light", correct: false, misconceptionId: "m1" },
      { text: "Plants lack pigment", correct: false, misconceptionId: "m2" },
      { text: "Green light is invisible", correct: false, misconceptionId: "m2" },
    ] },
    { q: "Which wavelengths are least absorbed by chlorophyll?", choices: [
      { text: "Green", correct: true },
      { text: "Red", correct: false, misconceptionId: "m3" },
      { text: "Blue", correct: false, misconceptionId: "m3" },
      { text: "Violet", correct: false, misconceptionId: "m3" },
    ] },
    { q: "If a plant absorbed all wavelengths equally, it would appear:", choices: [
      { text: "Black", correct: true },
      { text: "Green", correct: false, misconceptionId: "m1" },
      { text: "White", correct: false, misconceptionId: "m1" },
      { text: "Red", correct: false, misconceptionId: "m1" },
    ] },
  ],
};

/* -------------------------------- Main flow -------------------------------- */

async function generateCourse(demo) {
  clearSession(); // starting fresh material should not leave a stale resume point
  state.demoMode = demo;
  const material = demo ? DEMO_MATERIAL : els.materialInput.value.trim();
  if (!material) return setStatus("Paste some study material first.", true);
  if (!demo && !currentApiKey()) return setStatus(`Add your ${PROVIDERS[state.provider].label} API key, or click 'Try Demo' instead.`, true);

  els.generateBtn.disabled = true;
  els.demoBtn.disabled = true;
  try {
    if (demo) {
      showLoading(true, "Loading demo lesson...");
    } else {
      showLoading(true, `Extracting concepts with ${PROVIDERS[state.provider].label}...`);
    }
    const rawConcepts = demo ? DEMO_CONCEPTS : await extractConcepts(material);
    // Live extraction can emit a dangling or cyclic dependsOn graph (references
    // to ids that don't exist, or A depends on B depends on A) — either one
    // makes recommendNext() stall forever, so the graph is validated/repaired
    // before anything else touches it. See validateAndRepairGraph() above.
    const { concepts: safeConcepts, repaired } = validateAndRepairGraph(rawConcepts);
    if (repaired) console.warn("Mentora: concept graph had dangling or cyclic dependencies — auto-repaired.");
    state.concepts = safeConcepts;
    state.quizzes = {};
    state.misconceptions = {};

    if (demo) {
      state.concepts.forEach((c) => {
        state.misconceptions[c.id] = DEMO_MISCONCEPTIONS[c.id] || [];
        state.quizzes[c.id] = (DEMO_QUIZZES[c.id] || []).map(shuffleChoices);
      });
    } else {
      for (let i = 0; i < state.concepts.length; i++) {
        const c = state.concepts[i];
        showLoading(true, `Writing quiz ${i + 1} of ${state.concepts.length}: ${c.label}...`);
        const { taxonomy, quiz } = await generateConceptContent(c, material);
        state.misconceptions[c.id] = taxonomy;
        state.quizzes[c.id] = quiz.map(shuffleChoices);
      }
    }

    // Tuned harder than textbook BKT defaults: lower pInit/pLearn slow the
    // climb toward mastery, lower pSlip means a wrong answer is taken more
    // at face value (less "benefit of the doubt"), and higher pGuess makes
    // a single correct answer weaker proof of real understanding. Combined
    // with the raised MASTERY_THRESHOLD below, mastering a concept now
    // reliably takes multiple consistent correct answers, not one or two.
    state.model = new MasteryModel(state.concepts, DEFAULT_BKT);
    state.material = material;
    state.calibration = []; // {predicted, correct} per answer, for the calibration check
    state.schedule = {};    // conceptId -> {lastReviewed, reviewCount} for spaced repetition
    state.clockOffset = 0;  // demo "simulate time" offset in ms
    state.reviewMode = false;
    state.reviewQueue = [];
    state.currentConfidence = true; // reset by renderQuestion() before each question anyway

    els.setupView.classList.add("hidden");
    els.learnView.classList.remove("hidden");
    els.headerProgress.classList.remove("hidden");
    renderGraph();
    renderDashboard();
    advanceToRecommended();
    setStatus("");
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, true);
  } finally {
    showLoading(false);
    els.generateBtn.disabled = false;
    els.demoBtn.disabled = false;
  }
}

function advanceToRecommended() {
  // Re-fit BKT parameters from everything answered so far, then rebuild and
  // replay. Done here (at concept boundaries) rather than after every answer,
  // so within-concept mastery stays intuitive and only re-calibrates between
  // concepts. On first call there's no history yet, so it stays on defaults.
  learnAndApply();
  updateSchedule();
  renderReviewPanel();
  // Use the same threshold everywhere (matches the 90% line on the dashboard),
  // so "recommend next" and "mastered" never disagree.
  const next = state.model.recommendNext(MASTERY_THRESHOLD);
  els.analogyPanel.classList.add("hidden");
  if (!next) {
    const overallPct = Math.round(state.model.overallMastery() * 100);
    const count = state.concepts.length;
    const masteredCount = state.concepts.filter((c) =>
      state.model.tracers[c.id].isMastered(MASTERY_THRESHOLD)
    ).length;
    const allMastered = masteredCount === count;
    const heading = allMastered
      ? `All ${count} concept${count === 1 ? "" : "s"} mastered.`
      : `${masteredCount} of ${count} concept${count === 1 ? "" : "s"} mastered.`;
    const sub = allMastered
      ? `Overall retention holding at ${overallPct}% across the full prerequisite graph.`
      : `You've reached the end of the reachable material — overall retention ${overallPct}%. The remaining concepts didn't cross the ${Math.round(MASTERY_THRESHOLD * 100)}% mastery line. Start over to keep working them.`;
    els.quizPanel.innerHTML = `
      <div class="completion-banner">
        <span class="completion-pill">${allMastered ? "Course complete" : "End of lesson"}</span>
        <div class="completion-text">
          <h3>${heading}</h3>
          <p>${sub}</p>
        </div>
        <button class="completion-btn" id="completionRestartBtn">Start over with new material &rarr;</button>
      </div>`;
    els.recommendation.textContent = "";
    document.getElementById("completionRestartBtn")?.addEventListener("click", () => {
      clearSession();
      location.reload();
    });
    renderDashboard();
    renderGraph();
    renderCalibration();
    saveSession();
    return;
  }
  state.currentConcept = next;
  state.currentQuestionIdx = 0;
  els.recommendation.textContent = `Next up · ${next.label} · current mastery ${(state.model.getMastery(next.id) * 100).toFixed(0)}%`;
  renderGraph();
  renderQuestion();
  saveSession();
}

/** Builds a stable "C01" style display code for a concept from its position in the graph. */
function conceptCode(index) {
  return `C${String(index + 1).padStart(2, "0")}`;
}

function renderGraph() {
  els.conceptGraph.innerHTML = state.concepts
    .map((c, i) => {
      const mastery = state.model ? state.model.getMastery(c.id) : c.dependsOn.length ? 0 : 0.25;
      const mastered = state.model ? state.model.tracers[c.id].isMastered(MASTERY_THRESHOLD) : false;
      const depsMet = c.dependsOn.every((d) => state.model && state.model.tracers[d]?.isMastered(MASTERY_THRESHOLD));
      const locked = !mastered && c.dependsOn.length > 0 && !depsMet;
      const isCurrent = state.currentConcept?.id === c.id;
      const stateClass = mastered ? "mastered" : locked ? "locked" : isCurrent ? "in-progress current" : "in-progress";
      const statusLabel = mastered ? "Mastered" : locked ? "Locked" : isCurrent ? "In progress" : "Available";
      const statusSub = c.dependsOn.length
        ? `requires ${c.dependsOn.map((d) => conceptCode(state.concepts.findIndex((x) => x.id === d))).join(", ")}`
        : "root concept";
      const pct = Math.round((mastery ?? 0) * 100);
      return `<div class="concept-card ${stateClass}" id="node-${c.id}">
        <div class="concept-card-top">
          <span class="concept-name">${c.label}</span>
          <span class="concept-code">${conceptCode(i)}</span>
        </div>
        <div class="concept-card-bottom">
          <div class="concept-status">
            <span class="status-label">${statusLabel}</span>
            <span class="status-sub">${statusSub}</span>
          </div>
          <span class="concept-pct">${pct}%</span>
        </div>
        <div class="concept-card-bar"><div class="concept-card-bar-fill" style="width:${pct}%"></div></div>
      </div>`;
    })
    .join("");
}

function renderDashboard() {
  const snap = state.model.snapshot();
  els.dashboard.innerHTML = snap
    .map((s) => {
      const pct = Math.round(s.mastery * 100);
      const color = s.mastered ? "#3f5d3a" : pct > 50 ? "#a9822e" : "#a13c2f";
      return `<div class="bar-row">
        <span class="bar-label">${s.label}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
        <span class="bar-pct">${pct}%</span>
      </div>`;
    })
    .join("");
  updateHeaderProgress();
}

function updateHeaderProgress() {
  if (!state.model) return;
  const pct = Math.round(state.model.overallMastery() * 100);
  els.overallProgressFill.style.width = `${pct}%`;
  els.overallProgressFill.style.background = pct >= 90 ? "#3f5d3a" : pct > 50 ? "#a9822e" : "#a13c2f";
  els.overallProgressPct.textContent = `${pct}`;
}

/**
 * Re-fit the BKT parameters to this student's actual answers, then rebuild the
 * mastery model with the learned parameters and replay every answer through it.
 * Falls back silently to the current model if bktFit.js isn't loaded or there
 * aren't enough answers yet to fit responsibly.
 */
function learnAndApply() {
  if (typeof fitModel !== "function") return; // bktFit.js not present
  // Regularize toward our starting defaults so a short lesson's worth of
  // answers nudges the parameters rather than swinging them to extremes.
  const result = fitModel(state.model, { minObservations: 6, prior: DEFAULT_BKT });
  state.lastFit = result;
  if (result.fitted) {
    const rebuilt = new MasteryModel(state.concepts, result.params);
    state.concepts.forEach((c) => {
      state.model.tracers[c.id].history.forEach((h) => rebuilt.recordAnswer(c.id, h.correct));
    });
    state.model = rebuilt;
  }
  renderParams(result);
}

/** Shows default vs learned parameters so "it actually learns" is visible on screen. */
function renderParams(result) {
  if (!els.paramReadout) return;
  els.paramReadout.classList.remove("hidden");
  const fmt = (p) => `init ${p.pInit.toFixed(2)} · learn ${p.pLearn.toFixed(2)} · slip ${p.pSlip.toFixed(2)} · guess ${p.pGuess.toFixed(2)}`;
  if (!result.fitted) {
    els.paramReadout.innerHTML =
      `<div class="param-tag">model parameters</div>` +
      `<div class="param-line">Defaults — ${fmt(DEFAULT_BKT)}</div>` +
      `<div class="param-note">Learning from your answers… (${result.observations}/6 needed to fit)</div>`;
    return;
  }
  els.paramReadout.innerHTML =
    `<div class="param-tag param-tag-learned">model parameters · learned</div>` +
    `<div class="param-line">Learned — ${fmt(result.params)}</div>` +
    `<div class="param-note">Fit from ${result.observations} of your answers by maximum likelihood (was: ${fmt(DEFAULT_BKT)})</div>`;
}

/**
 * Calibration check: does the model's stated confidence match reality? Before
 * each answer we logged P(correct) implied by the mastery estimate; here we
 * compare those predictions against what actually happened. A well-calibrated
 * model that says "80%" should be right ~80% of the time. Reported as a Brier
 * score (mean squared error of the probabilities; 0 is perfect) plus a
 * predicted-vs-actual breakdown by confidence band. This is the evidence that
 * the mastery numbers are honest, not decorative.
 */
/**
 * Groups the raw calibration log into fixed-width predicted-probability buckets
 * (default 10, i.e. 0-10%, 10-20%, ... 90-100%) and reduces each non-empty
 * bucket to a single {avgPred, actual, n} point — the data a reliability
 * diagram plots. Pulled out as its own function so it's testable independent
 * of any DOM/SVG rendering.
 */
function buildReliabilityBins(log, numBins = 10) {
  const bins = Array.from({ length: numBins }, (_, i) => ({ lo: i / numBins, hi: (i + 1) / numBins, items: [] }));
  log.forEach((e) => {
    let idx = Math.floor(e.predicted * numBins);
    if (idx >= numBins) idx = numBins - 1;
    if (idx < 0) idx = 0;
    bins[idx].items.push(e);
  });
  return bins
    .filter((b) => b.items.length)
    .map((b) => ({
      avgPred: b.items.reduce((s, e) => s + e.predicted, 0) / b.items.length,
      actual: b.items.filter((e) => e.correct).length / b.items.length,
      n: b.items.length,
    }));
}

/** Green/amber/red by how far a point strays from the perfect-calibration diagonal. */
function reliabilityColor(avgPred, actual) {
  const gap = Math.abs(avgPred - actual);
  if (gap < 0.1) return "#3f5d3a";
  if (gap < 0.25) return "#a9822e";
  return "#a13c2f";
}

/**
 * Renders a small inline SVG reliability diagram: predicted confidence (x) vs
 * observed correctness rate (y) per bucket, with a dashed diagonal marking
 * perfect calibration (a point sitting exactly on the line means "when the
 * model said N%, you were right N% of the time"). Point radius scales with
 * how many answers landed in that bucket, so sparse buckets read as less
 * conclusive at a glance.
 */
function reliabilitySvg(points) {
  const padL = 34, padB = 22, padT = 12, padR = 12;
  const w = 260, h = 200;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const x0 = padL, y0 = h - padB;
  const toX = (p) => x0 + p * plotW;
  const toY = (a) => y0 - a * plotH;

  const ticks = [0, 0.5, 1];
  const xTicks = ticks
    .map(
      (t) => `<line x1="${toX(t)}" y1="${y0}" x2="${toX(t)}" y2="${y0 + 4}" stroke="#8a8578" stroke-width="1"/>
      <text x="${toX(t)}" y="${y0 + 15}" font-size="8.5" text-anchor="middle" fill="#8a8578">${Math.round(t * 100)}</text>`
    )
    .join("");
  const yTicks = ticks
    .map(
      (t) => `<line x1="${x0 - 4}" y1="${toY(t)}" x2="${x0}" y2="${toY(t)}" stroke="#8a8578" stroke-width="1"/>
      <text x="${x0 - 8}" y="${(toY(t) + 3).toFixed(1)}" font-size="8.5" text-anchor="end" fill="#8a8578">${Math.round(t * 100)}</text>`
    )
    .join("");

  const dots = points
    .map((p) => {
      const r = Math.max(3, Math.min(10, 3 + Math.sqrt(p.n) * 1.5));
      const color = reliabilityColor(p.avgPred, p.actual);
      return `<circle cx="${toX(p.avgPred).toFixed(1)}" cy="${toY(p.actual).toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" fill-opacity="0.85" stroke="${color}" stroke-width="1"/>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="190" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Reliability diagram: predicted confidence versus actual correctness">
    <line x1="${x0}" y1="${y0}" x2="${x0}" y2="${padT}" stroke="#8a8578" stroke-width="1"/>
    <line x1="${x0}" y1="${y0}" x2="${w - padR}" y2="${y0}" stroke="#8a8578" stroke-width="1"/>
    <line x1="${toX(0)}" y1="${toY(0)}" x2="${toX(1)}" y2="${toY(1)}" stroke="#8a8578" stroke-width="1" stroke-dasharray="3,3"/>
    ${xTicks}
    ${yTicks}
    <text x="${(x0 + plotW / 2).toFixed(1)}" y="${h - 2}" font-size="9" text-anchor="middle" fill="#8a8578">predicted %</text>
    <text x="10" y="${(padT + plotH / 2).toFixed(1)}" font-size="9" text-anchor="middle" fill="#8a8578" transform="rotate(-90 10 ${(padT + plotH / 2).toFixed(1)})">actual %</text>
    ${dots}
  </svg>`;
}

function renderCalibration() {
  if (!els.calibrationPanel) return;
  const log = state.calibration || [];
  if (log.length < 5) {
    els.calibrationPanel.classList.add("hidden");
    return;
  }
  els.calibrationPanel.classList.remove("hidden");

  const brier = log.reduce((s, e) => s + (e.predicted - (e.correct ? 1 : 0)) ** 2, 0) / log.length;
  const points = buildReliabilityBins(log);

  els.calibrationPanel.innerHTML =
    `<div class="calib-tag">calibration · is the model's confidence honest?</div>` +
    `<div class="calib-brier">Brier score ${brier.toFixed(3)} <span class="calib-note">(0 = perfect, lower is better)</span></div>` +
    `<div class="calib-chart">${reliabilitySvg(points)}</div>` +
    `<div class="calib-note">Each point groups answers by the model's pre-answer confidence (x-axis) against how often you were actually right (y-axis), across ${log.length} answers. Dashed line = perfect calibration; dot size = sample count in that bucket.</div>`;
}

/* --------------------------- Spaced repetition ----------------------------- */

/** Wall-clock time adjusted by the demo "simulate time" offset. */
function now() {
  return Date.now() + (state.clockOffset || 0);
}

/** Human-readable duration: "Nd" / "Nh" / "Nm" (minimum 1m). */
function formatDuration(ms) {
  const abs = Math.abs(ms);
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;
  const MINUTE = 60 * 1000;
  if (abs >= DAY) return `${Math.round(abs / DAY)}d`;
  if (abs >= HOUR) return `${Math.round(abs / HOUR)}h`;
  return `${Math.max(1, Math.round(abs / MINUTE))}m`;
}

/**
 * Enrolls newly-mastered concepts into the spaced-repetition schedule. Never
 * overwrites an existing schedule entry — reviewCount progression from
 * recordReviewResult is the only thing allowed to change it after that.
 */
function updateSchedule() {
  if (typeof Spaced === "undefined") return;
  state.concepts.forEach((c) => {
    const tracer = state.model?.tracers[c.id];
    if (tracer && tracer.isMastered(MASTERY_THRESHOLD) && !state.schedule[c.id]) {
      state.schedule[c.id] = { lastReviewed: now(), reviewCount: 1 };
    }
  });
}

/** Concepts currently on the schedule whose estimated retention has fallen due. */
function dueConcepts() {
  if (typeof Spaced === "undefined") return [];
  return state.concepts.filter((c) => {
    const s = state.schedule[c.id];
    return s && Spaced.isDue(now(), s.lastReviewed, s.reviewCount);
  });
}

/** Renders the spaced-repetition panel: per-concept retention/status plus time-travel controls. */
function renderReviewPanel() {
  if (!els.reviewPanel) return;
  if (typeof Spaced === "undefined") {
    els.reviewPanel.classList.add("hidden");
    return;
  }
  const scheduledIds = Object.keys(state.schedule || {});
  if (!scheduledIds.length) {
    els.reviewPanel.classList.add("hidden");
    return;
  }
  els.reviewPanel.classList.remove("hidden");

  const rows = scheduledIds
    .map((id) => {
      const c = state.concepts.find((x) => x.id === id);
      if (!c) return "";
      const s = state.schedule[id];
      const retPct = Math.round(Spaced.retention(now() - s.lastReviewed, s.reviewCount) * 100);
      const due = Spaced.isDue(now(), s.lastReviewed, s.reviewCount);
      const statusText = due
        ? "due now"
        : `next review in ${formatDuration(Spaced.nextDueMs(s.lastReviewed, s.reviewCount) - now())}`;
      return `<div class="review-row">
        <span class="review-name">${c.label}</span>
        <span class="review-ret">retention ~${retPct}%</span>
        <span class="review-status${due ? " review-due" : ""}">${statusText}</span>
      </div>`;
    })
    .join("");

  const dueCount = dueConcepts().length;

  els.reviewPanel.innerHTML =
    `<div class="review-tag">spaced review</div>` +
    rows +
    `<div class="review-controls">
      <button class="ghost-btn" id="simDayBtn">Simulate +1 day</button>
      <button class="ghost-btn" id="simWeekBtn">Simulate +1 week</button>
      ${dueCount ? `<button class="primary-btn" id="reviewDueBtn">Review due (${dueCount})</button>` : ""}
    </div>`;

  document.getElementById("simDayBtn")?.addEventListener("click", () => simulateTime(24 * 60 * 60 * 1000));
  document.getElementById("simWeekBtn")?.addEventListener("click", () => simulateTime(7 * 24 * 60 * 60 * 1000));
  document.getElementById("reviewDueBtn")?.addEventListener("click", () => startReviewSession());
}

/** Fast-forwards the demo clock so retention decay / due dates are visible without waiting. */
function simulateTime(ms) {
  state.clockOffset = (state.clockOffset || 0) + ms;
  renderReviewPanel();
}

/** Enters spaced-review mode: queues every due concept, one question each. */
function startReviewSession() {
  const due = dueConcepts();
  if (!due.length) return;
  state.reviewMode = true;
  state.reviewQueue = due.slice();
  els.recommendation.textContent = `Spaced review · ${due.length} concept${due.length === 1 ? "" : "s"} due for review`;
  nextReviewItem();
}

/** Pulls the next due concept off the review queue, or exits review mode when empty. */
function nextReviewItem() {
  if (!state.reviewQueue.length) {
    state.reviewMode = false;
    els.quizPanel.innerHTML = "";
    renderReviewPanel();
    advanceToRecommended();
    return;
  }
  state.currentConcept = state.reviewQueue.shift();
  state.currentQuestionIdx = 0;
  renderQuestion();
}

/**
 * Records the outcome of a spaced-review question: success expands the review
 * interval (reviewCount++), failure resets it to the shortest interval. This is
 * the ONLY place schedule entries change after their initial creation.
 */
function recordReviewResult(concept, correct) {
  const s = state.schedule[concept.id] || { reviewCount: 0 };
  s.lastReviewed = now();
  s.reviewCount = correct ? (s.reviewCount || 0) + 1 : 1;
  state.schedule[concept.id] = s;
  saveSession();
}

/* --------------------------- Session persistence ---------------------------- */

/**
 * Serializes the whole lesson (concepts, quizzes, material, calibration log,
 * spaced-repetition schedule, clock offset, and per-concept BKT answer
 * histories) to localStorage so a student can close the tab mid-lesson and
 * resume exactly where they left off. Only the raw `correct` booleans are
 * saved per concept — masteryBefore/masteryAfter are recomputed on replay
 * (see loadSession), since ConceptTracer.observe() is deterministic.
 */
function saveSession() {
  if (!state.model) return;
  const params = state.lastFit?.params || DEFAULT_BKT;
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
    console.error("saveSession failed", err);
  }
}

/**
 * Rebuilds state from a saved session: reconstructs the MasteryModel with the
 * saved (learned) BKT params, then replays each concept's saved answer
 * history through recordAnswer so mastery, history, and everything derived
 * from it end up bit-for-bit identical to where the student left off.
 * Returns false (and leaves state untouched) if there's no valid save.
 */
function loadSession() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return false;
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error("loadSession: corrupt saved session", err);
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

  const params = data.params || DEFAULT_BKT;
  state.model = new MasteryModel(state.concepts, params);
  state.concepts.forEach((c) => {
    (data.histories?.[c.id] || []).forEach((correct) => state.model.recordAnswer(c.id, correct));
  });
  // Let advanceToRecommended's learnAndApply() re-derive lastFit/paramReadout
  // from the replayed history rather than guessing at a stale observation count.

  return true;
}

/** Clears the saved session (fresh material, or explicit "start over"). */
function clearSession() {
  localStorage.removeItem(SAVE_KEY);
}

function renderQuestion() {
  const concept = state.currentConcept;
  const quiz = state.quizzes[concept.id];
  const q = quiz[state.currentQuestionIdx % quiz.length];
  state.currentQuestion = q; // remembered so handleAnswer can diagnose the wrong choice
  state.currentConfidence = true; // each new question starts on "Confident" by default
  els.quizPanel.innerHTML = `
    <h3>${concept.label}</h3>
    <p class="question">${q.q}</p>
    <div class="confidence-toggle" role="group" aria-label="How confident are you?">
      <span class="confidence-label">How sure are you?</span>
      <button type="button" class="confidence-btn active" data-confident="true">Confident</button>
      <button type="button" class="confidence-btn" data-confident="false">Not sure</button>
    </div>
    <div class="choices">
      ${q.choices.map((c, i) => `<button class="choice-btn" data-i="${i}">${c.text}</button>`).join("")}
    </div>
  `;
  els.quizPanel.querySelectorAll(".confidence-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.currentConfidence = btn.dataset.confident === "true";
      els.quizPanel.querySelectorAll(".confidence-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.confident === btn.dataset.confident);
      });
    });
  });
  els.quizPanel.querySelectorAll(".choice-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleAnswer(parseInt(btn.dataset.i, 10)));
  });
}

function handleAnswer(chosenIdx) {
  const q = state.currentQuestion;
  const correctIdx = q.choices.findIndex((c) => c.correct);
  const correct = chosenIdx === correctIdx;
  const concept = state.currentConcept;
  // Whichever confidence toggle the student left active when they clicked an
  // answer choice — "Confident" by default (see renderQuestion). Feeds into
  // the BKT update so a sure-but-wrong answer and an unsure-but-wrong answer
  // move mastery differently; see the rationale on ConceptTracer.observe().
  const confident = state.currentConfidence !== false;
  // Log the model's prediction BEFORE it sees the answer: P(correct) implied by
  // the current mastery and parameters. Comparing these against actual outcomes
  // is the calibration check — it's how we prove the mastery numbers are honest.
  const tracer = state.model.tracers[concept.id];
  const predicted = tracer.mastery * (1 - tracer.pSlip) + (1 - tracer.mastery) * tracer.pGuess;
  (state.calibration ||= []).push({ predicted, correct, confident });
  // Record with the CURRENT (fixed) parameters so mastery moves intuitively
  // within a concept — a wrong answer always visibly lowers it. Parameter
  // learning happens at concept boundaries instead (see advanceToRecommended),
  // so a mid-concept refit can never push mastery up on a wrong answer.
  const newMastery = state.model.recordAnswer(concept.id, correct, confident);
  renderDashboard();
  renderGraph();
  renderCalibration();

  const buttons = els.quizPanel.querySelectorAll(".choice-btn");
  buttons.forEach((b, i) => {
    b.disabled = true;
    if (i === correctIdx) b.classList.add("correct");
    else if (i === chosenIdx) b.classList.add("incorrect");
  });
  els.quizPanel.querySelectorAll(".confidence-btn").forEach((b) => (b.disabled = true));

  const feedback = document.createElement("div");
  feedback.className = `feedback ${correct ? "feedback-correct" : "feedback-incorrect"}`;
  feedback.innerHTML =
    (correct
      ? `Correct. Mastery of "${concept.label}" is now ${(newMastery * 100).toFixed(0)}%.`
      : `Not quite. Mastery of "${concept.label}" is now ${(newMastery * 100).toFixed(0)}%.`) +
    ` <span class="confidence-echo">(marked ${confident ? "confident" : "not sure"})</span>`;
  els.quizPanel.appendChild(feedback);

  if (!correct) {
    diagnoseAndShowMisconception(concept, q, chosenIdx, correctIdx);
    offerAnalogyReview(concept);
  }

  const nextBtn = document.createElement("button");
  nextBtn.className = "primary-btn";
  nextBtn.textContent = "Continue";
  nextBtn.style.marginTop = "12px";
  nextBtn.addEventListener("click", () => {
    if (state.reviewMode) {
      // Spaced-review mode: one question per due concept, then update its schedule.
      recordReviewResult(concept, correct);
      renderReviewPanel();
      nextReviewItem();
      return;
    }
    state.currentQuestionIdx++;
    if (state.model.getMastery(concept.id) >= MASTERY_THRESHOLD || state.currentQuestionIdx >= MAX_ATTEMPTS_PER_CONCEPT) {
      advanceToRecommended();
    } else {
      renderQuestion();
    }
  });
  els.quizPanel.appendChild(nextBtn);
  saveSession();
}

/**
 * Shows the specific misconception behind a wrong answer. Live mode still asks
 * the LLM for a fresh, personalized "You're likely..." sentence (better UX
 * than a canned label) — but the chosen choice ALSO carries a misconceptionId
 * from this concept's fixed taxonomy (see generateQuiz/sanitizeQuiz), tagged
 * here for anything downstream that wants to aggregate misconceptions across
 * questions/students rather than string-matching free text.
 */
function diagnoseAndShowMisconception(concept, q, chosenIdx, correctIdx) {
  if (!q) return;
  const chosen = q.choices[chosenIdx];
  const correctChoice = q.choices[correctIdx];
  const el = document.createElement("div");
  el.className = "misconception";
  el.innerHTML =
    `<span class="misconception-tag">Likely misconception</span>` +
    `<span class="misconception-text">Pinpointing what tripped you up…</span>`;
  els.quizPanel.appendChild(el);
  const textEl = el.querySelector(".misconception-text");
  if (state.demoMode) {
    textEl.textContent = demoMisconception(concept, chosen);
    return;
  }
  diagnoseMisconception(concept, q, chosen.text, correctChoice.text)
    .then((t) => (textEl.textContent = (t || "").trim() || "Look again at what this concept specifically does."))
    .catch(() => el.remove());
}

/** Looks up the demo-mode sentence for the taxonomy id tagged on the chosen (wrong) choice. */
function demoMisconception(concept, chosenChoice) {
  const taxonomy = state.misconceptions?.[concept.id] || DEMO_MISCONCEPTIONS[concept.id] || [];
  const match = taxonomy.find((m) => m.id === chosenChoice?.misconceptionId);
  return match?.label || "You're likely mixing this concept up with a closely related one — look again at what it specifically does.";
}

function offerAnalogyReview(concept) {
  els.analogyPanel.classList.remove("hidden");
  els.analogyResult.textContent = "";
  els.analogyChoices.querySelectorAll("button").forEach((btn) => {
    btn.onclick = async () => {
      els.analogyResult.textContent = "";
      if (!state.demoMode) showLoading(true, `Writing a ${btn.dataset.domain} analogy...`);
      try {
        const text = state.demoMode
          ? demoAnalogy(concept, btn.dataset.domain)
          : await generateAnalogyExplanation(concept, state.material, btn.dataset.domain);
        els.analogyResult.textContent = text;
      } catch (err) {
        els.analogyResult.textContent = `Error: ${err.message}`;
      } finally {
        showLoading(false);
      }
    };
  });
}

function demoAnalogy(concept, domain) {
  const bank = {
    cooking: `Think of the chloroplast like a kitchen. The light-dependent reactions are prepping raw ingredients (splitting water, generating energy packets — ATP and NADPH) using sunlight as your stove's heat. The Calvin cycle is the actual cooking: it takes those energy packets and CO2 "ingredients" and assembles them into glucose, the finished dish. No prep, no dinner.`,
    sports: `Picture a relay race. The light-dependent reactions are the first runner, sprinting on solar energy and handing off two batons — ATP and NADPH — to the next runner. The Calvin cycle is that second runner, using both batons plus CO2 picked up along the track to cross the finish line as glucose. Drop a baton (skip a stage) and the race never finishes.`,
    gaming: `It's like a two-stage quest. Stage 1 (light reactions) happens in the "thylakoid dungeon" where you fight using sunlight to farm resource drops (ATP, NADPH) and free a trapped oxygen. Stage 2 (Calvin cycle) happens in the "stroma overworld" where you spend those farmed resources plus CO2 pickups to craft the final item: glucose.`,
    music: `Think of it as a two-movement symphony. The first movement (light reactions) is fast and bright, powered directly by sunlight, producing the rhythmic pulses — ATP and NADPH — that carry into movement two. The second movement (Calvin cycle) is slower and builds on those pulses plus CO2 to resolve into the final chord: a glucose molecule.`,
  };
  return bank[domain] || `Here's another way to think about ${concept.label}...`;
}
