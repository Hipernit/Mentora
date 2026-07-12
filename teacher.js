/**
 * teacher.js — classroom rollup view.
 *
 * Mentora has no backend and collects no student data, so this view can't
 * pull a real roster. Instead it generates a class of synthetic students in
 * the browser, runs each one through the *exact same* MasteryModel / BKT
 * engine (bkt.js) that powers a real one-on-one lesson, and aggregates the
 * per-student tracers into class-level views: a mastery heatmap, per-concept
 * class averages, and a flagged intervention list. The point is to show the
 * per-student model rolls up cleanly to a classroom picture, not to fabricate
 * real analytics.
 */

// Same dependency graph as app.js's bundled demo lesson (photosynthesis),
// duplicated here since this page doesn't load app.js.
const CONCEPTS = [
  { id: "c1", label: "Purpose of photosynthesis", dependsOn: [] },
  { id: "c2", label: "Light-dependent reactions", dependsOn: ["c1"] },
  { id: "c3", label: "Calvin cycle (light-independent)", dependsOn: ["c2"] },
  { id: "c4", label: "Role of chlorophyll", dependsOn: ["c1"] },
  { id: "c5", label: "Why plants appear green", dependsOn: ["c4"] },
];

const BKT_PARAMS = { pInit: 0.25, pLearn: 0.3, pSlip: 0.1, pGuess: 0.22 };
const THRESHOLD = 0.85;

const FIRST_NAMES = [
  "Amara", "Beckett", "Carmen", "Devon", "Elif", "Farid", "Greta", "Hiro",
  "Ines", "Jasper", "Kalani", "Leandro", "Mira", "Noor", "Oscar", "Priya",
  "Quinn", "Rosa", "Sana", "Theo", "Uma", "Viggo", "Wren", "Xochitl",
  "Yusuf", "Zara", "Ava", "Baptiste",
];

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  ["classSizeSelect", "regenBtn", "heatmapTable", "classBars", "riskList"].forEach(
    (id) => (els[id] = document.getElementById(id))
  );
  els.regenBtn.addEventListener("click", buildClass);
  els.classSizeSelect.addEventListener("change", buildClass);
  buildClass();
});

/** Deterministic-ish class name draw without replacement (wraps if class > name list). */
function pickName(i) {
  const name = FIRST_NAMES[i % FIRST_NAMES.length];
  return i >= FIRST_NAMES.length ? `${name} ${Math.floor(i / FIRST_NAMES.length) + 1}` : name;
}

/** Simulates one student's full run through the concept graph. */
function simulateStudent() {
  const model = new MasteryModel(CONCEPTS, BKT_PARAMS);
  // Aptitude drives correctness probability; varies per student so the class
  // spreads out realistically instead of every row looking identical.
  const aptitude = 0.35 + Math.random() * 0.55;

  CONCEPTS.forEach((c) => {
    const depsMet = (c.dependsOn || []).every((d) => model.tracers[d].isMastered(THRESHOLD));
    if (!depsMet) return; // student never reaches a locked concept, same as real UI
    let attempts = 0;
    while (attempts < 3 && !model.tracers[c.id].isMastered(THRESHOLD)) {
      const correct = Math.random() < aptitude;
      model.recordAnswer(c.id, correct);
      attempts++;
    }
  });

  return model;
}

let classModels = [];
let classNames = [];

function buildClass() {
  const size = parseInt(els.classSizeSelect.value, 10);
  classModels = Array.from({ length: size }, simulateStudent);
  classNames = Array.from({ length: size }, (_, i) => pickName(i));
  renderHeatmap();
  renderClassBars();
  renderRiskList();
}

function masteryColor(pct) {
  if (pct >= 85) return "#3f5d3a";
  if (pct >= 40) return "#a9822e";
  return "#a13c2f";
}

function renderHeatmap() {
  const thead = `<thead><tr><th>Student</th>${CONCEPTS.map((c) => `<th>${c.label}</th>`).join("")}</tr></thead>`;
  const rows = classModels
    .map((model, i) => {
      const cells = CONCEPTS.map((c) => {
        const pct = Math.round(model.getMastery(c.id) * 100);
        const color = masteryColor(pct);
        return `<td class="heat-cell"><span class="cell-inner" style="background:${color}">${pct}%</span></td>`;
      }).join("");
      return `<tr><th>${classNames[i]}</th>${cells}</tr>`;
    })
    .join("");
  els.heatmapTable.innerHTML = `${thead}<tbody>${rows}</tbody>`;
}

function renderClassBars() {
  els.classBars.innerHTML = CONCEPTS.map((c) => {
    const avg = classModels.reduce((sum, m) => sum + m.getMastery(c.id), 0) / classModels.length;
    const pct = Math.round(avg * 100);
    const color = masteryColor(pct);
    return `<div class="bar-row">
      <span class="bar-label">${c.label}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
      <span class="bar-pct">${pct}%</span>
    </div>`;
  }).join("");
}

function renderRiskList() {
  const flagged = [];
  classModels.forEach((model, i) => {
    CONCEPTS.forEach((c) => {
      const tracer = model.tracers[c.id];
      const depsMet = (c.dependsOn || []).every((d) => model.tracers[d].isMastered(THRESHOLD));
      // Actively stuck: prerequisites cleared, but this concept still isn't
      // mastered despite having had attempts (attempts > 0 rules out students
      // who simply haven't reached it via the sequential simulation, though
      // with depsMet true here that's already effectively guaranteed).
      if (depsMet && !tracer.isMastered(THRESHOLD) && tracer.history.length > 0) {
        flagged.push({ name: classNames[i], concept: c.label, pct: Math.round(tracer.mastery * 100) });
      }
    });
  });
  flagged.sort((a, b) => a.pct - b.pct);

  if (flagged.length === 0) {
    els.riskList.innerHTML = `<p class="risk-empty">No students currently stuck — everyone is either mastered or hasn't reached a concept's prerequisites yet.</p>`;
    return;
  }

  els.riskList.innerHTML = flagged
    .slice(0, 15)
    .map(
      (f) => `<div class="risk-card">
        <div>
          <div class="risk-card-name">${f.name}</div>
          <div class="risk-card-detail">stuck on · ${f.concept}</div>
        </div>
        <div class="risk-card-pct">${f.pct}%</div>
      </div>`
    )
    .join("");
}
