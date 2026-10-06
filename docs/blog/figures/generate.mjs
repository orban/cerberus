/**
 * Generate blog post figures as SVGs — Tufte style.
 *
 * Principles: maximize data-ink ratio, range frames spanning data extent,
 * direct labels, serif type, no gridlines, no colored fills.
 *
 * Run: node docs/blog/figures/generate.mjs
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Tufte palette ───────────────────────────────────────────
const FONT = "Georgia, 'Times New Roman', 'DejaVu Serif', Times, serif";
const INK = "#1a1a1a";
const MUTED = "#777777";
const LIGHT = "#bbbbbb";
const ACCEPT_INK = "#2d6a2e";
const REJECT_INK = "#9e2a2a";
const NAIVE_INK = "#999999";
const WILSON_INK = "#1a1a1a";
const MINUS = "\u2212"; // proper minus sign, used everywhere

function fmt(n) { return n.toFixed(1); }

// ── Figure 1: SPRT Random Walk ──────────────────────────────

function generateSPRTWalk() {
  const W = 700, H = 410;
  const margin = { top: 30, right: 155, bottom: 60, left: 60 };
  const pw = W - margin.left - margin.right;
  const ph = H - margin.top - margin.bottom;

  // Math (blog convention: log(p0/p1) where p0=threshold=0.90, p1=alt=0.80)
  const logPass = Math.log(0.90 / 0.80);
  const logFail = Math.log(0.10 / 0.20);
  const upperBound = Math.log(0.95 / 0.20); // +1.558
  const lowerBound = Math.log(0.05 / 0.80); // -2.773

  const good = [0];
  for (let i = 1; i <= 14; i++) good.push(good[i - 1] + logPass);

  const badSeq = [true, false, false, true, false, false, false];
  const bad = [0];
  for (const s of badSeq) bad.push(bad[bad.length - 1] + (s ? logPass : logFail));

  // Scale covers data extent with padding
  const yMin = -3.5;
  const yMax = 2.0;
  const xDataMax = 14;

  const sx = (x) => margin.left + (x / xDataMax) * pw;
  const sy = (y) => margin.top + ((yMax - y) / (yMax - yMin)) * ph;

  // Y range frame: line spans exact data extent
  const dataYTop = good[14]; // 1.649
  const dataYBot = bad[7];   // -3.230
  let frame = "";
  frame += `<line x1="${margin.left}" y1="${fmt(sy(dataYTop))}" x2="${margin.left}" y2="${fmt(sy(dataYBot))}" stroke="${LIGHT}" stroke-width="1"/>`;

  // Y ticks at integers within data range
  const yTicks = [-3, -2, -1, 0, 1];
  let yLabels = "";
  for (const t of yTicks) {
    const y = sy(t);
    frame += `<line x1="${margin.left - 5}" y1="${fmt(y)}" x2="${margin.left}" y2="${fmt(y)}" stroke="${LIGHT}" stroke-width="1"/>`;
    const label = t < 0 ? `${MINUS}${Math.abs(t)}` : String(t);
    yLabels += `<text x="${margin.left - 8}" y="${fmt(y + 4)}" text-anchor="end" font-family="${FONT}" font-size="11" fill="${MUTED}">${label}</text>`;
  }

  // X range frame: 0 to 14
  const xTicks = [0, 2, 4, 6, 8, 10, 12, 14];
  const xAxisY = H - margin.bottom;
  frame += `<line x1="${fmt(sx(0))}" y1="${xAxisY}" x2="${fmt(sx(14))}" y2="${xAxisY}" stroke="${LIGHT}" stroke-width="1"/>`;

  let xLabels = "";
  for (const t of xTicks) {
    frame += `<line x1="${fmt(sx(t))}" y1="${xAxisY}" x2="${fmt(sx(t))}" y2="${xAxisY + 5}" stroke="${LIGHT}" stroke-width="1"/>`;
    xLabels += `<text x="${fmt(sx(t))}" y="${xAxisY + 18}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${MUTED}">${t}</text>`;
  }

  // Zero reference — full axis, barely visible
  const zeroLine = `<line x1="${fmt(sx(0))}" y1="${fmt(sy(0))}" x2="${fmt(sx(14))}" y2="${fmt(sy(0))}" stroke="${LIGHT}" stroke-width="0.5"/>`;

  // Boundary lines — span full x-axis so they read as constant thresholds
  const boundaryLines = `<line x1="${fmt(sx(0))}" y1="${fmt(sy(upperBound))}" x2="${fmt(sx(14))}" y2="${fmt(sy(upperBound))}" stroke="${ACCEPT_INK}" stroke-width="0.75" stroke-dasharray="4,3" opacity="0.5"/>
  <line x1="${fmt(sx(0))}" y1="${fmt(sy(lowerBound))}" x2="${fmt(sx(14))}" y2="${fmt(sy(lowerBound))}" stroke="${REJECT_INK}" stroke-width="0.75" stroke-dasharray="4,3" opacity="0.5"/>`;

  // Boundary annotations — on the y-axis side as colored marginal notes
  // (keeps right margin clear for endpoint labels)
  const boundaryNotes = [
    `<line x1="${margin.left - 5}" y1="${fmt(sy(upperBound))}" x2="${margin.left}" y2="${fmt(sy(upperBound))}" stroke="${ACCEPT_INK}" stroke-width="1"/>`,
    `<text x="${margin.left - 8}" y="${fmt(sy(upperBound) + 4)}" text-anchor="end" font-family="${FONT}" font-size="10" fill="${ACCEPT_INK}" font-style="italic">1.56</text>`,
    `<line x1="${margin.left - 5}" y1="${fmt(sy(lowerBound))}" x2="${margin.left}" y2="${fmt(sy(lowerBound))}" stroke="${REJECT_INK}" stroke-width="1"/>`,
    `<text x="${margin.left - 8}" y="${fmt(sy(lowerBound) - 3)}" text-anchor="end" font-family="${FONT}" font-size="10" fill="${REJECT_INK}" font-style="italic">${MINUS}2.77</text>`,
  ].join("\n  ");

  // Paths — draw red first, then green (green covers shared trial 0-1 segment)
  const badPath = bad.map((y, i) => `${i === 0 ? "M" : "L"}${fmt(sx(i))},${fmt(sy(y))}`).join(" ");
  const goodPath = good.map((y, i) => `${i === 0 ? "M" : "L"}${fmt(sx(i))},${fmt(sy(y))}`).join(" ");

  // Small intermediate dots show discrete trial results
  let badDots = "";
  for (let i = 1; i < 7; i++) {
    badDots += `<circle cx="${fmt(sx(i))}" cy="${fmt(sy(bad[i]))}" r="1.5" fill="${REJECT_INK}"/>`;
  }
  let goodDots = "";
  for (let i = 1; i < 14; i++) {
    goodDots += `<circle cx="${fmt(sx(i))}" cy="${fmt(sy(good[i]))}" r="1.5" fill="${ACCEPT_INK}"/>`;
  }

  // Terminal + origin dots
  const origin = `<circle cx="${fmt(sx(0))}" cy="${fmt(sy(0))}" r="2.5" fill="${INK}"/>`;
  const goodEnd = `<circle cx="${fmt(sx(14))}" cy="${fmt(sy(good[14]))}" r="3.5" fill="${ACCEPT_INK}"/>`;
  const badEnd = `<circle cx="${fmt(sx(7))}" cy="${fmt(sy(bad[7]))}" r="3.5" fill="${REJECT_INK}"/>`;

  // Labels — Georgia throughout, outcome + identity
  const goodLabel = `<text x="${fmt(sx(14) + 8)}" y="${fmt(sy(good[14]) - 4)}" font-family="${FONT}" font-size="13" fill="${ACCEPT_INK}" font-weight="700">ACCEPT</text>
  <text x="${fmt(sx(14) + 8)}" y="${fmt(sy(good[14]) + 10)}" font-family="${FONT}" font-size="10" fill="${MUTED}" font-style="italic">Good agent, 14 trials</text>`;

  const badLabel = `<text x="${fmt(sx(7) + 8)}" y="${fmt(sy(bad[7]) - 4)}" font-family="${FONT}" font-size="13" fill="${REJECT_INK}" font-weight="700">REJECT</text>
  <text x="${fmt(sx(7) + 8)}" y="${fmt(sy(bad[7]) + 10)}" font-family="${FONT}" font-size="10" fill="${MUTED}" font-style="italic">Bad agent, 7 trials</text>`;

  // Axis titles — centered on range frame, not plot width
  const xCenter = (sx(0) + sx(14)) / 2;
  const yCenter = margin.top + ph / 2;
  const xTitle = `<text x="${fmt(xCenter)}" y="${H - 8}" text-anchor="middle" font-family="${FONT}" font-size="12" fill="${MUTED}">Trial number</text>`;
  const yTitle = `<text x="14" y="${fmt(yCenter)}" text-anchor="middle" font-family="${FONT}" font-size="12" fill="${MUTED}" transform="rotate(-90, 14, ${fmt(yCenter)})">Log-likelihood ratio</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  ${frame}
  ${zeroLine}
  ${boundaryLines}
  ${boundaryNotes}
  <path d="${badPath}" fill="none" stroke="${REJECT_INK}" stroke-width="1.8" stroke-linejoin="round"/>
  <path d="${goodPath}" fill="none" stroke="${ACCEPT_INK}" stroke-width="1.8" stroke-linejoin="round"/>
  ${badDots}
  ${goodDots}
  ${origin}
  ${goodEnd}
  ${badEnd}
  ${goodLabel}
  ${badLabel}
  ${yLabels}
  ${xLabels}
  ${xTitle}
  ${yTitle}
</svg>`;
}

// ── Figure 2: P(failure) vs test count ──────────────────────

function generateFailureProbability() {
  const W = 700, H = 390;
  const margin = { top: 45, right: 50, bottom: 58, left: 60 };
  const pw = W - margin.left - margin.right;
  const ph = H - margin.top - margin.bottom;

  const xMax = 30;
  const sx = (x) => margin.left + (x / xMax) * pw;
  const sy = (y) => margin.top + ((1 - y) / 1) * ph;

  // Curve — starts at the origin (n=0, prob=0)
  const points = [{ n: 0, prob: 0 }];
  for (let n = 0.5; n <= 30; n += 0.5) {
    points.push({ n, prob: 1 - Math.pow(0.9, n) });
  }
  const curvePath = points.map(({ n, prob }, i) =>
    `${i === 0 ? "M" : "L"}${fmt(sx(n))},${fmt(sy(prob))}`
  ).join(" ");

  const lastProb = points[points.length - 1].prob; // ~0.958

  // Y range frame: from 0% to data max (~95.8%)
  let frame = "";
  frame += `<line x1="${margin.left}" y1="${fmt(sy(lastProb))}" x2="${margin.left}" y2="${fmt(sy(0))}" stroke="${LIGHT}" stroke-width="1"/>`;

  // Y ticks: 0% through 80% (all within data range; 100% is above data)
  const yTicks = [0, 0.2, 0.4, 0.6, 0.8];
  let yLabels = "";
  for (const t of yTicks) {
    const y = sy(t);
    frame += `<line x1="${margin.left - 5}" y1="${fmt(y)}" x2="${margin.left}" y2="${fmt(y)}" stroke="${LIGHT}" stroke-width="1"/>`;
    yLabels += `<text x="${margin.left - 8}" y="${fmt(y + 4)}" text-anchor="end" font-family="${FONT}" font-size="11" fill="${MUTED}">${Math.round(t * 100)}%</text>`;
  }

  // X range frame: 0 to 30
  const xAxisY = sy(0);
  frame += `<line x1="${fmt(sx(0))}" y1="${fmt(xAxisY)}" x2="${fmt(sx(30))}" y2="${fmt(xAxisY)}" stroke="${LIGHT}" stroke-width="1"/>`;

  // X ticks — skip 10 and 20 (handled by drop-line annotations)
  const xTickValues = [0, 5, 15, 25, 30];
  let xLabels = "";
  for (const t of xTickValues) {
    frame += `<line x1="${fmt(sx(t))}" y1="${fmt(xAxisY)}" x2="${fmt(sx(t))}" y2="${fmt(xAxisY + 5)}" stroke="${LIGHT}" stroke-width="1"/>`;
    xLabels += `<text x="${fmt(sx(t))}" y="${fmt(xAxisY + 18)}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${MUTED}">${t}</text>`;
  }

  // Annotated data points with drop lines
  const p10 = 1 - Math.pow(0.9, 10);
  const p20 = 1 - Math.pow(0.9, 20);

  function makeAnnotation(n, prob, label) {
    const x = sx(n);
    const yPt = sy(prob);
    return [
      `<line x1="${fmt(x)}" y1="${fmt(yPt)}" x2="${fmt(x)}" y2="${fmt(xAxisY)}" stroke="${MUTED}" stroke-width="0.5" stroke-dasharray="3,3"/>`,
      `<line x1="${fmt(x)}" y1="${fmt(xAxisY)}" x2="${fmt(x)}" y2="${fmt(xAxisY + 5)}" stroke="${LIGHT}" stroke-width="1"/>`,
      `<circle cx="${fmt(x)}" cy="${fmt(yPt)}" r="3.5" fill="${INK}" stroke="#ffffff" stroke-width="1.5"/>`,
      `<text x="${fmt(x)}" y="${fmt(yPt - 14)}" text-anchor="middle" font-family="${FONT}" font-size="12" fill="${INK}" font-weight="600">${label}</text>`,
      `<text x="${fmt(x)}" y="${fmt(xAxisY + 18)}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${MUTED}">${n}</text>`,
    ].join("\n  ");
  }

  const annotations = [
    makeAnnotation(10, p10, "65%"),
    makeAnnotation(20, p20, "88%"),
  ].join("\n  ");

  // End-of-line note — right-aligned to avoid clipping
  const endNote = `<text x="${W - 8}" y="${fmt(sy(lastProb) - 6)}" text-anchor="end" font-family="${FONT}" font-size="10" fill="${MUTED}" font-style="italic">each test at p = 0.90</text>`;

  // Subtitle
  const subtitle = `<text x="${fmt((sx(0) + sx(30)) / 2)}" y="${margin.top - 15}" text-anchor="middle" font-family="${FONT}" font-size="12" fill="${MUTED}" font-style="italic">A 90% pass rate almost guarantees at least one failure</text>`;

  // Axis titles
  const xCenter = (sx(0) + sx(30)) / 2;
  const yCenter = margin.top + ph / 2;
  const xTitle = `<text x="${fmt(xCenter)}" y="${H - 8}" text-anchor="middle" font-family="${FONT}" font-size="12" fill="${MUTED}">Number of test cases</text>`;
  const yTitle = `<text x="14" y="${fmt(yCenter)}" text-anchor="middle" font-family="${FONT}" font-size="12" fill="${MUTED}" transform="rotate(-90, 14, ${fmt(yCenter)})">P(at least one failure)</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  ${subtitle}
  ${frame}
  <path d="${curvePath}" fill="none" stroke="${INK}" stroke-width="1.5"/>
  ${annotations}
  ${endNote}
  ${yLabels}
  ${xLabels}
  ${xTitle}
  ${yTitle}
</svg>`;
}

// ── Figure 3: Wilson vs Naive CI ────────────────────────────
// Both intervals overlaid on the SAME horizontal line per observation.
// Naive: thin dashed gray, offset 5px above center.
// Wilson: thick solid dark, offset 5px below center.
// This makes the width difference instantly visible.
// Legend at top; block labels on left.

function generateWilsonComparison() {
  const W = 700, H = 420;
  const margin = { top: 50, right: 30, bottom: 50, left: 95 };
  const pw = W - margin.left - margin.right;
  const ph = H - margin.top - margin.bottom;

  const z = 1.96;
  const z2 = z * z;

  function wilsonCI(k, n) {
    const phat = k / n;
    const denom = 1 + z2 / n;
    const center = (phat + z2 / (2 * n)) / denom;
    const spread = (z * Math.sqrt(phat * (1 - phat) / n + z2 / (4 * n * n))) / denom;
    return [Math.max(0, center - spread), Math.min(1, center + spread)];
  }

  function naiveCI(k, n) {
    const phat = k / n;
    const se = Math.sqrt(phat * (1 - phat) / n);
    return [Math.max(0, phat - z * se), Math.min(1, phat + z * se)];
  }

  const data = [
    { label: "0 / 10",   k: 0,  n: 10 },
    { label: "9 / 10",   k: 9,  n: 10 },
    { label: "10 / 10",  k: 10, n: 10 },
    { label: "45 / 50",  k: 45, n: 50 },
    { label: "90 / 100", k: 90, n: 100 },
  ];

  const rowH = ph / data.length; // ~64px per row
  const yOff = 6; // naive above, wilson below center
  const sx = (x) => margin.left + x * pw;
  const rowCenter = (i) => margin.top + i * rowH + rowH / 2;

  // Legend — top center, compact
  const legendY = 28;
  const legend = [
    `<line x1="220" y1="${legendY}" x2="260" y2="${legendY}" stroke="${NAIVE_INK}" stroke-width="1.5" stroke-dasharray="4,3"/>`,
    `<circle cx="240" cy="${legendY}" r="2" fill="${NAIVE_INK}"/>`,
    `<text x="266" y="${legendY + 4}" font-family="${FONT}" font-size="11" fill="${NAIVE_INK}">Naive (Wald)</text>`,
    `<line x1="380" y1="${legendY}" x2="420" y2="${legendY}" stroke="${WILSON_INK}" stroke-width="2"/>`,
    `<circle cx="400" cy="${legendY}" r="2.5" fill="${WILSON_INK}"/>`,
    `<text x="426" y="${legendY + 4}" font-family="${FONT}" font-size="11" fill="${WILSON_INK}">Wilson score</text>`,
  ].join("\n  ");

  // X range frame
  const xTicks = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
  const xBaseline = H - margin.bottom;
  let frame = "";
  frame += `<line x1="${fmt(sx(0))}" y1="${xBaseline}" x2="${fmt(sx(1))}" y2="${xBaseline}" stroke="${LIGHT}" stroke-width="1"/>`;
  let xLabels = "";
  for (const t of xTicks) {
    const x = sx(t);
    frame += `<line x1="${fmt(x)}" y1="${xBaseline}" x2="${fmt(x)}" y2="${xBaseline + 5}" stroke="${LIGHT}" stroke-width="1"/>`;
    xLabels += `<text x="${fmt(x)}" y="${xBaseline + 18}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${MUTED}">${Math.round(t * 100)}%</text>`;
  }

  // Row separators
  let separators = "";
  for (let i = 1; i < data.length; i++) {
    const sepY = margin.top + i * rowH;
    separators += `<line x1="${margin.left}" y1="${fmt(sepY)}" x2="${fmt(sx(1))}" y2="${fmt(sepY)}" stroke="${LIGHT}" stroke-width="0.5"/>`;
  }

  let rows = "";
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    const phat = d.k / d.n;
    const naive = naiveCI(d.k, d.n);
    const wilson = wilsonCI(d.k, d.n);
    const isDegenerate = (naive[1] - naive[0]) < 0.001;
    const cy = rowCenter(i);

    // Block label — left margin
    rows += `<text x="${margin.left - 10}" y="${fmt(cy + 5)}" text-anchor="end" font-family="${FONT}" font-size="12" fill="${INK}">${d.label}</text>`;

    // ── Naive interval (above center) ──
    const ny = cy - yOff;
    if (isDegenerate) {
      // Point estimate only — open circle to signal "something's wrong"
      const dotX = sx(phat);
      rows += `<circle cx="${fmt(dotX)}" cy="${fmt(ny)}" r="3" fill="none" stroke="${NAIVE_INK}" stroke-width="1.5"/>`;
      rows += `<circle cx="${fmt(dotX)}" cy="${fmt(ny)}" r="0.8" fill="${NAIVE_INK}"/>`;
      // Annotation — offset to avoid collision with Wilson below
      const annotX = phat < 0.5 ? dotX + 8 : dotX - 8;
      const anchor = phat < 0.5 ? "start" : "end";
      rows += `<text x="${fmt(annotX)}" y="${fmt(ny - 5)}" text-anchor="${anchor}" font-family="${FONT}" font-size="9" fill="${NAIVE_INK}" font-style="italic">zero-width CI</text>`;
    } else {
      rows += `<line x1="${fmt(sx(naive[0]))}" y1="${fmt(ny)}" x2="${fmt(sx(naive[1]))}" y2="${fmt(ny)}" stroke="${NAIVE_INK}" stroke-width="1.5" stroke-dasharray="4,3"/>`;
      rows += `<line x1="${fmt(sx(naive[0]))}" y1="${fmt(ny - 4)}" x2="${fmt(sx(naive[0]))}" y2="${fmt(ny + 4)}" stroke="${NAIVE_INK}" stroke-width="1"/>`;
      if (naive[1] < 0.999) {
        rows += `<line x1="${fmt(sx(naive[1]))}" y1="${fmt(ny - 4)}" x2="${fmt(sx(naive[1]))}" y2="${fmt(ny + 4)}" stroke="${NAIVE_INK}" stroke-width="1"/>`;
      }
      rows += `<circle cx="${fmt(sx(phat))}" cy="${fmt(ny)}" r="2" fill="${NAIVE_INK}"/>`;
    }

    // ── Wilson interval (below center) ──
    const wy = cy + yOff;
    rows += `<line x1="${fmt(sx(wilson[0]))}" y1="${fmt(wy)}" x2="${fmt(sx(wilson[1]))}" y2="${fmt(wy)}" stroke="${WILSON_INK}" stroke-width="2"/>`;
    rows += `<line x1="${fmt(sx(wilson[0]))}" y1="${fmt(wy - 4)}" x2="${fmt(sx(wilson[0]))}" y2="${fmt(wy + 4)}" stroke="${WILSON_INK}" stroke-width="1"/>`;
    if (wilson[1] < 0.999) {
      rows += `<line x1="${fmt(sx(wilson[1]))}" y1="${fmt(wy - 4)}" x2="${fmt(sx(wilson[1]))}" y2="${fmt(wy + 4)}" stroke="${WILSON_INK}" stroke-width="1"/>`;
    }
    rows += `<circle cx="${fmt(sx(phat))}" cy="${fmt(wy)}" r="2.5" fill="${WILSON_INK}"/>`;
  }

  // X axis title
  const xCenter = (sx(0) + sx(1)) / 2;
  const xTitle = `<text x="${fmt(xCenter)}" y="${H - 10}" text-anchor="middle" font-family="${FONT}" font-size="12" fill="${MUTED}">Pass rate</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  ${legend}
  ${separators}
  ${frame}
  ${rows}
  ${xLabels}
  ${xTitle}
</svg>`;
}

// ── Write files ─────────────────────────────────────────────

const figures = [
  { name: "sprt-random-walk.svg", fn: generateSPRTWalk },
  { name: "failure-probability.svg", fn: generateFailureProbability },
  { name: "wilson-vs-naive.svg", fn: generateWilsonComparison },
];

for (const { name, fn } of figures) {
  const outPath = join(__dirname, name);
  writeFileSync(outPath, fn());
  console.log(`wrote ${name}`);
}
