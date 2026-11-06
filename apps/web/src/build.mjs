import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
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
<link rel="stylesheet" href="/styles.css"><script src="/theme.js"></script><script src="/account.js" defer></script>
</head>
<body>
<a class="skip" href="#main">${t.skip}</a>
<header class="os-topbar"><div class="wrap topbar-inner">
  <a class="brand" href="${path}"><img src="/logo.svg" width="40" height="40" alt=""><span>Breinhap</span></a>
  <div class="tools"><a href="${lang === "nl" ? "/login" : "/en/login"}" data-account="login" data-signed-in-label="${lang === "nl" ? "Naar Breinhap beheer" : "Go to Breinhap management"}">${lang === "nl" ? "Aanmelden" : "Sign in"}</a><a href="${lang === "nl" ? "/register" : "/en/register"}" data-account="register">${lang === "nl" ? "Account aanmaken" : "Create account"}</a><a href="${t.otherPath}" lang="${lang === "nl" ? "en" : "nl-BE"}">${t.other}</a>
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
<footer class="wrap"><p><strong>Breinhap</strong> · ${t.footer} · Website v${version}</p><nav aria-label="${lang === "nl" ? "Juridisch" : "Legal"}">${[t.privacy, t.terms, t.cookies, t.deletion].map((label, i) => `<a href="https://breinhap.asafarim.site/${legal[i]}/">${label}</a>`).join("")}</nav></footer>
</body></html>`;
}

// breinhap.com/login and /register: the adult entry, as one sign-in card that goes straight to the
// sign-in and registration pages on management (an e-mail code; ASafariM only sends it). Management
// then asks for the role, so registering and signing in are the same safe flow with different words.
const MANAGEMENT = "https://management.breinhap.com";
const entry = {
  nl: {
    eyebrow: "Voor ouders, begeleiders en leerkrachten",
    login: { title: "Aanmelden", lead: "Welkom terug. Meld je aan om verder te werken met je leerlingen en je leerinhoud.", button: "Doorgaan naar aanmelden", switchText: "Nieuw bij Breinhap?", switchLink: "Account aanmaken" },
    register: { title: "Account aanmaken", lead: "Maak een account voor de Breinhap-werkplek. Je hebt geen uitnodiging nodig.", button: "Account aanmaken", switchText: "Heb je al een account?", switchLink: "Aanmelden" },
    steps: [["Bevestig je e-mailadres", "Met een code die we je mailen. Geen wachtwoord nodig."], ["Vul je gegevens in", "Je naam, je rol (ouder, begeleider of leerkracht) en je school."], ["Een beheerder keurt goed", "Daarna kom je meteen in je werkplek."]],
    stepsTitle: "Zo werkt het",
    secure: "Je account loopt via ASafariM, het beveiligde aanmeldplatform achter Breinhap. Je meldt je aan met een code per e-mail: er is geen wachtwoord dat kan uitlekken.",
    student: "<strong>Ben je leerling?</strong> Je hebt geen account nodig. Voor leerlingen is aanmelden nog niet beschikbaar.",
    sideTitle: "Je werkplek bij Breinhap",
    side: [["Leerlingen en groepen", "Volg je kind of je leerlingen op, binnen de groepen die je beheert."], ["Leerinhoud maken", "Missies in vier vaste stappen, en een voorbeeld zoals een leerling ze ziet."], ["Rustig en veilig", "Geen advertenties, geen tracking en geen gezondheidsgegevens."]],
    roles: [["Ouder", "Je volgt je kind op."], ["Begeleider", "Je begeleidt leerlingen buiten de klas."], ["Leerkracht", "Je geeft les aan leerlingen."]],
    rolesTitle: "Voor wie?",
    loginPath: "/login", registerPath: "/register",
  },
  en: {
    eyebrow: "For parents, tutors and teachers",
    login: { title: "Sign in", lead: "Welcome back. Sign in to continue working with your students and your learning content.", button: "Continue to sign in", switchText: "New to Breinhap?", switchLink: "Create an account" },
    register: { title: "Create an account", lead: "Create an account for the Breinhap workspace. No invitation needed.", button: "Create an account", switchText: "Already have an account?", switchLink: "Sign in" },
    steps: [["Confirm your e-mail", "With a code we send you. No password needed."], ["Fill in your details", "Your name, your role (parent, tutor or teacher) and your school."], ["An administrator approves", "Then your workspace opens right away."]],
    stepsTitle: "How it works",
    secure: "Your account runs through ASafariM, the secure sign-in platform behind Breinhap. You sign in with a code by e-mail: there is no password that could leak.",
    student: "<strong>Are you a student?</strong> You do not need an account. Student sign-in is not available yet.",
    sideTitle: "Your Breinhap workspace",
    side: [["Students and groups", "Follow your child or your students, within the groups you manage."], ["Create learning content", "Missions in four fixed steps, with a preview as a student sees them."], ["Calm and safe", "No ads, no tracking and no health data."]],
    roles: [["Parent", "You follow your child."], ["Tutor", "You support students outside the classroom."], ["Teacher", "You teach students."]],
    rolesTitle: "Who is it for?",
    loginPath: "/en/login", registerPath: "/en/register",
  },
};

function entryPage(lang, kind) {
  const nl = lang === "nl";
  const e = entry[lang];
  const k = e[kind];
  const registering = kind === "register";
  const route = `${nl ? "" : "/en"}/${kind}`;
  const steps = `<ol class="auth-steps" aria-label="${e.stepsTitle}">${e.steps.map(([title, text], i) => `<li><span class="step-n" aria-hidden="true">${i + 1}</span><div><strong>${title}</strong><small>${text}</small></div></li>`).join("")}</ol>`;
  const card = `<section class="auth-card" aria-labelledby="auth-title">
