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
    // one card that goes straight to the secure sign-in; the first sign-in creates the account
    assert.match(html,/<section class="auth-card" aria-labelledby="auth-title">/);
    assert.match(html,new RegExp(`class="button button-block" href="https://management\\.breinhap\\.com/${kind}\\?lang=${language ? "en" : "nl"}"`));
    assert.match(html,new RegExp(`<h1 id="auth-title">${kind === "login" ? (language ? "Sign in" : "Aanmelden") : (language ? "Create an account" : "Account aanmaken")}</h1>`));
    assert.match(html,new RegExp(`href="/${language}${kind === "login" ? "register" : "login"}"`), "switch to the other page");
    assert.match(html,language ? /Student sign-in is not available/ : /Voor leerlingen is aanmelden nog niet beschikbaar/);
    assert.match(html,language ? /secure sign-in platform/ : /beveiligde aanmeldplatform/);
    assert.match(html,new RegExp(`<a aria-current="page" href="[^"]*" data-account="${kind}"`));
    if (kind === "register") {
      assert.match(html,language ? /No invitation needed/ : /geen uitnodiging nodig/);
      assert.match(html,language ? /parent, tutor or teacher/ : /ouder, begeleider of leerkracht/);
    }
    assert.doesNotMatch(html, /<form\b|<style\b|\sstyle=|\son\w+=|<script(?![^>]*src=)/);
    assert.match(html,new RegExp(`rel="canonical" href="https://breinhap\\.com/${language}${kind}"`));
  }
});

test("a signed-in adult sees it in the navbar: the page asks management, and the CSP allows only that", () => {
  const nginx = readFileSync(new URL("../nginx.conf", import.meta.url), "utf8");
  assert.match(nginx, /connect-src https:\/\/management\.breinhap\.com;/);
  const script = read("account.js");
  assert.match(script, /"https:\/\/management\.breinhap\.com"/);
  assert.match(script, /\/auth\/session/);
  assert.match(script, /credentials: "include"/);
  for (const [file, label] of [
    ["index.html", "Naar Breinhap beheer"], ["en/index.html", "Go to Breinhap management"],
    ["login/index.html", "Naar Breinhap beheer"], ["en/login/index.html", "Go to Breinhap management"],
  ]) {
    const html = read(file);
    assert.ok(html.includes('<script src="/account.js" defer></script>'), file);
    assert.match(html, new RegExp(`data-account="login" data-signed-in-label="${label}"`), file);
    assert.match(html, /data-account="register"/, file);
  }
});
