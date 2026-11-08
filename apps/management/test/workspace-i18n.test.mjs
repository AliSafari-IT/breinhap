import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { readFile } from "node:fs/promises";
import { localeOf, languageSelector } from "../src/account/i18n.mjs";
import { adminDirectoryPage, learnersPage } from "../src/directory-pages.mjs";
import { editorPage, libraryPage, messageOf, SUBJECTS } from "../src/library.mjs";
import { previewPage } from "../src/preview.mjs";
import { diagnostic, formatLocale, tr, ui, uiLocale, withLocale } from "../src/workspace-i18n.mjs";
import { roleLabels } from "../src/platform.mjs";
import { SOURCE_KINDS, LICENCES } from "../src/uploads/store.mjs";
import { REFUSALS } from "../src/uploads/validate.mjs";
import { MESSAGES } from "../src/workspace-messages.mjs";
import { objectNamed } from "./import-fixtures.mjs";

const languages = ["nl", "fr", "en", "de"];
const placeholders = (value) => [...value.matchAll(/\{\d+\}/g)].map(([token]) => token).sort();

test("workspace messages cover all four locales and retain interpolation slots without HTML", () => {
	assert.ok(Object.keys(MESSAGES).length >= 500);
	for (const label of [...Object.values(roleLabels), ...[...SUBJECTS, ...SOURCE_KINDS, ...LICENCES].map(([, label]) => label), ...Object.values(REFUSALS)]) {
		assert.ok(Object.hasOwn(MESSAGES, label) || label.startsWith("Het bestand is te groot"), `dynamic label: ${label}`);
	}
	for (const [key, values] of Object.entries(MESSAGES)) {
		assert.deepEqual(Object.keys(values).sort(), [...languages].sort(), key);
		for (const lang of languages) {
			assert.equal(typeof values[lang], "string", `${key}: ${lang}`);
			assert.ok(values[lang].trim(), `${key}: ${lang}`);
			assert.deepEqual(placeholders(values[lang]), placeholders(key), `${key}: ${lang}`);
			assert.doesNotMatch(values[lang], /<\/?[a-z][^>]*>/i, `${key}: ${lang} is plain text`);
		}
	}
});

test("concurrent requests keep independent languages; template values are never translated or reinterpreted", async () => {
	const render = (value) => ui`<label>Titel <input name="title" value="${value}"></label><p>${value}</p>`;
	const raw = "Opslaan &lt;script&gt; {0} \uE0000\uE001";
	const results = await Promise.all(languages.map((lang, index) => withLocale(lang, async () => {
		await new Promise((resolve) => setTimeout(resolve, 10 - index));
		return { lang: uiLocale(), html: render(raw), locale: formatLocale() };
	})));
	for (const [index, row] of results.entries()) {
		assert.equal(row.lang, languages[index]);
		assert.equal(row.html.match(/Opslaan/g).length, 2);
		assert.ok(row.html.includes(raw));
		assert.ok(row.html.includes(`name="title" value="${raw}"`));
	}
	assert.match(results[2].html, /<label>Title /);
	assert.match(results[1].html, /<label>Titre /);
	assert.equal(uiLocale(), "nl");
	assert.equal(withLocale("toString", uiLocale), "nl");
	assert.equal(withLocale("fr", () => tr`Voorbeeld: ${"Opslaan {0}"}`), "Exemple : Opslaan {0}");
});

test("locale selection is shared by auth and workspace, keeps filters and drops auth secrets", () => {
	const req = (cookie, accept = "") => ({ headers: { cookie, "accept-language": accept } });
	assert.equal(localeOf(req("breinhap-lang=fr; asafarim-locale=de-BE", "en")), "fr");
	assert.equal(localeOf(req("asafarim-locale=de-BE")), "de");
	assert.equal(localeOf(req("", "en-GB")), "en");
	const url = new URL("https://management.breinhap.com/bibliotheek?q=Opslaan&vak=biologie&jaar=3&lang=fr&code=secret&state=secret");
	const selector = languageSelector("fr", url.pathname, url.search);
	assert.match(selector, /q=Opslaan&amp;vak=biologie&amp;jaar=3&amp;lang=en/);
	assert.doesNotMatch(selector, /secret|code=|state=/);
	assert.match(selector, /aria-current="true" lang="fr"/);
});

