import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../dist/${path}`, import.meta.url), "utf8");
const LANGUAGES = [
  // [folder, html lang, path, name of the language, the Android site's folder]
  ["", "nl-BE", "/", "nl", ""],
  ["en/", "en", "/en/", "en", "en/"],
  ["fr/", "fr-BE", "/fr/", "fr", "en/"],
  ["de/", "de-BE", "/de/", "de", "en/"],
];

test("every language explains that web missions are not available yet", () => {
  for (const [folder, language, , , ] of LANGUAGES) {
    const html = read(`${folder}index.html`);
    assert.ok(html.includes(`<html lang="${language}">`), folder);
    assert.ok(html.indexOf('class="release-banner"') < html.indexOf('<main id="main"'), folder);
    assert.doesNotMatch(html, /play\.google\.com|<form\b|role="alert"/);
  }
  assert.match(read("index.html"), /je kunt hier nog geen missies starten/);
  assert.match(read("en/index.html"), /you cannot start missions here yet/);
  assert.match(read("fr/index.html"), /vous ne pouvez pas encore y lancer de missions/);
  assert.match(read("de/index.html"), /Missionen können Sie hier noch nicht starten/);
});

test("each page has its own metadata, all four alternates, and keeps the Android and legal destinations", () => {
  for (const [folder, , path, , android] of LANGUAGES) {
    const html = read(`${folder}index.html`);
    assert.ok(html.includes(`<link rel="canonical" href="https://breinhap.com${path}">`), path);
    assert.ok(html.includes(`<meta property="og:url" content="https://breinhap.com${path}">`), path);
    for (const [, , other] of LANGUAGES) assert.match(html, new RegExp(`hreflang="[a-zA-Z-]+" href="https://breinhap\\.com${other}"`));
    assert.match(html, /hreflang="x-default" href="https:\/\/breinhap\.com\/"/);
    // the Android site only has Dutch and English pages: French and German visitors get the English ones
    assert.ok(html.includes(`href="https://breinhap.asafarim.site/${android}"`), path);
    assert.match(html, new RegExp(`href="https://breinhap\\.asafarim\\.site/${android}privacy/"`));
  }
  const sitemap = read("sitemap.xml");
  for (const [, , path] of LANGUAGES) assert.ok(sitemap.includes(`<loc>https://breinhap.com${path}</loc>`), path);
  assert.doesNotMatch(sitemap, /asafarim\.site/);
  assert.match(read("robots.txt"), /Sitemap: https:\/\/breinhap\.com\/sitemap\.xml/);
  assert.match(read("404.html"), /name="robots" content="noindex"/);
});

