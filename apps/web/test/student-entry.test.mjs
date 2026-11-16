import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// breinhap#138: the student entry exists only with the student route. `pnpm test` builds dist/ with the committed
// switch (off); this file also builds a copy with it on, to check both.
const build = fileURLToPath(new URL("../src/build.mjs", import.meta.url));
const on = mkdtempSync(join(tmpdir(), "breinhap-web-student-"));
execFileSync(process.execPath, [build], { env: { ...process.env, BREINHAP_STUDENT_ROUTE: "1", BREINHAP_WEB_DIST: on }, stdio: "ignore" });
after(() => rmSync(on, { recursive: true, force: true }));
const off = (path) => readFileSync(new URL(`../dist/${path}`, import.meta.url), "utf8");
const withRoute = (path) => readFileSync(join(on, path), "utf8");
const PAGES = ["index.html", "en/index.html", "fr/index.html", "de/index.html", "404.html"];
const LABELS = {
  "index.html": ["Leerling aanmelden", "Mijn opdrachten"],
  "en/index.html": ["Student sign-in", "My assignments"],
  "fr/index.html": ["Connexion élève", "Mes devoirs"],
  "de/index.html": ["Schüleranmeldung", "Meine Aufgaben"],
};

test("the committed switch is off, so nothing points at /p before the edge routes it", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.breinhap.studentRoute, false);
  for (const page of PAGES) {
    const html = off(page);
    assert.doesNotMatch(html, /href="\/p[/"]|data-student-route|data-account="student"/, page);
  }
});

test("with the route: a student entry in the navbar and on the home page, in four languages, to /p/mijn", () => {
  for (const [page, [signIn, mine]] of Object.entries(LABELS)) {
    const html = withRoute(page);
    assert.match(html, /<html lang="[^"]+" data-student-route>/, page);
    const entry = /<a class="nav-link student-entry" href="\/p\/mijn" data-account="student">.*?<\/a>/.exec(html)?.[0];
    assert.ok(entry, page);
    // the visible word is the accessible name (WCAG 2.5.3); the initials are decoration
    assert.ok(entry.includes(`<span class="account-initials" data-account="student-initials" aria-hidden="true"></span><span data-account="student-label" data-signed-in="${mine}">${signIn}</span>`), page);
    assert.doesNotMatch(entry, /aria-label/);
    // next to the adult sign-in, which is unchanged
    assert.ok(html.indexOf('data-account="student"') < html.indexOf('data-account="login"'), page);
    assert.match(html, /<a class="nav-link" href="https:\/\/management\.breinhap\.com\/login\?lang=\w\w" data-account="login">/, page);
    // the home page: a quiet second button next to the Android link; the try-out stays as it is
    assert.ok(html.includes(`<a class="button button-quiet" href="/p/mijn">${mine}</a></p>`), page);
    assert.match(html, /<section class="example" id="voorbeeld"/, page);
    // still nothing inline the CSP would refuse
    assert.doesNotMatch(html, /<style\b|\sstyle=|\son\w+=|<script(?![^>]*(?:src=|type="application\/json"))/, page);
  }
  // apart from the entry, the pages are the same as without the route
  const strip = (html) =>
    html
      .replace(" data-student-route", "")
      .replace(/<a class="nav-link student-entry".*?<\/a>/, "")
      .replace('<p class="hero-actions">', "")
      .replace(/<a class="button button-quiet" href="\/p\/mijn">[^<]*<\/a><\/p>/, "");
  for (const page of PAGES) assert.equal(strip(withRoute(page)), off(page), page);
});