<img class="auth-logo" src="/logo.svg" width="56" height="56" alt="">
<p class="eyebrow">${e.eyebrow}</p>
<h1 id="auth-title">${k.title}</h1>
<p class="auth-lead">${k.lead}</p>
${registering ? steps : ""}
<a class="button button-block" href="${MANAGEMENT}/${kind}?lang=${lang}">${k.button} <span aria-hidden="true">→</span></a>
<p class="auth-secure"><svg class="lock" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg> ${e.secure}</p>
<p class="auth-switch">${k.switchText} <a href="${registering ? e.loginPath : e.registerPath}">${k.switchLink}</a></p>
<p class="auth-student">${e.student}</p>
</section>`;
  const side = registering
    ? `<aside class="auth-side" aria-labelledby="side-title"><h2 id="side-title">${e.rolesTitle}</h2><ul class="role-list">${e.roles.map(([name, text]) => `<li><strong>${name}</strong><span>${text}</span></li>`).join("")}</ul><h2>${e.sideTitle}</h2><ul class="side-list">${e.side.map(([t, x]) => `<li><strong>${t}</strong><span>${x}</span></li>`).join("")}</ul></aside>`
    : `<aside class="auth-side" aria-labelledby="side-title"><h2 id="side-title">${e.sideTitle}</h2><ul class="side-list">${e.side.map(([t, x]) => `<li><strong>${t}</strong><span>${x}</span></li>`).join("")}</ul><h2>${e.stepsTitle}</h2>${steps}</aside>`;
  const title = `${k.title} · Breinhap`;
  let html = page(lang).replace(/<main id="main" class="wrap">[\s\S]*?<\/main>/, `<main id="main" class="wrap auth">${card}${side}</main>`);
  html = html.replace(/<aside class="release-banner"[\s\S]*?<\/aside>/, "");
  html = html.replace(/<title>.*?<\/title>/, `<title>${title}</title>`).replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(k.lead)}">`);
  html = html.replace(`href="${origin}${nl ? "/" : "/en/"}"`, `href="${origin}${route}"`);
  html = html.replace('href="/" lang="nl-BE"', `href="/${kind}" lang="nl-BE"`).replace('href="/en/" lang="en"', `href="/en/${kind}" lang="en"`);
  html = html.replace(/hreflang="nl-BE" href="[^"]*"/, `hreflang="nl-BE" href="${origin}/${kind}"`).replace(/hreflang="en" href="[^"]*"/, `hreflang="en" href="${origin}/en/${kind}"`).replace(/hreflang="x-default" href="[^"]*"/, `hreflang="x-default" href="${origin}/${kind}"`);
  html = html.replace(/property="og:url" content="[^"]*"/, `property="og:url" content="${origin}${route}"`);
  html = html.replace(/property="og:title" content="[^"]*"/, `property="og:title" content="${esc(title)}"`);
  // the page's own nav link is the current page
  html = html.replace(new RegExp(`<a (href="[^"]*" data-account="${kind}")`), '<a aria-current="page" $1');
  return html;
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "en"), { recursive: true });
for (const asset of ["logo.svg", "favicon.svg", "theme.js"]) cpSync(join(shared, "public", asset), join(dist, asset));
cpSync(join(root, "src/account.js"), join(dist, "account.js"));
writeFileSync(join(dist, "styles.css"), readFileSync(join(shared, "src/theme.css"), "utf8") + "\n" + readFileSync(join(root, "src/styles.css"), "utf8"));
writeFileSync(join(dist, "index.html"), page("nl"));
writeFileSync(join(dist, "en/index.html"), page("en"));
writeFileSync(join(dist, "404.html"), page("nl", true));
for (const lang of ["nl", "en"]) for (const kind of ["login", "register"]) {
  const folder = join(dist, lang === "nl" ? "" : "en", kind);
  mkdirSync(folder, {recursive:true});
  writeFileSync(join(folder, "index.html"), entryPage(lang,kind));
}

writeFileSync(join(dist, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
writeFileSync(join(dist, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url><url><loc>${origin}/en/</loc></url></urlset>\n`);
console.log(`Built ${dist}`);