test("static pages fit the existing CSP and all local assets exist", () => {
  for (const file of ["index.html", "en/index.html", "fr/index.html", "de/index.html", "404.html"]) {
    const html = read(file);
    assert.doesNotMatch(html, /<style\b|\sstyle=|\son\w+=|<script(?![^>]*src=)/);
    for (const [, path] of html.matchAll(/(?:src|href)="(\/[^"#]*)"/g)) {
      const target = path.endsWith("/") ? `${path}index.html` : path;
      assert.ok(existsSync(new URL(`../dist${target}`, import.meta.url)), `${file}: ${path}`);
    }
  }
});

test("the navbar: Sign in and Create account go straight to management in the page's language", () => {
  const label = { nl: ["Aanmelden", "Account aanmaken"], en: ["Sign in", "Create account"], fr: ["Se connecter", "Créer un compte"], de: ["Anmelden", "Konto erstellen"] };
  for (const [folder, , , lang] of LANGUAGES) {
    const html = read(`${folder}index.html`);
    const [login, register] = label[lang];
    assert.match(html, new RegExp(`<a class="nav-link" href="https://management\\.breinhap\\.com/login\\?lang=${lang}" data-account="login">${login}</a>`), lang);
    assert.match(html, new RegExp(`<a class="nav-cta" href="https://management\\.breinhap\\.com/register\\?lang=${lang}" data-account="register">${register}</a>`), lang);
    // the OS light/dark toggle, not a glyph
    assert.match(html, /<button type="button" class="os-theme-toggle" data-theme-toggle aria-label="[^"]+" aria-pressed="false" title="[^"]+"><svg/);
    assert.doesNotMatch(html, /◐/);
    assert.match(html, /<div class="tools" role="group" aria-label="[^"]+">/);
  }
  assert.doesNotMatch(read("index.html"), /href="\/login"|href="\/register"/);
});

test("the language selector: the plain links work without JavaScript, the selector script is the shared bundle", () => {
  for (const [folder, , , lang] of LANGUAGES) {
    const html = read(`${folder}index.html`);
    assert.ok(html.includes(`<div class="locale-selector" data-locale-selector data-lang="${lang}"><nav class="lang-switch" aria-label="Taal · Langue · Sprache · Language">`), lang);
    assert.ok(html.includes(`<span aria-current="true" lang="${lang}">${lang.toUpperCase()}</span>`), lang);
    for (const [, , path, other] of LANGUAGES.filter(([, , , l]) => l !== lang))
      assert.ok(html.includes(`<a href="${path}" hreflang="${other}" lang="${other}"`), `${lang} → ${other}`);
    assert.ok(html.includes('<link rel="stylesheet" href="/locale-selector.css">'), lang);
    assert.ok(html.includes('<script src="/locale-selector.js" defer></script>'), lang);
  }
  const shared = (name) => readFileSync(new URL(`../../site/public/${name}`, import.meta.url), "utf8");
  assert.equal(read("locale-selector.js"), shared("locale-selector.js"));
  assert.equal(read("locale-selector.css"), shared("locale-selector.css"));
  // one choice for breinhap.com and management.breinhap.com: the parent domain's cookie
  assert.match(read("locale-selector.js"), /breinhap-lang=/);
  assert.match(read("locale-selector.js"), /Domain=breinhap\.com/);
});

test("login and register links from before go to management, in the same language, and keep the security headers", () => {
  const nginx = readFileSync(new URL("../nginx.conf", import.meta.url), "utf8");
  assert.match(nginx, /location ~ \^\/\(login\|register\)\/\?\$ \{\s*return 302 https:\/\/management\.breinhap\.com\/\$1\?lang=nl;/);
  assert.match(nginx, /location ~ \^\/\(en\|fr\|de\)\/\(login\|register\)\/\?\$ \{\s*return 302 https:\/\/management\.breinhap\.com\/\$2\?lang=\$1;/);
  for (const folder of ["login", "register", "en/login", "en/register", "fr/login", "de/register"])
    assert.equal(existsSync(new URL(`../dist/${folder}/index.html`, import.meta.url)), false, `${folder} is no page any more`);
  // add_header lives at server level only, so a redirect still carries it
  const redirects = [...nginx.matchAll(/location ~[^{]*\{[^}]*\}/g)].map((m) => m[0]);
  assert.equal(redirects.length, 2);
  for (const block of redirects) assert.doesNotMatch(block, /add_header/);
});

test("the navbar's account state comes from management, and the CSP allows only that", () => {
  const nginx = readFileSync(new URL("../nginx.conf", import.meta.url), "utf8");
  assert.match(nginx, /connect-src https:\/\/management\.breinhap\.com;/);
  const script = read("account.js");
  assert.match(script, /"https:\/\/management\.breinhap\.com"/);
  assert.match(script, /\/auth\/session/);
  assert.match(script, /credentials: "include"/);
  // breinhap#24 (S4): asked again within 60 s so a logout or revocation reaches an open page
  assert.match(script, /RECHECK_MS = 60000/);
  assert.match(script, /visibilitychange/);
  const labels = {
    "": ["nl", "Account", "Breinhap beheer", "Mijn account"],
    "en/": ["en", "Account", "Breinhap management", "My account"],
    "fr/": ["fr", "Compte", "Gestion Breinhap", "Mon compte"],
    "de/": ["de", "Konto", "Breinhap-Verwaltung", "Mein Konto"],
  };
  for (const [folder, [lang, account, manage, profile]] of Object.entries(labels)) {
    const html = read(`${folder}index.html`);
    // not deferred: it marks the page as checking before the navbar paints (no flash of Sign in)
    assert.ok(html.includes('<script src="/account.js"></script>'), folder);
    assert.doesNotMatch(html, /account\.js" defer/);
    assert.match(html, /data-account="login"/, folder);
    assert.match(html, /data-account="register"/, folder);
    const menu = /<details class="account-menu" data-account="menu" hidden>.*?<\/details>/.exec(html)?.[0];
    assert.ok(menu, folder);
    // its accessible name contains the visible label (WCAG 2.5.3); the initials are decoration
    assert.ok(menu.includes(`<summary class="account-trigger"><span class="account-initials" data-account="initials" aria-hidden="true"></span><span>${account}</span></summary>`), folder);
    assert.doesNotMatch(menu, /aria-label/);
    // the management entry is hidden until management reports access; nothing in the page grants it
    assert.ok(menu.includes(`<a href="https://management.breinhap.com/?lang=${lang}" data-account="manage" hidden>${manage}</a>`), folder);
    assert.ok(menu.includes(`<a href="https://management.breinhap.com/?lang=${lang}" data-account="profile" hidden>${profile}</a>`), folder);
    assert.ok(menu.includes(`href="https://management.breinhap.com/login?switch=1&amp;lang=${lang}"`), folder);
  }
  const css = read("styles.css");
  assert.match(css, /html\[data-account-state="checking"\] \.nav-actions \{ visibility: hidden; \}/);
});