/** Runs account.js in a small fake page and records what it asks. */
function run(html, answers) {
  const elements = {};
  const element = (name, extra = {}) => (elements[name] = { hidden: name === "menu" || name === "manage" || name === "profile", textContent: "", attributes: {}, ...extra,
    hasAttribute(n) { return n in this.attributes; }, getAttribute(n) { return this.attributes[n] ?? null; }, setAttribute(n, v) { this.attributes[n] = String(v); } });
  for (const name of ["login", "register", "menu", "manage", "profile", "initials", "student", "student-initials"]) element(name);
  element("student-label", { textContent: "Leerling aanmelden", attributes: { "data-signed-in": "Mijn opdrachten" } });
  const rootAttributes = { ...(html.includes("data-student-route") ? { "data-student-route": "" } : {}) };
  const asked = [];
  const sandbox = {
    window: {},
    document: {
      readyState: "complete",
      documentElement: { hasAttribute: (n) => n in rootAttributes, getAttribute: (n) => rootAttributes[n] ?? null, setAttribute: (n, v) => (rootAttributes[n] = v) },
      querySelector: (selector) => elements[/data-account="([^"]+)"/.exec(selector)[1]] ?? null,
      addEventListener() {},
      dispatchEvent() {},
      visibilityState: "visible",
    },
    fetch: (url, options) => {
      asked.push([url, options.credentials]);
      const value = answers[url];
      return Promise.resolve({ ok: value !== undefined, json: () => Promise.resolve(value) });
    },
    setTimeout: () => 0, clearTimeout() {}, setInterval() {},
    CustomEvent: function () {},
  };
  sandbox.window = sandbox;
  vm.runInNewContext(readFileSync(join(on, "account.js"), "utf8"), sandbox);
  return new Promise((resolve) => setImmediate(() => setImmediate(() => resolve({ asked, elements }))));
}

test("account.js asks the same-origin /p/session only on a page built with the route, and shows the initials", async () => {
  const MANAGEMENT = "https://management.breinhap.com/auth/session";
  const without = await run(off("index.html"), { [MANAGEMENT]: { active: false } });
  assert.deepEqual(without.asked, [[MANAGEMENT, "include"]]);

  const student = await run(withRoute("index.html"), { [MANAGEMENT]: { active: false }, "/p/session": { active: true, initials: "LM" } });
  assert.deepEqual(student.asked, [[MANAGEMENT, "include"], ["/p/session", "same-origin"]]);
  assert.equal(student.elements["student-label"].textContent, "Mijn opdrachten");
  assert.equal(student.elements["student-initials"].textContent, "LM");
  assert.equal(student.elements.student.hidden, false);

  const signedOut = await run(withRoute("index.html"), { [MANAGEMENT]: { active: false }, "/p/session": { active: false } });
  assert.equal(signedOut.elements["student-label"].textContent, "Leerling aanmelden");
  assert.equal(signedOut.elements["student-initials"].textContent, "");

  // only the shape /p/session sends is accepted: no markup reaches the navbar
  const odd = await run(withRoute("index.html"), { [MANAGEMENT]: { active: false }, "/p/session": { active: true, initials: "<b>" } });
  assert.equal(odd.elements["student-initials"].textContent, "");

  // an adult who is signed in does not see the student entry (an adult account gets no student session)
  const adult = await run(withRoute("index.html"), { [MANAGEMENT]: { active: true, access: true, initials: "AS" }, "/p/session": { active: false } });
  assert.equal(adult.elements.student.hidden, true);
});

test("the edge route sends exactly /p, /p/ and /p/... to the learner handler and everything else to this site", () => {
  const caddy = readFileSync(new URL("../../../infra/site/breinhap.caddy", import.meta.url), "utf8");
  const site = /^breinhap\.com \{\n([\s\S]*?)\n\}\n/m.exec(caddy)?.[1];
  assert.ok(site);
  // not /p* (that would take /pizza): the bare path and the subtree only
  assert.match(site, /^ {2}@learner path \/p \/p\/\*$/m);
  assert.match(site, /handle @learner \{\s*reverse_proxy breinhap-management:8080 \{\s*header_up X-Breinhap-Client-Address \{remote_host\}\s*\}\s*\}/);
  // the public Host is kept (no header_up Host), and the rest stays with the static website
  assert.doesNotMatch(site, /header_up Host/);
  assert.match(site, /handle \{\s*reverse_proxy breinhap-web:8080\s*\}/);
  assert.equal([...site.matchAll(/reverse_proxy/g)].length, 2);
  assert.match(site, /Rollback:/);
});
