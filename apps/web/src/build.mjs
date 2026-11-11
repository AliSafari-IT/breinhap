import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const shared = join(root, "../site");
const origin = "https://breinhap.com";
/** Sign in and registration are management's pages: the navbar goes straight there, in the page's language. */
const MANAGEMENT = "https://management.breinhap.com";

/**
 * breinhap.com in Belgium's three languages plus English, like asafarim.site: Dutch at /, then /en/, /fr/ and
 * /de/. The Android site (breinhap.asafarim.site) only has Dutch and English pages, so French and German visitors
 * are sent to its English ones.
 */
const LANGUAGES = ["nl", "en", "fr", "de"];
const pathOf = (lang) => (lang === "nl" ? "/" : `/${lang}/`);
const LANGUAGE_NAMES = { nl: "Nederlands", en: "English", fr: "Français", de: "Deutsch" };
const HTML_LANG = { nl: "nl-BE", en: "en", fr: "fr-BE", de: "de-BE" };
const OG_LOCALE = { nl: "nl_BE", en: "en_GB", fr: "fr_BE", de: "de_BE" };
const androidLang = (lang) => (lang === "nl" ? "nl" : "en");
const LEGAL_PATHS = {
  nl: ["privacy", "voorwaarden", "cookies", "account-verwijderen"],
  en: ["en/privacy", "en/terms", "en/cookies", "en/delete-account"],
};

