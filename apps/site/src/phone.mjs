// The animated phone in "Hoe het werkt": seven scenes of the Android app, drawn as one inline SVG.
// app.js shows one scene at a time (class is-active); styles.css does the motion and turns it off
// for prefers-reduced-motion. Every colour comes from CSS classes (no style attributes, for the CSP).
import { esc } from "./html.mjs";

const W = 280;
const H = 560;

const text = (x, y, value, cls = "ph-text", extra = "") =>
  `<text x="${x}" y="${y}" class="${cls}"${extra}>${esc(value)}</text>`;
const lines = (x, y, values, cls, step = 20) =>
  `<text class="${cls}">${values.map((v, i) => `<tspan x="${x}" y="${y + i * step}">${esc(v)}</tspan>`).join("")}</text>`;
const button = (x, y, w, h, label, cls = "ph-btn") =>
  `<g class="${cls}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/>${text(x + w / 2, y + h / 2 + 5, label, "ph-btn-label", ' text-anchor="middle"')}</g>`;

function stepBar(s, active, names = s.stepNames) {
  const w = 52;
  return names
    .map((name, i) => {
      const x = 30 + i * (w + 4);
      const on = i <= active ? " is-on" : "";
      const cur = i === active ? " is-current" : "";
      return `<rect x="${x}" y="92" width="${w}" height="5" rx="2.5" class="ph-track${on}"/>${text(x + w / 2, 114, name, `ph-step${cur}`, ' text-anchor="middle"')}`;
    })
    .join("");
}

// First run only: gemeente, school, jaar, richting, one question per screen. Shown here at the jaar question.
function sceneSchool(s) {
  const [a, b, c, d] = s.years;
  return `
    ${stepBar(s, 2, s.setupSteps)}
    ${lines(30, 146, s.welcome, "ph-small ph-muted", 18)}
    ${text(30, 202, s.yearQuestion, "ph-title")}
    ${button(30, 222, 104, 50, a, "ph-btn ph-btn--ghost ph-pick")}
    ${button(146, 222, 104, 50, b, "ph-btn ph-btn--ghost")}
    ${button(30, 284, 104, 50, c, "ph-btn ph-btn--ghost")}
    ${button(146, 284, 104, 50, d, "ph-btn ph-btn--ghost")}
    <circle cx="82" cy="247" r="16" class="ph-tap"/>`;
}

// Home: the student's own vakken; vakken without missions are listed under "Binnenkort".
function sceneCourse(s) {
  const buttons = s.courses
    .map((label, i) => button(30, 164 + i * 54, 220, 44, label, `ph-btn ph-btn--ghost${i === 0 ? " ph-pick" : ""}`))
    .join("");
  return `
    ${lines(30, 118, s.whatNow, "ph-title", 24)}
    ${buttons}
    <circle cx="200" cy="186" r="16" class="ph-tap"/>
    <rect x="22" y="334" width="236" height="70" rx="16" class="ph-card"/>
    ${text(40, 362, s.soonLabel, "ph-small ph-muted")}
    ${text(40, 386, s.soon, "ph-text")}`;
}

// Time picker for the chosen vak; the picked mission rises in after the tap.
function sceneTime(s) {
  const [a, b, c, d] = s.minutes;
  return `
    ${text(30, 96, s.subject, "ph-small ph-muted")}
    ${lines(30, 122, s.howMuch, "ph-title", 24)}
    ${button(30, 162, 104, 44, a, "ph-btn ph-btn--ghost")}
    ${button(146, 162, 104, 44, b, "ph-btn ph-btn--ghost ph-pick")}
    ${button(30, 216, 104, 44, c, "ph-btn ph-btn--ghost")}
    ${button(146, 216, 104, 44, d, "ph-btn ph-btn--ghost")}
    <circle cx="198" cy="184" r="16" class="ph-tap"/>
    <g class="ph-rise ph-rise--late">
      <rect x="22" y="276" width="236" height="160" rx="16" class="ph-card"/>
      ${lines(40, 308, s.missionTitle, "ph-title", 24)}
      ${text(40, 362, s.missionMeta, "ph-small ph-muted")}
      ${button(40, 376, 200, 44, s.start)}
    </g>`;
}

function scene3(s) {
  return `
    ${stepBar(s, 1)}
    <g class="ph-rise">
      <rect x="22" y="134" width="236" height="250" rx="16" class="ph-card"/>
      ${lines(40, 168, s.learnText, "ph-text", 24)}
      ${button(40, 276, 200, 42, `▶ ${s.readAloud}`, "ph-btn ph-btn--ghost")}
      ${button(40, 326, 200, 42, s.next)}
    </g>`;
}

