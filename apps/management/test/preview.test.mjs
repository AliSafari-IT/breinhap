// breinhap#28: the management preview follows the shared mission rules. The parity fixture in
// packages/content is the same one the Android app and the content package check against.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { decodeAnswers, encodeAnswers, previewPage } from "../src/preview.mjs";
import { shuffleForDisplay } from "../src/vendor/content-pick.mjs";
import { isFinished, missionPages, scoreAnswers, scoreSentence, studentPayload } from "../src/vendor/content-mission.mjs";
import { LearningObject } from "../src/vendor/content-schema.mjs";

const fixture = JSON.parse(
	await readFile(new URL("../../../packages/content/fixtures/mission-parity.json", import.meta.url), "utf8"),
);
const object = studentPayload(LearningObject.parse(fixture.object));
const mission = object.missions[0];
const pages = missionPages(mission);
const view = (query) =>
	previewPage(object, new URLSearchParams(query), { base: "/bibliotheek/x/voorbeeld", back: "/bibliotheek/x", label: "het concept" });
const questions = mission.practice.length + mission.check.length;

test("parity: the vendored rules give the fixture's pages, scores, sentences and display order", () => {
	assert.deepEqual(pages.map((p) => `${p.step}:${p.kind}`), fixture.pages);
	for (const c of fixture.cases) {
		assert.equal(scoreAnswers(pages, c.answers), c.score, c.name);
		assert.equal(scoreSentence(scoreAnswers(pages, c.answers), questions), c.sentence, c.name);
	}
	for (const s of fixture.shuffles) assert.deepEqual(shuffleForDisplay(s.items, s.seed), s.shown);
});

test("parity: every finished fixture answer survives the URL and the preview ends on the fixture's sentence", () => {
	for (const c of fixture.cases) {
		const finished = Object.fromEntries(
			Object.entries(c.answers).filter(([i, a]) => isFinished(pages[i].question, a)),
		);
		const state = encodeAnswers(finished, pages);
		assert.deepEqual(decodeAnswers(state, pages), finished, c.name);
		if (Object.keys(finished).length === questions)
			assert.ok(view(`stap=${pages.length}&a=${state}`).includes(c.sentence), c.name);
	}
});

test("the preview walks Opwarmen → Leren → Doen → Check, with feedback and no time pressure", () => {
	const first = view("");
	assert.match(first, /<li aria-current="step">Opwarmen<\/li>/);
	assert.match(first, /Er wordt niets gepubliceerd, toegewezen of bewaard/);
	assert.match(view("stap=1"), /<li aria-current="step">Leren<\/li>/);
	assert.match(view("stap=1"), /Voorbeeld: Een harde knal\./);
	const ask = view("stap=3");
	assert.match(ask, /<li aria-current="step">Doen<\/li>/);
	assert.match(ask, /name="kies"/);
	const right = view("stap=3&kies=1");
	assert.match(right, /Klopt\./);
	assert.match(right, /Een prikkel is een verandering in of rond je lichaam\./);
	assert.match(right, /href="\/bibliotheek\/x\/voorbeeld\?stap=4&amp;a=3c1"/);
	assert.match(view("stap=3&kies=0"), /Nog niet\./);
	// order: the options come in the app's display order; a wrong order explains the right one
	const order = view("stap=4&a=3c1");
	assert.match(order, /name="plaats3"/);
	const shown = shuffleForDisplay(mission.practice[1].items, 5);
	assert.ok(order.includes(`De stukjes: ${shown.join(" · ")}`));
	assert.match(view("stap=4&a=3c1&plaats0=1&plaats1=0&plaats2=2&plaats3=3"), /Nog niet\..*De juiste volgorde: Prikkel → Receptor → Zenuw → Reactie\./s);
	assert.match(view("stap=4&a=3c1&plaats0=0&plaats1=0&plaats2=2&plaats3=3"), /Zet elk stukje op precies één plaats/);
	assert.match(view("stap=6&a=3c1;4o0.1.2.3;5c0"), /<li aria-current="step">Check<\/li>.*Laatste vraag\./s);
	const done = view("stap=7&a=3c1;4o0.1.2.3;5c0;6o0.1.2");
	assert.match(done, /Missie klaar\./);
	assert.match(done, /Je had 4 van de 4 vragen juist\./);
	assert.match(done, /Veelgemaakte fout/);
	assert.doesNotMatch(`${first}${ask}${done}`, /seconde|timer|levens|streak/i);
});

test("the preview never skips an unanswered question and drops answers that do not fit", () => {
	assert.match(view("stap=7"), /Wat is een prikkel\?/);
	assert.match(view("stap=7&a=3c1"), /Zet in volgorde\./);
	assert.deepEqual(decodeAnswers("3c9;4o0.0.1.2;1c0;zz;5o0", pages), {});
	assert.deepEqual(decodeAnswers("3c1;3c0", pages), { 3: { kind: "choice", chosen: 1 } });
	// an answer already given is final, like in the app
	assert.match(view("stap=3&a=3c1&kies=0"), /Klopt\./);
});

test("a mission is chosen first when there are several, and text is escaped", () => {
	const two = structuredClone(object);
	two.missions.push({ ...structuredClone(mission), id: "tweede", title: "Tweede <missie>" });
	const page = previewPage(two, new URLSearchParams(""), { base: "/b", back: "/e", label: "x" });
	assert.match(page, /Kies een missie/);
	assert.match(page, /Tweede &lt;missie&gt;/);
	assert.match(previewPage(two, new URLSearchParams("missie=1"), { base: "/b", back: "/e", label: "x" }), /Tweede &lt;missie&gt; · 1 van 7/);
	assert.match(previewPage(two, new URLSearchParams("missie=5"), { base: "/b", back: "/e", label: "x" }), /Deze missie bestaat niet/);
});
