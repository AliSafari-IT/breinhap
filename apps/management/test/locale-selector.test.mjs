// breinhap#signup: the ASafariM country & language selector on the sign-in pages. The committed bundle
// must equal a fresh build of the pinned package; the pages load it from this host and keep plain
// language links inside its mount point for browsers without JavaScript.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { langCookie } from "../src/account/i18n.mjs";
import { emailPage, profilePage } from "../src/account/pages.mjs";
import { header, themeToggle, websiteHome } from "../src/header.mjs";
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
		const lower = page.toLowerCase();
		assert.ok(!lower.includes("<script>") && !lower.includes("<style") && !lower.includes(" style="), "nothing inline: the CSP allows only this host");
		assert.equal(lower.split("<script").length - 1, 2, "only theme.js and locale-selector.js");
	}
});

test("the language cookie is shared with breinhap.com's hosts, and stays on the host anywhere else", () => {
	assert.match(langCookie("fr", "management.breinhap.com"), /^breinhap-lang=fr; Path=\/; Secure; SameSite=Lax; Max-Age=31536000; Domain=breinhap\.com$/);
	assert.match(langCookie("de", "breinhap.com:443"), /Domain=breinhap\.com$/);
	for (const host of ["localhost:4302", "127.0.0.1", "evilbreinhap.com", "breinhap.com.evil.example", undefined, ""])
		assert.doesNotMatch(langCookie("nl", host), /Domain=/, String(host));
});

test("the selector's script follows each page's own language links and writes that shared cookie", async () => {
	const js = await readFile(OUTPUT, "utf8");
	assert.match(js, /breinhap-lang=/);
	assert.match(js, /Domain=breinhap\.com/);
	assert.match(js, /a\[hreflang\]/);
});

test("management's header is breinhap.com's: brand, language selector, the OS theme toggle, in a centred container", () => {
	for (const lang of ["nl", "fr", "en", "de"]) {
		const page = emailPage(lang, { version: "x" });
		assert.match(page, new RegExp(`<header class="os-topbar"><div class="topbar-inner"><a class="brand" href="${websiteHome(lang).replaceAll(".", "\\.")}">`));
		assert.ok(page.includes(themeToggle(lang)), lang);
		assert.ok(page.indexOf('data-locale-selector') < page.indexOf('data-theme-toggle'), "the selector comes before the toggle");
		assert.doesNotMatch(page, /◐/);
	}
	assert.equal(websiteHome("nl"), "https://breinhap.com/");
	assert.equal(websiteHome("de"), "https://breinhap.com/de/");
	assert.match(header({ name: "Breinhap beheer", href: "/" }), /<a class="brand" href="\/"><img src="\/logo\.svg" width="40" height="40" alt=""><span>Breinhap beheer<\/span><\/a>/);
	assert.doesNotMatch(profilePage("en", { csrf: "c", version: "x" }), /◐/);
});
