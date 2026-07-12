/**
 * explainer.js — drives the live BKT simulator on how-it-works.html.
 *
 * Uses the exact same ConceptTracer class from bkt.js that powers real
 * lessons in app.js — this isn't a re-implementation for demo purposes,
 * it's the production tracer with sliders wired to its constructor params.
 */

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  [
    "sInit", "sLearn", "sSlip", "sGuess",
    "valPInit", "valPLearn", "valPSlip", "valPGuess",
    "simPct", "simStatus", "simSpark", "simHistory",
    "btnCorrect", "btnIncorrect", "btnReset",
  ].forEach((id) => (els[id] = document.getElementById(id)));

  bindSliders();
  bindButtons();
  resetTracer();
});

let tracer = null;

function currentParams() {
  return {
    pInit: parseFloat(els.sInit.value),
    pLearn: parseFloat(els.sLearn.value),
    pSlip: parseFloat(els.sSlip.value),
    pGuess: parseFloat(els.sGuess.value),
  };
}

function bindSliders() {
  const pairs = [
    ["sInit", "valPInit"],
    ["sLearn", "valPLearn"],
    ["sSlip", "valPSlip"],
    ["sGuess", "valPGuess"],
  ];
  pairs.forEach(([sliderId, labelId]) => {
    els[sliderId].addEventListener("input", () => {
      els[labelId].textContent = parseFloat(els[sliderId].value).toFixed(2);
      // Changing a parameter starts a fresh tracer — mixing params mid-history
      // wouldn't reflect a real single-student model.
      resetTracer();
    });
  });
}

function bindButtons() {
  els.btnCorrect.addEventListener("click", () => observe(true));
  els.btnIncorrect.addEventListener("click", () => observe(false));
  els.btnReset.addEventListener("click", resetTracer);
}

function resetTracer() {
  tracer = new ConceptTracer(currentParams());
  render();
}

function observe(correct) {
  tracer.observe(correct);
  render();
}

function render() {
  const pct = Math.round(tracer.mastery * 100);
  els.simPct.textContent = pct;
  const mastered = tracer.isMastered();
  els.simStatus.textContent = mastered ? "Mastered (≥ 90%)" : "Not yet mastered";
  els.simStatus.classList.toggle("mastered", mastered);
  renderSpark();
  renderHistory();
}

function renderSpark() {
  const points = [tracer.pInit, ...tracer.history.map((h) => h.masteryAfter)];
  const w = 400, h = 90, pad = 6;
  const n = points.length;
  const x = (i) => (n === 1 ? w / 2 : pad + (i / (n - 1)) * (w - pad * 2));
  const y = (v) => h - pad - v * (h - pad * 2);

  const thresholdY = y(0.9).toFixed(1);
  let svg = `<line x1="0" y1="${thresholdY}" x2="${w}" y2="${thresholdY}" stroke="#a6a191" stroke-width="1" stroke-dasharray="4,4" />`;

  if (n === 1) {
    svg += `<circle cx="${x(0)}" cy="${y(points[0]).toFixed(1)}" r="4" fill="#3f5d3a" />`;
  } else {
    const path = points.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    svg += `<path d="${path}" fill="none" stroke="#3f5d3a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`;
    points.forEach((v, i) => {
      const correct = i > 0 ? tracer.history[i - 1].correct : null;
      const color = correct === null ? "#3f5d3a" : correct ? "#3f5d3a" : "#a13c2f";
      svg += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.5" fill="${color}" />`;
    });
  }
  els.simSpark.innerHTML = svg;
}

function renderHistory() {
  if (tracer.history.length === 0) {
    els.simHistory.innerHTML = `<span class="sim-history-chip">no attempts yet — try one above</span>`;
    return;
  }
  els.simHistory.innerHTML = tracer.history
    .map((h, i) => {
      const pct = Math.round(h.masteryAfter * 100);
      return `<span class="sim-history-chip ${h.correct ? "correct" : "incorrect"}">#${i + 1} ${h.correct ? "correct" : "incorrect"} → ${pct}%</span>`;
    })
    .join("");
}
