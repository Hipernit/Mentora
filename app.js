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
};

const state = {
  provider: localStorage.getItem("mentora_provider") || "gemini",
  concepts: [],
  quizzes: {}, // conceptId -> [{q, choices, answerIndex}]
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
});

function cacheEls() {
  [
    "providerSelect", "apiKeyLabel", "apiKeyInput", "saveKeyBtn", "materialInput", "generateBtn", "statusMsg",
    "setupView", "learnView", "conceptGraph", "quizPanel", "dashboard",
    "recommendation", "analogyPanel", "analogyChoices", "analogyResult",
    "demoBtn", "restartBtn",
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
  els.restartBtn.addEventListener("click", () => location.reload());
}

function syncProviderUI() {
  const p = PROVIDERS[state.provider];
  els.apiKeyLabel.textContent = p.keyLabel;
  els.apiKeyInput.placeholder = p.placeholder;
  els.apiKeyInput.value = localStorage.getItem(`mentora_api_key_${state.provider}`) || "";
}

function currentApiKey() {
  return localStorage.getItem(`mentora_api_key_${state.provider}`) || "";
}

function setStatus(msg, isError = false) {
  els.statusMsg.textContent = msg;
  els.statusMsg.style.color = isError ? "#dc2626" : "#475569";
}

/* ------------------------------ LLM dispatcher ----------------------------- */

/** Routes to whichever provider is selected. Both return plain response text. */
async function callLLM(prompt, maxTokens = 1500) {
  return state.provider === "gemini" ? callGemini(prompt, maxTokens) : callClaude(prompt, maxTokens);
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

async function generateQuiz(concept, material) {
  const prompt = `Write exactly 3 multiple-choice questions (4 options each) testing understanding of the concept "${concept.label}", based on this material:
"""
${material}
"""
Return ONLY valid JSON: [{"q":"...","choices":["a","b","c","d"],"answerIndex":0}, ...]. Vary difficulty slightly across the 3 questions.`;
  const text = await callLLM(prompt, 900);
  return extractJson(text);
}

async function generateAnalogyExplanation(concept, material, domain) {
  const prompt = `Explain the concept "${concept.label}" from this material using an extended analogy based entirely on ${domain}. Keep it under 120 words, concrete, and aimed at someone who just got it wrong on a quiz and needs an intuitive re-explanation, not a repeat of the textbook definition.
Material:
"""
${material}
"""`;
  return callLLM(prompt, 400);
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

const DEMO_QUIZZES = {
  c1: [
    { q: "What is the overall purpose of photosynthesis?", choices: ["Convert light energy into chemical energy", "Convert CO2 into oxygen only", "Break down glucose for energy", "Absorb water from soil"], answerIndex: 0 },
    { q: "Which of these is a direct product of photosynthesis?", choices: ["Glucose", "Nitrogen", "Ozone", "Salt"], answerIndex: 0 },
    { q: "Photosynthesis primarily occurs in which organelle?", choices: ["Chloroplast", "Mitochondrion", "Nucleus", "Ribosome"], answerIndex: 0 },
  ],
  c2: [
    { q: "Where do light-dependent reactions occur?", choices: ["Thylakoid membrane", "Stroma", "Cytoplasm", "Cell wall"], answerIndex: 0 },
    { q: "What do light-dependent reactions produce?", choices: ["ATP and NADPH", "Glucose directly", "CO2", "Chlorophyll"], answerIndex: 0 },
    { q: "What molecule is split during light-dependent reactions, releasing oxygen?", choices: ["Water", "Glucose", "Carbon dioxide", "ATP"], answerIndex: 0 },
  ],
  c3: [
    { q: "Where does the Calvin cycle occur?", choices: ["Stroma", "Thylakoid membrane", "Mitochondria", "Nucleus"], answerIndex: 0 },
    { q: "What does the Calvin cycle use to fix carbon dioxide?", choices: ["ATP and NADPH", "Oxygen and water", "Chlorophyll only", "Sunlight directly"], answerIndex: 0 },
    { q: "What is the end product of the Calvin cycle?", choices: ["Glucose", "Water", "Oxygen gas", "ATP"], answerIndex: 0 },
  ],
  c4: [
    { q: "What is the main pigment involved in photosynthesis?", choices: ["Chlorophyll", "Carotene", "Melanin", "Hemoglobin"], answerIndex: 0 },
    { q: "What does chlorophyll primarily absorb?", choices: ["Red and blue light", "Green light", "Ultraviolet light", "Infrared light"], answerIndex: 0 },
    { q: "Chlorophyll is located in which structure?", choices: ["Thylakoid membrane", "Cell wall", "Nucleus", "Ribosome"], answerIndex: 0 },
  ],
  c5: [
    { q: "Why do plants appear green?", choices: ["Chlorophyll reflects green light", "Chlorophyll absorbs green light", "Plants lack pigment", "Green light is invisible"], answerIndex: 0 },
    { q: "Which wavelengths are least absorbed by chlorophyll?", choices: ["Green", "Red", "Blue", "Violet"], answerIndex: 0 },
    { q: "If a plant absorbed all wavelengths equally, it would appear:", choices: ["Black", "Green", "White", "Red"], answerIndex: 0 },
  ],
};

/* -------------------------------- Main flow -------------------------------- */

async function generateCourse(demo) {
  state.demoMode = demo;
  const material = demo ? DEMO_MATERIAL : els.materialInput.value.trim();
  if (!material) return setStatus("Paste some study material first.", true);
  if (!demo && !currentApiKey()) return setStatus(`Add your ${PROVIDERS[state.provider].label} API key, or click 'Try Demo' instead.`, true);

  els.generateBtn.disabled = true;
  els.demoBtn.disabled = true;
  try {
    setStatus(demo ? "Loading demo lesson..." : `Extracting concepts with ${PROVIDERS[state.provider].label}...`);
    state.concepts = demo ? DEMO_CONCEPTS : await extractConcepts(material);

    if (demo) {
      state.quizzes = DEMO_QUIZZES;
    } else {
      setStatus("Generating quiz questions per concept...");
      for (const c of state.concepts) {
        state.quizzes[c.id] = await generateQuiz(c, material);
      }
    }

    state.model = new MasteryModel(state.concepts, { pInit: 0.25, pLearn: 0.3, pSlip: 0.1, pGuess: 0.22 });
    state.material = material;

    els.setupView.classList.add("hidden");
    els.learnView.classList.remove("hidden");
    renderGraph();
    renderDashboard();
    advanceToRecommended();
    setStatus("");
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, true);
  } finally {
    els.generateBtn.disabled = false;
    els.demoBtn.disabled = false;
  }
}

function advanceToRecommended() {
  const next = state.model.recommendNext();
  els.analogyPanel.classList.add("hidden");
  if (!next) {
    els.quizPanel.innerHTML = `<div class="mastered-banner">🎉 All concepts mastered! Overall mastery: ${(state.model.overallMastery() * 100).toFixed(0)}%</div>`;
    els.recommendation.textContent = "Course complete.";
    return;
  }
  state.currentConcept = next;
  state.currentQuestionIdx = 0;
  els.recommendation.textContent = `Next up: ${next.label} (current mastery ${(state.model.getMastery(next.id) * 100).toFixed(0)}%)`;
  renderQuestion();
}

function renderGraph() {
  els.conceptGraph.innerHTML = state.concepts
    .map((c) => `<div class="node" id="node-${c.id}">${c.label}${c.dependsOn.length ? `<span class="deps">depends on: ${c.dependsOn.map((d) => state.concepts.find((x) => x.id === d)?.label).join(", ")}</span>` : ""}</div>`)
    .join("");
}

function renderDashboard() {
  const snap = state.model.snapshot();
  els.dashboard.innerHTML = snap
    .map((s) => {
      const pct = Math.round(s.mastery * 100);
      const color = s.mastered ? "#16a34a" : pct > 50 ? "#d97706" : "#dc2626";
      return `<div class="bar-row">
        <span class="bar-label">${s.label}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
        <span class="bar-pct">${pct}%</span>
      </div>`;
    })
    .join("");
}

function renderQuestion() {
  const concept = state.currentConcept;
  const quiz = state.quizzes[concept.id];
  const q = quiz[state.currentQuestionIdx % quiz.length];
  els.quizPanel.innerHTML = `
    <h3>${concept.label}</h3>
    <p class="question">${q.q}</p>
    <div class="choices">
      ${q.choices.map((c, i) => `<button class="choice-btn" data-i="${i}">${c}</button>`).join("")}
    </div>
  `;
  els.quizPanel.querySelectorAll(".choice-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleAnswer(parseInt(btn.dataset.i, 10), q.answerIndex));
  });
}

function handleAnswer(chosenIdx, correctIdx) {
  const correct = chosenIdx === correctIdx;
  const concept = state.currentConcept;
  const newMastery = state.model.recordAnswer(concept.id, correct);
  renderDashboard();

  const buttons = els.quizPanel.querySelectorAll(".choice-btn");
  buttons.forEach((b, i) => {
    b.disabled = true;
    if (i === correctIdx) b.classList.add("correct");
    else if (i === chosenIdx) b.classList.add("incorrect");
  });

  const feedback = document.createElement("div");
  feedback.className = "feedback";
  feedback.innerHTML = correct
    ? `✅ Correct. Mastery of "${concept.label}" is now ${(newMastery * 100).toFixed(0)}%.`
    : `❌ Not quite. Mastery of "${concept.label}" is now ${(newMastery * 100).toFixed(0)}%.`;
  els.quizPanel.appendChild(feedback);

  if (!correct) offerAnalogyReview(concept);

  const nextBtn = document.createElement("button");
  nextBtn.className = "primary-btn";
  nextBtn.textContent = "Continue";
  nextBtn.style.marginTop = "12px";
  nextBtn.addEventListener("click", () => {
    state.currentQuestionIdx++;
    if (state.model.getMastery(concept.id) >= 0.85 || state.currentQuestionIdx >= 3) {
      advanceToRecommended();
    } else {
      renderQuestion();
    }
  });
  els.quizPanel.appendChild(nextBtn);
}

function offerAnalogyReview(concept) {
  els.analogyPanel.classList.remove("hidden");
  els.analogyResult.textContent = "";
  els.analogyChoices.querySelectorAll("button").forEach((btn) => {
    btn.onclick = async () => {
      els.analogyResult.textContent = "Generating a tailored explanation...";
      try {
        const text = state.demoMode
          ? demoAnalogy(concept, btn.dataset.domain)
          : await generateAnalogyExplanation(concept, state.material, btn.dataset.domain);
        els.analogyResult.textContent = text;
      } catch (err) {
        els.analogyResult.textContent = `Error: ${err.message}`;
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
