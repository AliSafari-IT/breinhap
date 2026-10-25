// Checks the built site (run `node src/build.mjs` first; `pnpm test` does).
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { languages } from "../src/content.mjs";
import { routes } from "../src/render.mjs";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const pages = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else if (name.endsWith(".html")) pages.push(file);
  }
})(dist);
const read = (file) => readFileSync(file, "utf8");
const fileFor = (urlPath) => join(dist, urlPath.endsWith("/") ? `${urlPath}index.html` : urlPath);

test("every route is built, in both languages", () => {
  for (const byLang of Object.values(routes)) {
    for (const path of Object.values(byLang)) assert.ok(existsSync(fileFor(path)), `${path} is missing`);
  }
  assert.ok(existsSync(join(dist, "404.html")));
});

test("pages fit the CSP: no inline scripts, styles or style attributes, nothing from another origin", () => {
  for (const file of pages) {
    const html = read(file);
    // JSON-LD is a data block, not a script: the CSP does not apply to it and browsers never run it.
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>/, `${file}: inline <script>`);
    assert.doesNotMatch(html, /<style[\s>]/, `${file}: inline <style>`);
    assert.doesNotMatch(html, /\sstyle="/, `${file}: style attribute`);
    assert.doesNotMatch(html, /\son[a-z]+="/, `${file}: inline event handler`);
    for (const [, url] of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
      assert.ok(url.startsWith("/") || url.startsWith("https://breinhap.asafarim.site"), `${file}: external resource ${url}`);
    }
  }
});

test("internal links point at pages that exist", () => {
  for (const file of pages) {
    for (const [, href] of read(file).matchAll(/href="(\/[^"#]*)(#[^"]*)?"/g)) {
      assert.ok(existsSync(fileFor(href)) || existsSync(join(dist, href)), `${file}: broken link ${href}`);
    }
  }
});

test("in-page anchors exist on the home page", () => {
  for (const lang of ["nl", "en"]) {
    const html = read(fileFor(routes.home[lang]));
    for (const [, id] of html.matchAll(/href="\/(?:en\/)?#([a-z-]+)"/g)) {
      assert.match(html, new RegExp(`id="${id}"`), `${lang}: #${id} has no target`);
    }
  }
});

test("each page has the right language and links to its translation", () => {
  for (const [page, byLang] of Object.entries(routes)) {
    for (const [lang, path] of Object.entries(byLang)) {
      const html = read(fileFor(path));
      assert.match(html, new RegExp(`<html lang="${languages[lang].lang}">`), `${path}: lang`);
      const other = lang === "nl" ? "en" : "nl";
      assert.match(html, new RegExp(`class="lang" href="${routes[page][other]}"`), `${path}: language switch`);
    }
  }
});

test("both languages tell the same story", () => {
  const { nl, en } = languages;
  assert.equal(nl.flow.steps.length, 7);
  assert.equal(en.flow.steps.length, nl.flow.steps.length);
  assert.equal(en.why.items.length, nl.why.items.length);
  assert.equal(en.content.steps.length, nl.content.steps.length);
  assert.equal(en.faq.items.length, nl.faq.items.length);
  assert.equal(en.flow.screen.tiles.length, nl.flow.screen.tiles.length);
});

test("the phone has one scene per step, the first one shown", () => {
  const html = read(fileFor("/"));
  assert.equal((html.match(/class="scene[^"]*" data-scene=/g) ?? []).length, 7);
  assert.match(html, /class="scene is-active" data-scene="0"/);
  assert.equal((html.match(/data-step="/g) ?? []).length, 7);
});

test("SVG mask ids are unique per page", () => {
  for (const file of pages) {
    const ids = [...read(file).matchAll(/<mask id="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, `${file}: duplicate mask id`);
  }
});

test("the legal pages exist in both languages, with the same sections, and the footer links them all", async () => {
  const legal = await import("../src/legal.mjs");
  for (const name of ["privacy", "cookies", "terms", "deletion"]) {
    assert.equal(legal[name].en.sections.length, legal[name].nl.sections.length, `${name}: section count`);
  }
  for (const lang of ["nl", "en"]) {
    const html = read(fileFor(routes.home[lang]));
    for (const page of ["privacy", "cookies", "terms", "deletion"]) {
      assert.match(html, new RegExp(`<a href="${routes[page][lang]}">`), `${lang}: footer link to ${page}`);
    }
    assert.doesNotMatch(read(fileFor(routes.terms[lang])), /\{\{/, `${lang}: unfilled placeholder`);
    assert.doesNotMatch(read(fileFor(routes.cookies[lang])), /\{\{/, `${lang}: unfilled placeholder`);
  }
});

test("search and share metadata: Open Graph, x-default, JSON-LD on the home pages, 404 not indexed", () => {
  for (const lang of ["nl", "en"]) {
    const html = read(fileFor(routes.home[lang]));
    const url = `https://breinhap.asafarim.site${routes.home[lang]}`;
    assert.match(html, new RegExp(`<meta property="og:url" content="${url}">`));
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
    assert.match(html, /<link rel="alternate" hreflang="x-default" href="https:\/\/breinhap\.asafarim\.site\/">/);
    const [, json] = html.match(/<script type="application\/ld\+json">([^<]*)<\/script>/) ?? [];
    assert.ok(json, `${lang}: no JSON-LD`);
    const types = JSON.parse(json)["@graph"].map((n) => n["@type"]);
    assert.deepEqual(types, ["Organization", "WebSite", "MobileApplication"]);
    assert.doesNotMatch(html, /name="robots"/);
  }
  assert.match(read(join(dist, "404.html")), /<meta name="robots" content="noindex">/);
  const sitemap = read(join(dist, "sitemap.xml"));
  for (const byLang of Object.values(routes))
    for (const path of Object.values(byLang)) assert.ok(sitemap.includes(`<loc>https://breinhap.asafarim.site${path}</loc>`), path);
  assert.ok(existsSync(join(dist, "robots.txt")));
});