function scene4(s) {
  // Slots on top, tiles start scrambled below and move into their slot one by one.
  const slots = s.tiles
    .map((_, i) => `<rect x="40" y="${172 + i * 46}" width="200" height="38" rx="10" class="ph-slot"/>${text(50, 196 + i * 46, `${i + 1}.`, "ph-small ph-muted")}`)
    .join("");
  const start = [
    [150, 382],
    [40, 428],
    [40, 382],
    [150, 428],
  ];
  const tiles = s.tiles
    .map((label, i) => {
      const [x, y] = start[[2, 0, 3, 1][i]];
      return `<g class="ph-tile ph-tile--${i + 1}"><rect x="${x}" y="${y}" width="${i === 2 ? 100 : 90}" height="38" rx="10"/>${text(x + 12, y + 24, label, "ph-tile-label")}</g>`;
    })
    .join("");
  return `
    ${stepBar(s, 2)}
    ${lines(30, 140, s.orderPrompt, "ph-text ph-bold", 20)}
    ${slots}
    ${tiles}`;
}

function scene5(s) {
  return `
    ${stepBar(s, 3)}
    <g class="ph-rise">
      <rect x="22" y="134" width="236" height="250" rx="16" class="ph-feedback"/>
      <circle cx="52" cy="170" r="14" class="ph-check-bg"/>
      <path d="M45 170l5 5 9-10" class="ph-check"/>
      ${text(76, 177, s.right, "ph-big")}
      ${lines(40, 214, s.rightText, "ph-text ph-small", 22)}
      ${button(40, 318, 200, 44, s.next)}
    </g>`;
}

function scene6(s) {
  return `
    <g class="ph-rise">
      ${text(30, 120, s.done, "ph-big")}
      ${text(30, 150, s.score, "ph-text")}
      <rect x="22" y="170" width="236" height="120" rx="16" class="ph-card"/>
      ${text(40, 202, s.today, "ph-text ph-bold")}
      <rect x="40" y="218" width="200" height="8" rx="4" class="ph-slot-fill"/>
      <rect x="40" y="218" width="60" height="8" rx="4" class="ph-grow"/>
      ${lines(40, 252, s.review, "ph-small ph-muted", 18)}
      ${button(30, 310, 220, 46, s.home)}
    </g>`;
}

const SCENES = [sceneSchool, sceneCourse, sceneTime, scene3, scene4, scene5, scene6];

export function phone(t) {
  const s = t.flow.screen;
  const scenes = SCENES.map(
    (draw, i) => `<g class="scene${i === 0 ? " is-active" : ""}" data-scene="${i}">${draw(s)}</g>`,
  ).join("");
  return `<svg class="phone" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="phone-title" focusable="false">
  <title id="phone-title">${esc(t.flow.title)}</title>
  <rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="38" class="ph-frame"/>
  <rect x="14" y="14" width="${W - 28}" height="${H - 28}" rx="28" class="ph-screen"/>
  <path d="M14 42a28 28 0 0 1 28-28h196a28 28 0 0 1 28 28v28H14z" class="ph-bar"/>
  <g transform="translate(30 30) scale(0.4)">${logoMark()}</g>
  ${text(64, 54, s.app, "ph-bar-title")}
  ${scenes}
  <rect x="110" y="528" width="60" height="5" rx="2.5" class="ph-home"/>
</svg>`;
}

/** The Breinhap mark (public/logo.svg) as inline SVG, recoloured by CSS (.bh-body, .bh-lines, .bh-crumbs). */
export function logoMark(id = "bh-bite") {
  return `<defs><mask id="${id}"><rect width="64" height="64" fill="#fff"/><circle cx="44.5" cy="7" r="5.2" fill="#000"/><circle cx="50.5" cy="14.5" r="5.2" fill="#000"/><circle cx="58" cy="20" r="5.2" fill="#000"/><circle cx="57" cy="7" r="9" fill="#000"/></mask></defs>
<g mask="url(#${id})"><g class="bh-body"><circle cx="17" cy="28" r="11"/><circle cx="26" cy="18" r="11"/><circle cx="39" cy="16" r="11"/><circle cx="49" cy="25" r="10"/><circle cx="14" cy="38" r="9"/><circle cx="27" cy="36" r="13"/><circle cx="43" cy="34" r="11"/><circle cx="47" cy="44" r="7"/><rect x="34" y="42" width="8" height="12" rx="4"/></g>
<g class="bh-lines" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 27c4-4 8 0 12-3"/><path d="M23 13c1 4 5 4 6 8"/><path d="M35 11c-1 4 3 6 2 10"/><path d="M12 37c4 2 8-2 12 0"/><path d="M27 30c3 3 7 0 10 3s6 0 9 2"/><path d="M22 45c3-2 6 1 9-1"/><path d="M43 41c2 2 4 2 6 4"/></g></g>
<g class="bh-crumbs"><circle cx="61" cy="30.5" r="1.9"/><circle cx="58.5" cy="35.5" r="1.2"/></g>`;
}
