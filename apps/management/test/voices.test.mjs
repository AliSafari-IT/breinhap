import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cleanVoices, DEVICE_VOICE, READING_LANGUAGES, VOICES } from "../src/voices.mjs";
import { pendingPage, rejectedPage, settingsPage } from "../src/account/pages.mjs";

test("the voices offered in Instellingen are exactly the voices recorded for breinhap.com", () => {
	const manifest = JSON.parse(readFileSync(new URL("../../web/narration/manifest.json", import.meta.url), "utf8"));
	const recorded = Object.entries(manifest.narrators)
		.filter(([, entry]) => Object.keys(entry?.clips ?? {}).length)
		.map(([id, entry]) => [id, String(entry.voiceName).split(/\s[-–]\s/)[0].trim()]);
	// the recorded voices read the Dutch missions; the website lists them in this order (apps/web build VOICE_ORDER)
	assert.deepEqual([...VOICES.nl].sort(), recorded.sort());
	assert.deepEqual(Object.keys(VOICES), ["nl"]);
});

test("cleanVoices keeps only known languages and voices", () => {
	assert.deepEqual(cleanVoices({ nl: "evie", fr: DEVICE_VOICE, en: "emma", de: "<x>", xx: "emma" }), { nl: "evie", fr: "device" });
	assert.deepEqual(cleanVoices(null), {});
	assert.deepEqual(cleanVoices({ nl: ["emma"] }), {});
	assert.deepEqual(READING_LANGUAGES, ["nl", "fr", "en", "de"]);
});

test("accounts awaiting approval reach the voice settings too, in their language", () => {
	for (const [lang, label] of [["nl", "Instellingen"], ["en", "Settings"], ["fr", "Paramètres"], ["de", "Einstellungen"]]) {
		const html = rejectedPage(lang, { csrf: "c", email: "a@example.com", version: "0" });
		assert.ok(html.includes(`<a href="/instellingen?lang=${lang}">${label}</a>`), lang);
	}
	const page = settingsPage("en", { csrf: "c", email: "a@example.com", voices: {}, catalogue: VOICES, languages: READING_LANGUAGES, device: DEVICE_VOICE, version: "0" });
	assert.ok(page.includes('<a href="/instellingen?lang=en">Settings</a>'));
	assert.equal(typeof pendingPage, "function");
});

test("every management page links the favicons (breinhap#130)", () => {
	const html = settingsPage("nl", { csrf: "c", email: "a@example.com", voices: {}, catalogue: VOICES, languages: READING_LANGUAGES, device: DEVICE_VOICE, version: "0" });
	assert.ok(html.includes('<link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png">'));
});

