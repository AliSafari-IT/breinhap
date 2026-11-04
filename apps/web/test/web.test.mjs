import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../dist/${path}`, import.meta.url), "utf8");
test("both languages explain that web missions are not available yet", () => {
  for (const [file, language, text, other] of [
    ["index.html", "nl-BE", "je kunt hier nog geen missies starten", "/en/"],
    ["en/index.html", "en", "you cannot start missions here yet", "/"],
  ]) {
    const html = read(file);
    assert.ok(html.includes(`<html lang="${language}">`));
    assert.ok(html.indexOf('class="release-banner"') < html.indexOf('<main id="main"'));
    assert.ok(html.includes(text));
    assert.ok(html.includes(`href="${other}"`));
    assert.doesNotMatch(html, /play\.google\.com|<form\b|role="alert"/);
  }
});

test("the new domain has its own metadata and preserves existing Android/legal destinations", () => {
  for (const [file, path] of [["index.html", "/"], ["en/index.html", "/en/"]]) {
    const html = read(file);
    assert.ok(html.includes(`<link rel="canonical" href="https://breinhap.com${path}">`));
    assert.ok(html.includes(`href="https://breinhap.asafarim.site${path}"`));
    assert.match(html, /href="https:\/\/breinhap\.asafarim\.site\/(?:en\/)?privacy\/"/);
  }
  assert.match(read("robots.txt"), /Sitemap: https:\/\/breinhap\.com\/sitemap\.xml/);
  assert.doesNotMatch(read("sitemap.xml"), /asafarim\.site/);
  assert.match(read("404.html"), /name="robots" content="noindex"/);
});

test("static pages fit the existing CSP and all local assets exist", () => {
  for (const file of ["index.html", "en/index.html", "404.html"]) {
    const html = read(file);
    assert.doesNotMatch(html, /<style\b|\sstyle=|\son\w+=|<script(?![^>]*src=)/);
    for (const [, path] of html.matchAll(/(?:src|href)="(\/[^"#]*)"/g)) {
      const target = path.endsWith("/") ? `${path}index.html` : path;
      assert.ok(existsSync(new URL(`../dist${target}`, import.meta.url)), `${file}: ${path}`);
    }
  }
});

test("login and register are branded adult entry pages and create no student session", () => {
  for (const language of ["", "en/"]) for (const kind of ["login", "register"]) {
    const html=read(`${language}${kind}/index.html`);
    assert.ok(html.includes(`property="og:url" content="https://breinhap.com/${language}${kind}"`));
    assert.match(html,new RegExp(`https://management\\.breinhap\\.com/${kind}`));
    assert.match(html,language ? /Student sign-in is not available/ : /Voor leerlingen is aanmelden nog niet beschikbaar/);
    assert.match(html,language ? /secure sign-in platform/ : /beveiligde aanmeldplatform/);
    if (kind === "register") {
      assert.match(html,language ? /No invitation needed/ : /geen uitnodiging nodig/);
      assert.match(html,language ? /parent, tutor or teacher/ : /ouder, begeleider of leerkracht/);
    }
    assert.doesNotMatch(html, /<form\b|<style\b|\sstyle=|\son\w+=|<script(?![^>]*src=)/);
    assert.match(html,new RegExp(`rel="canonical" href="https://breinhap\\.com/${language}${kind}"`));
  }
});
