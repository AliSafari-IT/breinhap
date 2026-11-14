/*
 * The home page's example mission (breinhap#114). It plays one reviewed mission in the browser, in the fixed
 * Opwarmen → Leren → Doen → Check order, one card or question per screen. Nothing is sent, stored or tracked: no
 * request, no cookie, no storage. Closing or reloading the page ends the run. The mission and the interface text
 * are embedded in the page as JSON, so the strict CSP (no inline script, connect-src management only) still holds.
 * The rules mirror packages/content mission.ts: the answer key decides, never a model.
 */
(function (root) {
  var STEPS = ["Opwarmen", "Leren", "Doen", "Check"];

  function pages(mission) {
    var out = [{ step: "Opwarmen", kind: "card", card: mission.warmup }];
    mission.learn.forEach(function (card) { out.push({ step: "Leren", kind: "card", card: card }); });
    mission.practice.forEach(function (q) { out.push({ step: "Doen", kind: "question", question: q }); });
    mission.check.forEach(function (q) { out.push({ step: "Check", kind: "question", question: q }); });
    return out;
  }

  /** Deterministic: a chosen option equals the answer key, or every item sits in the stored order. */
  function isCorrect(question, answer) {
    if (!answer) return false;
    if (question.kind === "choice") return answer.chosen === question.answerIndex;
    return answer.placed.length === question.items.length && question.items.every(function (item, i) { return answer.placed[i] === item; });
  }

  /** A stable shuffle for display only (never the stored order), so the answer is not the list as shown. */
  function shuffled(items) {
    var out = items.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    if (out.length > 1 && out.every(function (item, i) { return item === items[i]; })) out.push(out.shift());
    return out;
  }

  function fill(text, values) {
    return text.replace(/\{(\w+)\}/g, function (_, key) { return String(values[key]); });
  }

  root.BreinhapExample = { STEPS: STEPS, pages: pages, isCorrect: isCorrect, shuffled: shuffled, fill: fill };

  if (typeof document === "undefined") return;

  var mount = document.querySelector("[data-example]");
  var data = document.getElementById("example-data");
  if (!mount || !data) return;
  var payload;
  try { payload = JSON.parse(data.textContent); } catch (e) { return; }
  var ui = payload.ui;
  var mission = payload.mission;
  var list = pages(mission);
  var state = { index: 0, answers: {}, started: false };

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === "text") node.textContent = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }
  function button(label, onClick, kind) {
    var b = el("button", { type: "button", class: "ex-button" + (kind ? " " + kind : ""), text: label });
    b.addEventListener("click", onClick);
    return b;
  }
  function content(tag, text, attrs) {
    // The mission text is Dutch; label it so screen readers pronounce it right on the other languages' pages.
    var a = attrs || {};
    a.text = text;
    if (ui.lang !== "nl") a.lang = "nl";
    return el(tag, a);
  }

  var panel = el("div", { class: "ex-panel", "aria-live": "polite" });
  mount.appendChild(panel);

  function show(nodes, focusNode) {
    panel.textContent = "";
    nodes.forEach(function (n) { panel.appendChild(n); });
    var target = focusNode || panel.querySelector("[data-focus]");
    if (target) { target.setAttribute("tabindex", "-1"); target.focus({ preventScroll: false }); }
  }

  function stepList(current) {
    return el("ol", { class: "ex-steps", "aria-label": ui.stepsLabel }, STEPS.map(function (step) {
      var li = el("li", { text: ui.steps[step] });
      if (step === current) li.setAttribute("aria-current", "step");
      return li;
    }));
  }
  function header(page) {
    var n = state.index + 1;
    var parts = [el("p", { class: "ex-count", text: mission.title + " · " + fill(ui.count, { n: n, total: list.length }) })];
    if (state.index === list.length - 1) parts.push(el("p", { class: "ex-count", text: ui.lastQuestion }));
    return [stepList(page.step)].concat(parts);
  }

  function intro() {
    show([
      el("h3", { text: ui.introTitle, "data-focus": "" }),
      content("p", mission.title, { class: "ex-mission" }),
      el("p", { class: "ex-note", text: ui.introNote }),
      button(ui.start, function () { state = { index: 0, answers: {}, started: true }; render(); })
    ]);
  }

  function next() { state.index += 1; render(); }

  function render() {
    if (!state.started) return intro();
    if (state.index >= list.length) return done();
    var page = list[state.index];
    var nodes = header(page);
    if (page.kind === "card") {
      nodes.push(content("p", page.card.text, { class: "ex-text", "data-focus": "" }));
      if (page.card.example) nodes.push(content("p", ui.example + " " + page.card.example, { class: "ex-example" }));
      nodes.push(button(ui.next, next));
      return show(nodes);
    }
    var q = page.question;
    nodes.push(content("p", q.prompt, { class: "ex-text", "data-focus": "" }));
    var answered = state.answers[state.index];
    if (q.kind === "choice") choice(nodes, q, answered);
    else order(nodes, q, answered);
    show(nodes, answered ? null : panel.querySelector("[data-focus]"));
    if (answered) { var fb = panel.querySelector("[data-feedback]"); if (fb) { fb.setAttribute("tabindex", "-1"); fb.focus(); } }
  }

  function feedback(nodes, q, answer) {
    var ok = isCorrect(q, answer);
    nodes.push(el("div", { class: "ex-feedback " + (ok ? "ok" : "no"), "data-feedback": "" }, [
      el("strong", { text: ok ? ui.right : ui.notYet }),
      content("p", q.explanation, {})
    ]));
    nodes.push(button(state.index === list.length - 1 ? ui.finish : ui.next, next));
  }

  function choice(nodes, q, answered) {
    var group = el("div", { class: "ex-options", role: "group", "aria-label": ui.options });
    q.options.forEach(function (option, i) {
      var b = content("button", option, { type: "button", class: "ex-button option" + (answered && answered.chosen === i ? " chosen" : "") });
      if (answered) b.setAttribute("disabled", "");
      else b.addEventListener("click", function () { state.answers[state.index] = { chosen: i }; render(); });
      group.appendChild(b);
    });
    nodes.push(group);
    if (answered) feedback(nodes, q, answered);
  }

  function order(nodes, q, answered) {
    var placing = null;
    if (!answered) {
      if (!state.placing || state.placing.index !== state.index) state.placing = { items: shuffled(q.items), placed: [], index: state.index };
      placing = state.placing;
    }
    var placed = answered ? answered.placed : placing.placed;
    nodes.push(el("p", { class: "ex-note", text: ui.orderHelp }));
    nodes.push(el("ol", { class: "ex-placed", "aria-label": ui.yourOrder }, placed.map(function (item) { return content("li", item, {}); })));
    if (answered) return feedback(nodes, q, answered);
    var rest = placing.items.filter(function (item) { return placed.indexOf(item) < 0; });
    nodes.push(el("div", { class: "ex-options", role: "group", "aria-label": ui.items }, rest.map(function (item) {
      var b = content("button", item, { type: "button", class: "ex-button option" });
      b.addEventListener("click", function () { placing.placed.push(item); render(); });
      return b;
    })));
    var actions = el("div", { class: "ex-actions" });
    var check = button(ui.check, function () { state.answers[state.index] = { placed: placing.placed.slice() }; state.placing = null; render(); });
    if (placed.length !== q.items.length) check.setAttribute("disabled", "");
    actions.appendChild(check);
    actions.appendChild(button(ui.clear, function () { placing.placed = []; render(); }, "secondary"));
    nodes.push(actions);
  }

  function done() {
    var questions = list.filter(function (p) { return p.kind === "question"; });
    var correct = 0;
    list.forEach(function (p, i) { if (p.kind === "question" && isCorrect(p.question, state.answers[i])) correct += 1; });
    var nodes = [
      el("h3", { text: ui.done, "data-focus": "" }),
      el("p", { class: "ex-text", text: correct > 0 ? fill(ui.score, { n: correct, total: questions.length }) : fill(ui.scoreNone, { total: questions.length }) })
    ];
    if (mission.commonMistakes && mission.commonMistakes.length) {
      nodes.push(el("h4", { text: ui.mistake }));
      mission.commonMistakes.forEach(function (m) { nodes.push(content("p", "“" + m.mistake + "” — " + m.why, {})); });
    }
    nodes.push(el("p", { class: "ex-note", text: ui.outro }));
    nodes.push(button(ui.again, function () { state = { index: 0, answers: {}, started: true }; render(); }));
    show(nodes);
  }

  render();
})(typeof globalThis !== "undefined" ? globalThis : this);