const copy = {
  nl: {
    skip: "Naar de inhoud", theme: "Donker thema", mainNav: "Hoofdmenu", languageLabel: "Taal · Langue · Sprache · Language",
    login: "Aanmelden", register: "Account aanmaken", account: "Account", manage: "Breinhap beheer", myAccount: "Mijn account", switchAccount: "Wissel van account", legalNav: "Juridisch",
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
    skip: "Skip to content", theme: "Dark theme", mainNav: "Main", languageLabel: "Taal · Langue · Sprache · Language",
    login: "Sign in", register: "Create account", account: "Account", manage: "Breinhap management", myAccount: "My account", switchAccount: "Switch account", legalNav: "Legal",
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
  fr: {
    skip: "Aller au contenu", theme: "Thème sombre", mainNav: "Menu principal", languageLabel: "Taal · Langue · Sprache · Language",
    login: "Se connecter", register: "Créer un compte", account: "Compte", manage: "Gestion Breinhap", myAccount: "Mon compte", switchAccount: "Changer de compte", legalNav: "Mentions légales",
    title: "Apprendre par petites bouchées.", intro: "Un endroit calme pour commencer, une petite étape à la fois.",
    badge: "Bientôt sur le web", notice: "Nous construisons Breinhap étape par étape. Voici notre première page ; vous ne pouvez pas encore y lancer de missions.",
    text: "Breinhap vous aide à vous mettre aux études. De courtes missions, des étapes claires et la place d’apprendre à votre rythme.",
    next: "Ce qui vous attend", cards: [
      ["Une courte mission", "Une étape à votre portée, adaptée au temps et à l’énergie dont vous disposez."],
      ["Un rythme familier", "Échauffement, apprentissage, pratique et vérification. Vous savez toujours ce qui vient ensuite."],
      ["Sans pression du temps", "Pas de séries à tenir ni de pénalité pour une pause. Vous commencez quand vous êtes prêt."],
    ],
    android: "Né comme application Android", androidText: "L’application Android est notre point de départ. Nous faisons maintenant peu à peu de la place à l’apprentissage dans votre navigateur.",
    link: "En savoir plus sur Breinhap et Android", privacy: "Confidentialité", terms: "Conditions", cookies: "Cookies", deletion: "Supprimer vos données",
    footer: "Petits pas. À votre rythme.", missing: "Cette page n’existe pas encore.", back: "Retour à Breinhap",
  },
  de: {
    skip: "Zum Inhalt", theme: "Dunkles Design", mainNav: "Hauptmenü", languageLabel: "Taal · Langue · Sprache · Language",
    login: "Anmelden", register: "Konto erstellen", account: "Konto", manage: "Breinhap-Verwaltung", myAccount: "Mein Konto", switchAccount: "Konto wechseln", legalNav: "Rechtliches",
    title: "Lernen in kleinen Happen.", intro: "Ein ruhiger Ort zum Anfangen, ein kleiner Schritt nach dem anderen.",
    badge: "Bald im Web", notice: "Wir bauen Breinhap Schritt für Schritt. Dies ist unsere erste Seite; Missionen können Sie hier noch nicht starten.",
    text: "Breinhap hilft Ihnen beim Einstieg ins Lernen. Kurze Missionen, klare Schritte und Raum, in Ihrem eigenen Tempo zu lernen.",
    next: "Was Sie erwartet", cards: [
      ["Eine kurze Mission", "Ein machbarer Schritt, der zu Ihrer Zeit und Energie passt."],
      ["Ein vertrauter Rhythmus", "Aufwärmen, lernen, üben und prüfen. Sie wissen immer, was als Nächstes kommt."],
      ["Ohne Zeitdruck", "Keine Serien und keine Strafe für eine Pause. Sie fangen an, wenn Sie bereit sind."],
    ],
    android: "Als Android-App gestartet", androidText: "Die Android-App ist unser Ausgangspunkt. Jetzt schaffen wir Schritt für Schritt auch Platz zum Lernen in Ihrem Browser.",
    link: "Mehr über Breinhap und Android", privacy: "Datenschutz", terms: "Nutzungsbedingungen", cookies: "Cookies", deletion: "Ihre Daten löschen",
    footer: "Kleine Schritte. In Ihrem Tempo.", missing: "Diese Seite gibt es noch nicht.", back: "Zurück zu Breinhap",
  },
};

const esc = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

/** The OS's sun-that-sets-into-a-moon toggle (asafarim-os packages/theme/toggle.html), styled by theme.css. */
const themeToggle = (label) => `<button type="button" class="os-theme-toggle" data-theme-toggle aria-label="${esc(label)}" aria-pressed="false" title="${esc(label)}"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><mask id="os-theme-moon"><rect width="24" height="24" fill="#fff"/><circle class="os-theme-bite" cx="17.5" cy="6.5" r="6" fill="#000"/></mask><circle class="os-theme-core" cx="12" cy="12" r="5" fill="currentColor" mask="url(#os-theme-moon)"/><path class="os-theme-rays" d="M12 1.5v2.5M12 20v2.5M1.5 12h2.5M20 12h2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg></button>`;

/**
 * The language selector's mount (bundled country & language selector, /locale-selector.js), with one plain link per
 * language inside: without JavaScript those links are the switcher. The script reads them to know where each
 * language lives.
 */
const switcher = (lang, t) =>
  `<div class="locale-selector" data-locale-selector data-lang="${lang}"><nav class="lang-switch" aria-label="${esc(t.languageLabel)}">${LANGUAGES.map((l) =>
    l === lang
      ? `<span aria-current="true" lang="${l}">${l.toUpperCase()}</span>`
      : `<a href="${pathOf(l)}" hreflang="${l}" lang="${l}" title="${LANGUAGE_NAMES[l]}">${l.toUpperCase()}</a>`,
  ).join("")}</nav></div>`;

/**
 * The signed-in account menu (breinhap#24, S4), hidden until /account.js learns from management that this visitor
 * has a Breinhap session. "Breinhap beheer" shows only when management reports management access; otherwise "My
 * account" leads to the registration and role status. The initials are decoration: the visible word names the
 * control, so its accessible name contains its visible label (WCAG 2.5.3, #90).
 */
const accountMenu = (lang, t) =>
  `<details class="account-menu" data-account="menu" hidden><summary class="account-trigger"><span class="account-initials" data-account="initials" aria-hidden="true"></span><span>${esc(t.account)}</span></summary><div class="account-panel"><a href="${MANAGEMENT}/?lang=${lang}" data-account="manage" hidden>${esc(t.manage)}</a><a href="${MANAGEMENT}/?lang=${lang}" data-account="profile" hidden>${esc(t.myAccount)}</a><a href="${MANAGEMENT}/login?switch=1&amp;lang=${lang}">${esc(t.switchAccount)}</a></div></details>`;

function page(lang, missing = false) {
  const t = copy[lang];
  const path = pathOf(lang);
  const legal = LEGAL_PATHS[androidLang(lang)];
  const androidPath = pathOf(androidLang(lang));
  const entry = (kind) => `${MANAGEMENT}/${kind}?lang=${lang}`;
  return `<!doctype html>
<html lang="${HTML_LANG[lang]}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Breinhap · ${esc(missing ? t.missing : t.title)}</title>
<meta name="description" content="${esc(t.intro)}">
${missing ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${origin}${path}">`}
${LANGUAGES.map((l) => `<link rel="alternate" hreflang="${HTML_LANG[l]}" href="${origin}${pathOf(l)}">`).join("")}
<link rel="alternate" hreflang="x-default" href="${origin}/">
<meta property="og:title" content="Breinhap · ${esc(t.title)}"><meta property="og:description" content="${esc(t.intro)}">
<meta property="og:type" content="website"><meta property="og:url" content="${origin}${path}"><meta property="og:locale" content="${OG_LOCALE[lang]}">
<meta name="theme-color" content="#222222"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/locale-selector.css"><script src="/theme.js"></script><script src="/locale-selector.js" defer></script><script src="/account.js"></script>
</head>
<body>
<a class="skip" href="#main">${t.skip}</a>
<header class="os-topbar"><div class="wrap topbar-inner">
  <a class="brand" href="${path}"><img src="/logo.svg" width="40" height="40" alt=""><span>Breinhap</span></a>
  <div class="tools" role="group" aria-label="${esc(t.mainNav)}">
    <div class="nav-actions"><a class="nav-link" href="${entry("login")}" data-account="login">${t.login}</a><a class="nav-cta" href="${entry("register")}" data-account="register">${t.register}</a>${accountMenu(lang, t)}</div>
    ${switcher(lang, t)}
    ${themeToggle(t.theme)}
  </div>
</div></header>
<aside class="release-banner" aria-label="${esc(t.badge)}"><div class="wrap"><strong>${t.badge}</strong><p>${t.notice}</p></div></aside>
<main id="main" class="wrap">
${missing ? `<section class="hero"><h1>${t.missing}</h1><a class="button" href="${path}">${t.back}</a></section>` : `
<section class="hero"><p class="eyebrow">Breinhap</p><h1>${t.title}</h1><p class="lead">${t.intro}</p><p class="intro">${t.text}</p>
<a class="button" href="https://breinhap.asafarim.site${androidPath}">${t.link} <span aria-hidden="true">↗</span></a></section>
<section class="expect"><h2>${t.next}</h2><div class="cards">${t.cards.map(([title, text], index) => `<article class="card"><span class="number" aria-hidden="true">0${index + 1}</span><h3>${title}</h3><p>${text}</p></article>`).join("")}</div></section>
<section class="android"><h2>${t.android}</h2><p>${t.androidText}</p></section>`}
</main>
<footer class="wrap"><p><strong>Breinhap</strong> · ${t.footer} · Website v${version}</p><nav aria-label="${esc(t.legalNav)}">${[t.privacy, t.terms, t.cookies, t.deletion].map((label, i) => `<a href="https://breinhap.asafarim.site/${legal[i]}/">${label}</a>`).join("")}</nav></footer>
</body></html>`;
}

rmSync(dist, { recursive: true, force: true });
for (const lang of LANGUAGES) mkdirSync(join(dist, lang === "nl" ? "" : lang), { recursive: true });
for (const asset of ["logo.svg", "favicon.svg", "theme.js", "locale-selector.js", "locale-selector.css"]) cpSync(join(shared, "public", asset), join(dist, asset));
cpSync(join(root, "src/account.js"), join(dist, "account.js"));
writeFileSync(join(dist, "styles.css"), readFileSync(join(shared, "src/theme.css"), "utf8") + "\n" + readFileSync(join(root, "src/styles.css"), "utf8"));
for (const lang of LANGUAGES) writeFileSync(join(dist, lang === "nl" ? "" : lang, "index.html"), page(lang));
writeFileSync(join(dist, "404.html"), page("nl", true));

writeFileSync(join(dist, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
writeFileSync(join(dist, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${LANGUAGES.map((l) => `<url><loc>${origin}${pathOf(l)}</loc></url>`).join("")}</urlset>\n`);
console.log(`Built ${dist}`);
