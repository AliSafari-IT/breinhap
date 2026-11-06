// breinhap#signup: the ASafariM country & language selector on the sign-in pages. The committed bundle
// must equal a fresh build of the pinned package; the pages load it from this host and keep plain
// language links inside its mount point for browsers without JavaScript.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { emailPage } from "../src/account/pages.mjs";
import { OUTPUT, render, STYLES } from "../scripts/build-locale-selector.mjs";

test("the committed selector bundle is a fresh build of @asafarim/country-language-selector 0.5.3", async (t) => {
	const built = await render();
	if (!built) return t.skip("esbuild not installed here; the workspace CI checks this");
	assert.equal(await readFile(OUTPUT, "utf8"), built.js, "run: pnpm --filter @breinhap/management build:selector");
	assert.equal(await readFile(STYLES, "utf8"), built.css, "run: pnpm --filter @breinhap/management build:selector");
	const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(manifest.devDependencies["@asafarim/country-language-selector"], "0.5.3");
});

test("each sign-in page mounts the selector for its language, with links as the fallback", () => {
	for (const lang of ["nl", "fr", "en", "de"]) {
		const page = emailPage(lang, { version: "x" });
		assert.match(page, /<link rel="stylesheet" href="\/locale-selector\.css">/);
		assert.match(page, /<script src="\/locale-selector\.js" defer><\/script>/);
		assert.match(page, new RegExp(`<div class="locale-selector" data-locale-selector data-lang="${lang}"><nav class="lang-switch"`));
		assert.doesNotMatch(page, /<script>|<style>|\sstyle="/, "nothing inline: the CSP allows only this host");
	}
});