test("editor, library, directory and preview localize chrome while preserving names, lessons and schema values", () => {
	const expected = { nl: ["Opslaan", "Leerlingen"], fr: ["Enregistrer", "Élèves"], en: ["Save", "Students"], de: ["Speichern", "Schüler"] };
	for (const lang of languages) withLocale(lang, () => {
		const editor = editorPage({ values: { title: "Opslaan", "missions.0.title": "Overzicht" }, csrf: "csrf" });
		assert.ok(editor.includes(`<button type="submit">${expected[lang][0]}</button>`));
		assert.ok(editor.includes('name="title" required value="Opslaan"') || editor.includes('value="Opslaan"'));
		assert.ok(editor.includes('value="Overzicht"'));
		assert.match(editor, /name="missions\.0\.practice\.0\.kind"/);
		assert.match(editor, /value="choice"/);
		assert.match(editor, /value="biologie"/);
		assert.match(editor, /value="school_material"/);
		const library = libraryPage([{ id: "lesson", title: "Opslaan", subject: "biologie", grade: 3, updatedAt: Date.now() }]);
		assert.match(library, />Opslaan<\/a>/);
		assert.ok(library.includes(`<input type="hidden" name="lang" value="${lang}">`));
		const directory = adminDirectoryPage({ learners: [{ id: "one", displayName: "Overzicht", schoolYear: 3 }], groups: [], memberships: [], links: [], grants: [] }, "csrf");
		assert.ok(directory.includes(`<h2>${expected[lang][1]}</h2>`));
		assert.match(directory, /<strong>Overzicht<\/strong>/);
		assert.match(learnersPage([{ displayName: "Opslaan", schoolYear: 3 }], []), /<li>Opslaan/);
		const object = objectNamed("preview", { title: "Opslaan" });
		const preview = previewPage(object, new URLSearchParams(), { base: "/bibliotheek/preview/voorbeeld", back: "/bibliotheek/preview", label: "v1" });
		assert.ok(preview.includes(object.missions[0].warmup.text));
		if (lang !== "nl") assert.doesNotMatch(preview, /Zo ziet een leerling|Terug naar het leerobject/);
	});
});

test("stored import diagnostics translate at display time with untouched data and localized bounds", () => {
	withLocale("en", () => {
		assert.equal(diagnostic("Schemaversie 99 wordt niet ondersteund (alleen 1)."), "Schema version 99 is not supported (only 1).");
		assert.equal(diagnostic("De code Opslaan staat twee keer in het bestand."), "The code Opslaan appears twice in the file.");
		assert.equal(messageOf({ path: "grade", code: "too_big", origin: "number", maximum: 6 }), "At most 6.");
	});
	assert.equal(withLocale("fr", () => messageOf({ path: "items", code: "custom", message: "order items must be unique" })), "Utilisez chaque élément une seule fois.");
	assert.equal(withLocale("fr", () => diagnostic("Hoogstens 6.")), "Au maximum 6.");
	assert.equal(withLocale("de", () => diagnostic("Je had 2 van de 3 vragen juist.")), "Sie haben 2 von 3 Fragen richtig beantwortet.");
});

test("editor's saving feedback uses server-selected copy and never a translated selector", async () => {
	const js = await readFile(new URL("../src/editor.js", import.meta.url), "utf8");
	let submit;
	const button = { textContent: "" };
	const form = { dataset: {}, addEventListener(name, callback) { if (name === "submit") submit = callback; }, querySelector: () => button };
	runInNewContext(js, { document: { documentElement: { dataset: { saving: "Enregistrement…" } }, getElementById: () => null, querySelector: () => form }, window: { addEventListener() {} } });
	submit({ preventDefault() { assert.fail("first submit must proceed"); } });
	assert.equal(button.textContent, "Enregistrement…");
});
