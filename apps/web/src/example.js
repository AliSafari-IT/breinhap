/*
 * Try Breinhap on the home page (breinhap#114): the same flow as the Android app, in the browser. gemeente →
 * school → jaar → richting → vak → "Ik heb __ minuten" → one mission in the fixed Opwarmen → Leren → Doen → Check
 * order, one card or question per screen. The schools and the reviewed missions come from /example-data.js
 * (generated from packages/content); the interface text is embedded in the page as JSON data. Nothing is sent,
 * stored or tracked: no request, no cookie, no storage. Closing or reloading the page ends the run, so the choice
 * of school and year is asked again next time. The rules mirror packages/content (schools.ts, pick.ts, mission.ts):
 * the answer key and the picker decide, never a model.
 */
(function (root) {
  var STEPS = ["Opwarmen", "Leren", "Doen", "Check"];
  var YEARS = [1, 2, 3, 4, 5, 6];
  var TIME_OPTIONS = [2, 5, 10, 15];
  var SEARCH_FROM = 8;

  /** The catalogue rules (packages/content schools.ts and pick.ts) over the generated data D. */
  function logic(D) {
    function byName(a, b) { return a.localeCompare(b, "nl"); }
    function findSchool(id) { return id == null ? undefined : D.schools.find(function (s) { return s.id === id; }); }
    function findRichting(id) { return id == null ? undefined : D.richtingen.find(function (r) { return r.id === id; }); }
    function cities() {
      var seen = {};
      D.schools.forEach(function (s) { seen[s.city] = { name: s.city, postcode: s.postcode }; });
      return Object.keys(seen).map(function (k) { return seen[k]; }).sort(function (a, b) { return byName(a.name, b.name); });
    }
    function schoolsIn(city) { return D.schools.filter(function (s) { return s.city === city; }).sort(function (a, b) { return byName(a.name, b.name); }); }
    function richtingenFor(schoolId, year) {
      var school = findSchool(schoolId);
      return D.richtingen.filter(function (r) { return r.years.indexOf(year) >= 0 && (!school || school.richtingen.indexOf(r.id) >= 0); });
    }
    /** The student's vakken with the content each has; an empty list means "binnenkort". */
    function coursesFor(profile) {
      var forYear = D.objects.filter(function (o) { return o.grade === profile.year; });
      var richting = findRichting(profile.richtingId);
      if (richting && richting.years.indexOf(profile.year) >= 0) {
        return richting.courses.map(function (course) {
          return { course: course, objects: course.subject ? forYear.filter(function (o) { return o.subject === course.subject; }) : [] };
        });
      }
      var subjects = [];
      forYear.forEach(function (o) { if (subjects.indexOf(o.subject) < 0) subjects.push(o.subject); });
      return subjects.map(function (subject) {
        return { course: { id: subject, label: D.subjectLabel[subject], subject: subject }, objects: forYear.filter(function (o) { return o.subject === subject; }) };
      });
    }
    /** "Ik heb __ minuten": the longest mission that fits, in stable content order. Deterministic, no AI. */
    function pickMission(objects, minutes) {
      var candidates = [];
      var order = 0;
      objects.forEach(function (object) {
        object.missions.forEach(function (mission) {
          if (mission.minutes <= minutes) candidates.push({ object: object, mission: mission, order: order++ });
        });
      });
      candidates.sort(function (a, b) { return (b.mission.minutes - a.mission.minutes) || (a.order - b.order); });
      return candidates[0];
    }
    return { findSchool: findSchool, findRichting: findRichting, cities: cities, schoolsIn: schoolsIn, richtingenFor: richtingenFor, coursesFor: coursesFor, pickMission: pickMission };
  }

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

  /** A shuffle for display only (never the stored order), so the answer is not the list as shown. */
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

  /**
   * What is read aloud, and the recorded clip's key: the same rules as packages/content narration.ts
   * (narrationText, questionNarrationText, normaliseNarration, narrationKey). A clip is found by the hash of the
   * exact text, so a clip recorded for old text is never played over new text.
   */
  var NARRATION_KEY_VERSION = 1;
  function cardText(card) { return [card.text, card.example].filter(Boolean).join(" "); }
  function questionText(q) { return q.prompt + " " + (q.options || q.items).join(". ") + "."; }
  function normalise(text) { return text.normalize("NFC").replace(/\s+/g, " ").trim(); }
  function keyFor(text) {
    var bytes = new TextEncoder().encode("breinhap-narration:" + NARRATION_KEY_VERSION + "\n" + normalise(text));
    return root.crypto.subtle.digest("SHA-256", bytes).then(function (hash) {
      return Array.prototype.map.call(new Uint8Array(hash), function (b) { return (b < 16 ? "0" : "") + b.toString(16); }).join("").slice(0, 16);
    });
  }

  root.BreinhapExample = { cardText: cardText, questionText: questionText, normalise: normalise, keyFor: keyFor, NARRATION_KEY_VERSION: NARRATION_KEY_VERSION, STEPS: STEPS, YEARS: YEARS, TIME_OPTIONS: TIME_OPTIONS, logic: logic, pages: pages, isCorrect: isCorrect, shuffled: shuffled, fill: fill };

  if (typeof document === "undefined") return;

  var mount = document.querySelector("[data-example]");
  var uiBlock = document.getElementById("example-ui");
  if (!mount || !uiBlock || !root.BreinhapData) return;
  var ui;
  try { ui = JSON.parse(uiBlock.textContent); } catch (e) { return; }
  var L = logic(root.BreinhapData);
  var lang = ui.lang;

  // The only state: what the visitor picked, where they are, and the run in progress. Never persisted.
  var state = fresh();
  function fresh() { return { voice: state && state.voice, voicePicked: state && state.voicePicked, screen: "profile", step: "city", city: null, schoolId: null, year: null, profile: null, courseId: null, minutes: null, run: null, focused: null }; }

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
  /** Mission text is Dutch: label it, so a screen reader pronounces it right on the other languages' pages. */
  function dutch(tag, text, attrs) {
    var a = attrs || {};
    a.text = text;
    if (lang !== "nl") a.lang = "nl";
    return el(tag, a);
  }
  function yearLabel(year) { return fill(year === 1 && ui.year1 ? ui.year1 : ui.year, { n: year }); }
  function vak(course) { return (ui.vakken && ui.vakken[course.id]) || course.label; }
  function profileLabel(profile) {
    var school = L.findSchool(profile.schoolId);
    var richting = L.findRichting(profile.richtingId);
    return [school && school.name + ", " + school.city, yearLabel(profile.year), richting && richting.label].filter(Boolean).join(" · ");
  }

  // Read aloud. Recorded Flemish voices (ElevenLabs, made offline before a release and served from this site as
  // /narration/<voice>/<key>.mp3, listed in /narration/voices.js) when one exists for the exact text; otherwise the
  // browser's own Dutch speech. Nothing is sent anywhere: the only requests are for the clips on this site. The
  // chosen voice is kept for this visit only.
  var synth = typeof root.speechSynthesis !== "undefined" && typeof root.SpeechSynthesisUtterance !== "undefined" ? root.speechSynthesis : null;
  var recorded = (root.BreinhapVoices && root.BreinhapVoices.keyVersion === NARRATION_KEY_VERSION && root.BreinhapVoices.voices) || [];
  var canHash = !!(root.crypto && root.crypto.subtle && root.TextEncoder);
  if (!canHash) recorded = [];
  var voiceIds = recorded.map(function (v) { return v.id; }).concat(synth ? ["device"] : []);
  var audio = null;
  var playing = null; // the read button that is playing now
  state.voice = voiceIds[0] || null;
  // A signed-in person's saved voice for Dutch (the missions are Dutch) from management's Instellingen, via the
  // navbar's session check (account.js). It applies until they pick another voice here during this visit.
  function applySavedVoice() {
    var saved = root.BreinhapAccount && root.BreinhapAccount.voices && root.BreinhapAccount.voices.nl;
    if (state.voicePicked || !saved || voiceIds.indexOf(saved) < 0 || saved === state.voice) return;
    state.voice = saved;
    var select = document.getElementById("ex-voice");
    if (select) select.value = saved;
  }
  applySavedVoice();
  document.addEventListener("breinhap:account", applySavedVoice);
  function stopReading() {
    if (audio) { audio.onended = audio.onpause = audio.onerror = null; audio.pause(); }
    if (synth) synth.cancel();
    if (playing) { playing(false); playing = null; }
  }
  function speakDevice(text, done) {
    if (!synth) return done();
    var u = new root.SpeechSynthesisUtterance(text);
    u.lang = "nl-BE";
    u.rate = 0.9;
    var voices = synth.getVoices();
    var voice = voices.filter(function (v) { return /^nl[-_]BE/i.test(v.lang); })[0] || voices.filter(function (v) { return /^nl/i.test(v.lang); })[0];
    if (voice) u.voice = voice;
    u.onend = u.onerror = done;
    synth.speak(u);
  }
  function readButton(text) {
    if (!voiceIds.length) return null;
    var b = el("button", { type: "button", class: "ex-button secondary ex-read", "aria-pressed": "false", text: "🔊 " + ui.readAloud });
    function setPlaying(on) { b.textContent = (on ? "⏹ " + ui.stopReading : "🔊 " + ui.readAloud); b.setAttribute("aria-pressed", on ? "true" : "false"); }
    b.addEventListener("click", function () {
      if (b.getAttribute("aria-pressed") === "true") return stopReading();
      stopReading();
      setPlaying(true);
      playing = setPlaying;
      var done = function () { if (playing === setPlaying) { setPlaying(false); playing = null; } };
      var voice = recorded.filter(function (v) { return v.id === state.voice; })[0];
      if (!voice) return speakDevice(text, done);
      keyFor(text).then(function (key) {
        if (playing !== setPlaying) return; // stopped while hashing
        if (voice.clips.indexOf(key) < 0) return speakDevice(text, done); // no clip for this exact text
        audio = audio || new root.Audio();
        audio.src = "/narration/" + voice.id + "/" + key + ".mp3";
        audio.onended = audio.onerror = done;
        audio.play().catch(function () { speakDevice(text, done); });
      }, function () { speakDevice(text, done); });
    });
    return b;
  }
  /** The voice picker: only when there is more than one voice to choose from. */
  function voicePicker() {
    if (voiceIds.length < 2) return null;
    var select = el("select", { id: "ex-voice", class: "ex-voice" });
    voiceIds.forEach(function (id) {
      var v = recorded.filter(function (r) { return r.id === id; })[0];
      var option = el("option", { value: id, text: v ? v.name + " · " + ui.voiceRecorded : ui.voiceDevice });
      if (id === state.voice) option.setAttribute("selected", "");
      select.appendChild(option);
    });
    select.addEventListener("change", function () { stopReading(); state.voice = select.value; state.voicePicked = true; });
    return el("p", { class: "ex-voice-row" }, [el("label", { for: "ex-voice", text: ui.voice }), select]);
  }

  var panel = el("div", { class: "ex-panel", "aria-live": "polite" });
  mount.appendChild(panel);

  /** Mounts the nodes, then moves focus into them (never to a removed node). focus: a selector, or false for none. */
  function show(nodes, focus) {
    panel.textContent = "";
    nodes.forEach(function (n) { if (n) panel.appendChild(n); });
    if (focus === false) return;
    var target = panel.querySelector(focus || "[data-focus]");
    if (!target) return;
    if (!/^(button|input)$/i.test(target.tagName)) target.setAttribute("tabindex", "-1");
    target.focus();
  }
  var first = true;
  /** Every screen but the very first takes focus, so the page never jumps on load. */
  function go(nodes, focus) { var f = first ? false : focus; first = false; show(nodes, f); }

  // ---- 1. Profile: gemeente → school → jaar → richting, one question per screen, always a way out ----

  var PROFILE_STEPS = ["city", "school", "year", "richting"];

  function choices(question, options, selected, notListed, empty, onPick) {
    var nodes = [el("h3", { text: question, "data-focus": "" })];
    var list = el("div", { class: "ex-options" });
    var drawn = [];
    function draw(needle) {
      list.textContent = "";
      options.filter(function (o) { return !needle || (o.label + " " + (o.hint || "")).toLocaleLowerCase("nl").indexOf(needle) >= 0; }).forEach(function (o) {
        var b = button(o.hint ? o.label + " (" + o.hint + ")" : o.label, function () { onPick(o.id); }, o.id === selected ? "" : "option");
        list.appendChild(b);
      });
    }
    if (options.length > SEARCH_FROM) {
      var input = el("input", { type: "search", class: "ex-search", "aria-label": ui.search, placeholder: ui.search });
      input.addEventListener("input", function () { draw(input.value.trim().toLocaleLowerCase("nl")); });
      nodes.push(input);
    }
    if (!options.length && empty) nodes.push(el("p", { class: "ex-note", text: empty }));
    draw("");
    nodes.push(list);
    if (notListed) nodes.push(button(options.length ? notListed : ui.next, function () { onPick(null); }, "secondary"));
    return nodes;
  }

  function profileScreen() {
    var step = state.step;
    var nodes = [el("p", { class: "ex-count", text: fill(ui.stepOf, { n: PROFILE_STEPS.indexOf(step) + 1, total: 4 }) })];
    if (step === "city") {
      nodes = nodes.concat(choices(ui.qCity, L.cities().map(function (c) { return { id: c.name, label: c.name, hint: c.postcode }; }), state.city, ui.noCity, null, function (id) {
        state.city = id;
        if (id === null) { state.schoolId = null; state.step = "year"; } else { state.step = "school"; }
        render();
      }));
    } else if (step === "school") {
      nodes = nodes.concat(choices(ui.qSchool, L.schoolsIn(state.city).map(function (s) { return { id: s.id, label: s.name }; }), state.schoolId, ui.noSchool, null, function (id) {
        state.schoolId = id; state.step = "year"; render();
      }));
    } else if (step === "year") {
      nodes = nodes.concat(choices(ui.qYear, YEARS.map(function (y) { return { id: String(y), label: yearLabel(y) }; }), state.year === null ? null : String(state.year), null, null, function (id) {
        state.year = Number(id); state.step = "richting"; render();
      }));
    } else {
      nodes = nodes.concat(choices(ui.qRichting, L.richtingenFor(state.schoolId, state.year).map(function (r) { return { id: r.id, label: r.label }; }), null, ui.noRichting, ui.emptyRichting, function (richtingId) {
        state.profile = { schoolId: state.schoolId, year: state.year, richtingId: richtingId };
        state.screen = "study"; state.courseId = null; state.minutes = null; render();
      }));
    }
    if (step !== "city") nodes.push(button(ui.back, function () {
      state.step = step === "school" ? "city" : step === "year" ? (state.city === null ? "city" : "school") : "year";
      render();
    }, "secondary"));
    go(nodes);
  }

  // ---- 2. Study: vak → "Hoeveel tijd heb je?" → the one best mission ----

  function studyScreen() {
    var courses = L.coursesFor(state.profile);
    var ready = courses.filter(function (c) { return c.objects.length > 0; });
    var soon = courses.filter(function (c) { return c.objects.length === 0; });
    var current = ready.filter(function (c) { return c.course.id === state.courseId; })[0];
    var nodes = [el("p", { class: "ex-count", text: profileLabel(state.profile) })];
    if (!current) {
      nodes.push(el("h3", { text: ui.studyWhat, "data-focus": "" }));
      var group = el("div", { class: "ex-options", role: "group", "aria-label": ui.vakGroup });
      ready.forEach(function (c) { group.appendChild(button(vak(c.course), function () { state.courseId = c.course.id; state.minutes = null; render(); }, "option")); });
      nodes.push(group);
      if (!ready.length) nodes.push(el("p", { class: "ex-note", text: ui.noCourses }));
      if (soon.length) nodes.push(el("p", { class: "ex-note", text: ui.soon + ": " + soon.map(function (c) { return vak(c.course); }).join(", ") }));
    } else {
      nodes.push(el("p", { class: "ex-count", text: vak(current.course) }));
      nodes.push(el("h3", { text: ui.howMuch, "data-focus": "" }));
      var times = el("div", { class: "ex-options ex-times", role: "group", "aria-label": ui.howMuch });
      TIME_OPTIONS.forEach(function (m) {
        var b = button(fill(ui.minutes, { n: m }), function () { state.minutes = m; render(); }, state.minutes === m ? "" : "option");
        if (state.minutes === m) b.setAttribute("aria-pressed", "true");
        times.appendChild(b);
      });
      nodes.push(times);
      var choice = state.minutes === null ? undefined : L.pickMission(current.objects, state.minutes);
      if (choice) {
        nodes.push(el("div", { class: "ex-card" }, [
          dutch("p", choice.mission.title, { class: "ex-mission" }),
          el("p", { class: "ex-note", text: fill(ui.missionMeta, { n: choice.mission.minutes }) }),
          button(fill(ui.startMission, { n: choice.mission.minutes }), function () { startRun(choice.mission); })
        ]));
      } else if (state.minutes !== null) {
        nodes.push(el("p", { class: "ex-note", role: "status", text: state.minutes <= 2 ? ui.noneFit : ui.noneLeft }));
      }
      nodes.push(button(ui.otherSubject, function () { state.courseId = null; state.minutes = null; render(); }, "secondary"));
    }
    nodes.push(button(ui.changeProfile, function () { state = fresh(); render(); }, "secondary"));
    go(nodes, current && state.minutes !== null ? ".ex-times [aria-pressed=true]" : undefined);
  }

  // ---- 3. The mission itself ----

  function startRun(mission) {
    state.screen = "play";
    state.run = { mission: mission, list: pages(mission), index: 0, answers: {}, placing: null, focused: null };
    render();
  }
  function leaveRun() { state.screen = "study"; state.run = null; render(); }
  function next() { state.run.index += 1; render(); }

  function stepList(current) {
    return el("ol", { class: "ex-steps", "aria-label": ui.stepsLabel }, STEPS.map(function (step) {
      var li = el("li", { text: ui.steps[step] });
      if (step === current) li.setAttribute("aria-current", "step");
      return li;
    }));
  }
  function runHeader(run, page) {
    var parts = [el("p", { class: "ex-count" }, [dutch("span", run.mission.title, {}), document.createTextNode(" · " + fill(ui.count, { n: run.index + 1, total: run.list.length }))])];
    if (run.index === run.list.length - 1) parts.push(el("p", { class: "ex-count", text: ui.lastQuestion }));
    return [stepList(page.step)].concat(parts);
  }

  function playScreen() {
    var run = state.run;
    if (run.index >= run.list.length) { run.focused = -1; return done(run); }
    var page = run.list[run.index];
    var nodes = runHeader(run, page);
    nodes.push(voicePicker());
    if (page.kind === "card") {
      nodes.push(dutch("p", page.card.text, { class: "ex-text", "data-focus": "" }));
      if (page.card.example) nodes.push(dutch("p", ui.example + " " + page.card.example, { class: "ex-example" }));
      nodes.push(readButton(cardText(page.card)));
      nodes.push(button(ui.next, next));
      run.focused = -1;
      return go(nodes);
    }
    var q = page.question;
    nodes.push(dutch("p", q.prompt, { class: "ex-text", "data-focus": "" }));
    nodes.push(readButton(questionText(q)));
    var answered = run.answers[run.index];
    if (q.kind === "choice") choice(nodes, run, q, answered);
    else order(nodes, run, q, answered);
    var entering = run.focused !== run.index;
    run.focused = run.index;
    go(nodes, answered ? "[data-feedback]" : entering ? "[data-focus]" : ".option:not(:disabled), .ex-actions .ex-button:not(:disabled)");
  }

  function feedback(nodes, run, q, answer) {
    var ok = isCorrect(q, answer);
    nodes.push(el("div", { class: "ex-feedback " + (ok ? "ok" : "no"), "data-feedback": "" }, [
      el("strong", { text: ok ? ui.right : ui.notYet }),
      dutch("p", q.explanation, {}),
      readButton(q.explanation)
    ]));
    nodes.push(button(run.index === run.list.length - 1 ? ui.finish : ui.next, next));
  }

  function choice(nodes, run, q, answered) {
    var group = el("div", { class: "ex-options", role: "group", "aria-label": ui.options });
    q.options.forEach(function (option, i) {
      var b = dutch("button", option, { type: "button", class: "ex-button option" + (answered && answered.chosen === i ? " chosen" : "") });
      if (answered) b.setAttribute("disabled", "");
      else b.addEventListener("click", function () { run.answers[run.index] = { chosen: i }; render(); });
      group.appendChild(b);
    });
    nodes.push(group);
    if (answered) feedback(nodes, run, q, answered);
  }

  function order(nodes, run, q, answered) {
    var placing = null;
    if (!answered) {
      if (!run.placing || run.placing.index !== run.index) run.placing = { items: shuffled(q.items), placed: [], index: run.index };
      placing = run.placing;
    }
    var placed = answered ? answered.placed : placing.placed;
    nodes.push(el("p", { class: "ex-note", text: ui.orderHelp }));
    nodes.push(el("ol", { class: "ex-placed", "aria-label": ui.yourOrder }, placed.map(function (item) { return dutch("li", item, {}); })));
    if (answered) return feedback(nodes, run, q, answered);
    var rest = placing.items.filter(function (item) { return placed.indexOf(item) < 0; });
    nodes.push(el("div", { class: "ex-options", role: "group", "aria-label": ui.items }, rest.map(function (item) {
      var b = dutch("button", item, { type: "button", class: "ex-button option" });
      b.addEventListener("click", function () { placing.placed.push(item); render(); });
      return b;
    })));
    var actions = el("div", { class: "ex-actions" });
    var check = button(ui.check, function () { run.answers[run.index] = { placed: placing.placed.slice() }; run.placing = null; render(); });
    if (placed.length !== q.items.length) check.setAttribute("disabled", "");
    actions.appendChild(check);
    actions.appendChild(button(ui.clear, function () { placing.placed = []; render(); }, "secondary"));
    nodes.push(actions);
  }

  function done(run) {
    var questions = run.list.filter(function (p) { return p.kind === "question"; });
    var correct = 0;
    run.list.forEach(function (p, i) { if (p.kind === "question" && isCorrect(p.question, run.answers[i])) correct += 1; });
    var nodes = [
      el("h3", { text: ui.done, "data-focus": "" }),
      el("p", { class: "ex-text", text: correct > 0 ? fill(ui.score, { n: correct, total: questions.length }) : fill(ui.scoreNone, { total: questions.length }) })
    ];
    if (run.mission.commonMistakes && run.mission.commonMistakes.length) {
      nodes.push(el("h4", { text: ui.mistake }));
      run.mission.commonMistakes.forEach(function (m) { nodes.push(dutch("p", "“" + m.mistake + "” — " + m.why, {})); });
    }
    nodes.push(el("p", { class: "ex-note", text: ui.outro }));
    nodes.push(button(ui.backToStart, leaveRun));
    go(nodes);
  }

  function render() {
    stopReading();
    if (state.screen === "profile") return profileScreen();
    if (state.screen === "study") return studyScreen();
    return playScreen();
  }

  render();
})(typeof globalThis !== "undefined" ? globalThis : this);
