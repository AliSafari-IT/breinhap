import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const shared = join(root, "../site");
const origin = "https://breinhap.com";
const copy = {
  nl: {
    lang: "nl-BE", other: "English", otherPath: "/en/", skip: "Naar de inhoud", theme: "Donker thema",
    title: "Leren in kleine happen.", intro: "Een rustige plek om te beginnen, één kleine stap tegelijk.",
    badge: "Binnenkort op het web", notice: "We bouwen Breinhap stap voor stap. Dit is onze eerste pagina; je kunt hier nog geen missies starten.",
    text: "Breinhap helpt je om te starten met studeren. Korte missies, duidelijke stappen en ruimte om op je eigen tempo te leren.",
    next: "Wat je straks kunt verwachten", cards: [
      ["Eén korte missie", "Een behapbare stap die past bij de tijd en energie die je hebt."],
      ["Een vast ritme", "Opwarmen, leren, doen en checken. Je weet steeds wat er komt."],
      ["Zonder tijdsdruk", "Geen streaks of straf voor een pauze. Je begint wanneer jij er klaar voor bent."],
    ],
    android: "Begonnen als Android-app", androidText: "De Android-app is het vertrekpunt. Nu maken we stap voor stap ook ruimte voor leren in je browser.",
    link: "Meer over Breinhap en Android", privacy: "Privacy", terms: "Voorwaarden", cookies: "Cookies", deletion: "Je gegevens verwijderen",
    footer: "Kleine stappen. Op jouw tempo.", missing: "Deze pagina bestaat nog niet.", back: "Terug naar Breinhap",
  },
  en: {
    lang: "en", other: "Nederlands", otherPath: "/", skip: "Skip to content", theme: "Dark theme",
    title: "Learning in small bites.", intro: "A calm place to start, one small step at a time.",
    badge: "Coming soon to the web", notice: "We are building Breinhap step by step. This is our first page; you cannot start missions here yet.",
    text: "Breinhap helps you get started with studying. Short missions, clear steps and room to learn at your own pace.",
    next: "What to look forward to", cards: [
      ["One short mission", "A manageable step that fits the time and energy you have."],
      ["A familiar rhythm", "Warm up, learn, practise and check. You always know what comes next."],
      ["Without time pressure", "No streaks or penalties for taking a break. Start when you are ready."],
    ],
    android: "Started as an Android app", androidText: "The Android app is our starting point. Now we are gradually making room for learning in your browser too.",
    link: "About Breinhap and Android", privacy: "Privacy", terms: "Terms", cookies: "Cookies", deletion: "Delete your data",
    footer: "Small steps. At your pace.", missing: "This page does not exist yet.", back: "Back to Breinhap",
  },
};
const esc = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
function page(lang, missing = false) {
  const t = copy[lang];
  const path = lang === "nl" ? "/" : "/en/";
  const legal = lang === "nl" ? ["privacy", "voorwaarden", "cookies", "account-verwijderen"] : ["en/privacy", "en/terms", "en/cookies", "en/delete-account"];
  return `<!doctype html>
<html lang="${t.lang}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Breinhap · ${esc(missing ? t.missing : t.title)}</title>
<meta name="description" content="${esc(t.intro)}">
${missing ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${origin}${path}">`}
<link rel="alternate" hreflang="nl-BE" href="${origin}/"><link rel="alternate" hreflang="en" href="${origin}/en/">
<link rel="alternate" hreflang="x-default" href="${origin}/">
<meta property="og:title" content="Breinhap · ${esc(t.title)}"><meta property="og:description" content="${esc(t.intro)}">
<meta property="og:type" content="website"><meta property="og:url" content="${origin}${path}">
<meta name="theme-color" content="#222222"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css"><script src="/theme.js"></script>
</head>
<body>
<a class="skip" href="#main">${t.skip}</a>
<header class="os-topbar"><div class="wrap topbar-inner">
  <a class="brand" href="${path}"><img src="/logo.svg" width="40" height="40" alt=""><span>Breinhap</span></a>
  <div class="tools"><a href="${t.otherPath}" lang="${lang === "nl" ? "en" : "nl-BE"}">${t.other}</a>
  <button type="button" data-theme-toggle aria-label="${t.theme}" aria-pressed="false">◐</button></div>
</div></header>
<aside class="release-banner" aria-label="${t.badge}"><div class="wrap"><strong>${t.badge}</strong><p>${t.notice}</p></div></aside>
<main id="main" class="wrap">
${missing ? `<section class="hero"><h1>${t.missing}</h1><a class="button" href="${path}">${t.back}</a></section>` : `
<section class="hero"><p class="eyebrow">Breinhap</p><h1>${t.title}</h1><p class="lead">${t.intro}</p><p class="intro">${t.text}</p>
<a class="button" href="https://breinhap.asafarim.site${path}">${t.link} <span aria-hidden="true">↗</span></a></section>
<section class="expect"><h2>${t.next}</h2><div class="cards">${t.cards.map(([title, text], index) => `<article class="card"><span class="number" aria-hidden="true">0${index + 1}</span><h3>${title}</h3><p>${text}</p></article>`).join("")}</div></section>
<section class="android"><h2>${t.android}</h2><p>${t.androidText}</p></section>`}
</main>
<footer class="wrap"><p><strong>Breinhap</strong> · ${t.footer}</p><nav aria-label="${lang === "nl" ? "Juridisch" : "Legal"}">${[t.privacy, t.terms, t.cookies, t.deletion].map((label, i) => `<a href="https://breinhap.asafarim.site/${legal[i]}/">${label}</a>`).join("")}</nav></footer>
</body></html>`;
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "en"), { recursive: true });
for (const asset of ["logo.svg", "favicon.svg", "theme.js"]) cpSync(join(shared, "public", asset), join(dist, asset));
writeFileSync(join(dist, "styles.css"), readFileSync(join(shared, "src/theme.css"), "utf8") + "\n" + readFileSync(join(root, "src/styles.css"), "utf8"));
writeFileSync(join(dist, "index.html"), page("nl"));
writeFileSync(join(dist, "en/index.html"), page("en"));
writeFileSync(join(dist, "404.html"), page("nl", true));
writeFileSync(join(dist, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
writeFileSync(join(dist, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url><url><loc>${origin}/en/</loc></url></urlset>\n`);
console.log(`Built ${dist}`);
