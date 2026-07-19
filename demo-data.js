/**
 * demo-data.js — single source of truth for the bundled photosynthesis demo
 * lesson (5-concept dependency graph, quiz bank, misconception taxonomy) and
 * the BKT tuning defaults, shared by three otherwise-independent pages:
 *
 *  - app.js     — the live lesson ("Try Demo" mode, plus BKT_PARAMS as the
 *                  starting point before per-student parameter fitting)
 *  - eval.js    — the evaluation harness (simulates students against this
 *                  same graph/tuning to measure adaptive-ordering efficiency)
 *  - teacher.js — the classroom rollup (simulates a class against this same
 *                  graph/tuning to build the mastery heatmap)
 *
 * Previously each page hand-duplicated its own copy of CONCEPTS/BKT_PARAMS;
 * kept in one file now so the three "simulations" of the same lesson can't
 * silently drift out of sync with each other or with the live app.
 *
 * No build step, so this is a plain global-scope script (like bkt.js) —
 * index.html, eval.html, and teacher.html each load it with a <script> tag
 * before their own page script.
 */

// Starting BKT parameters. app.js uses these until its fitter has learned
// better ones from a real student's answers (see learnAndApply in app.js);
// eval.js and teacher.js use them as-is throughout, since their synthetic
// students are simulated directly against a fixed model.
const BKT_PARAMS = { pInit: 0.2, pLearn: 0.22, pSlip: 0.08, pGuess: 0.25 };

// Raised from the textbook-BKT-demo default of 0.85 so a concept can't be
// "mastered" off one or two lucky answers.
const MASTERY_THRESHOLD = 0.9;

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

if (typeof module !== "undefined" && module.exports) {
  module.exports = { BKT_PARAMS, MASTERY_THRESHOLD, DEMO_MATERIAL, DEMO_CONCEPTS, DEMO_MISCONCEPTIONS, DEMO_QUIZZES };
}
