// Page templates. Plain functions returning HTML strings; build.mjs writes them to dist/.
// No inline scripts or styles anywhere: the CSP is script-src 'self'; style-src 'self'.
import { CONTACT_EMAIL } from "./content.mjs";
import { esc } from "./html.mjs";
import { logoMark, phone } from "./phone.mjs";

export const SITE_URL = "https://breinhap.asafarim.site";

/** Every page, per language, so the language switch links to the same page in the other language. */
export const routes = {
  home: { nl: "/", en: "/en/" },
  privacy: { nl: "/privacy/", en: "/en/privacy/" },
  deletion: { nl: "/account-verwijderen/", en: "/en/delete-account/" },
  cookies: { nl: "/cookies/", en: "/en/cookies/" },
  terms: { nl: "/voorwaarden/", en: "/en/terms/" },
};

const ICONS = {
  start: '<path d="M8 5.5v13l10-6.5z"/>',
  steps: '<path d="M4 18h4v-4h4v-4h4V6h4"/>',
  clock: '<rect x="3" y="9" width="18" height="6" rx="3"/><path d="M7 12h6"/>',
  calm: '<path d="M4 15c3-3 5-3 8 0s5 3 8 0"/><path d="M4 10c3-3 5-3 8 0s5 3 8 0"/>',
  speak: '<path d="M5 10v4h3l5 4V6L8 10z"/><path d="M16.5 9a4 4 0 0 1 0 6"/><path d="M19 6.5a7.5 7.5 0 0 1 0 11"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
};
const icon = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] ?? ""}</svg>`;

function logo(t, home, id = "bh-bite-top") {
  return `<a class="brand" href="${home}" aria-label="Breinhap, ${esc(t.footer.tagline)}">
    <svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">${logoMark(id)}</svg>
    <span class="brand-name">Breinhap</span>
  </a>`;
}

function themeToggle(t) {
  return `<button type="button" class="os-theme-toggle" data-theme-toggle aria-label="${esc(t.themeLabel)}" aria-pressed="false" title="${esc(t.themeLabel)}">
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <mask id="os-theme-moon"><rect width="24" height="24" fill="#fff"/><circle class="os-theme-bite" cx="17.5" cy="6.5" r="6" fill="#000"/></mask>
    <circle class="os-theme-core" cx="12" cy="12" r="5" fill="currentColor" mask="url(#os-theme-moon)"/>
    <path class="os-theme-rays" d="M12 1.5v2.5M12 20v2.5M1.5 12h2.5M20 12h2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>
  </svg>
</button>`;
}

/** Open Graph locale for each page language. */
const OG_LOCALE = { nl: "nl_BE", en: "en_US" };

/**
 * Structured data (schema.org JSON-LD) for the home page: who publishes Breinhap, the site, and the app.
 * A JSON data block, not a script: the CSP's script-src does not apply to it and browsers never run it.
 */
function structuredData(t, lang) {
  const url = `${SITE_URL}${routes.home[lang]}`;
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", "@id": "https://asafarim.site/#org", name: "ASafariM", url: "https://asafarim.site/", email: CONTACT_EMAIL },
      {
        "@type": "WebSite",
        "@id": `${url}#website`,
        url,
        name: "Breinhap",
        description: t.meta.description,
        inLanguage: t.lang,
        publisher: { "@id": "https://asafarim.site/#org" },
      },
      {
        "@type": "MobileApplication",
        "@id": `${SITE_URL}/#app`,
        name: "Breinhap",
        description: t.meta.description,
        url,
        image: `${SITE_URL}/og.png`,
        operatingSystem: "Android",
        applicationCategory: "EducationalApplication",
        inLanguage: "nl-BE",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
        audience: { "@type": "EducationalAudience", educationalRole: "student" },
        publisher: { "@id": "https://asafarim.site/#org" },
      },
    ],
  };
  // "<" escaped so no text in the data can close the element.
  return `<script type="application/ld+json">${JSON.stringify(graph).replaceAll("<", "\\u003c")}</script>\n`;
}

function layout({ t, lang, page, title, description, body, nav = true, noindex = false, jsonLd = "" }) {
  const other = lang === "nl" ? "en" : "nl";
  const home = routes.home[lang];
  const path = routes[page]?.[lang] ?? home;
  const otherPath = routes[page]?.[other] ?? routes.home[other];
  const anchors = nav
    ? `<nav class="nav" aria-label="Breinhap">
        <a href="${home}#hoe">${esc(t.nav.how)}</a>
        <a href="${home}#waarom">${esc(t.nav.why)}</a>
        <a href="${home}#inhoud">${esc(t.nav.content)}</a>
        <a href="${home}#veilig">${esc(t.nav.safe)}</a>
        <a href="${home}#vragen">${esc(t.nav.faq)}</a>
      </nav>`
    : "";
  return `<!doctype html>
<html lang="${t.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE_URL}${path}">
<link rel="alternate" hreflang="nl-BE" href="${SITE_URL}${routes[page]?.nl ?? "/"}">
<link rel="alternate" hreflang="en" href="${SITE_URL}${routes[page]?.en ?? "/en/"}">
<link rel="alternate" hreflang="x-default" href="${SITE_URL}${routes[page]?.nl ?? "/"}">
${noindex ? '<meta name="robots" content="noindex">\n' : ""}<meta property="og:type" content="website">
<meta property="og:site_name" content="Breinhap">
<meta property="og:url" content="${SITE_URL}${path}">
<meta property="og:locale" content="${OG_LOCALE[lang]}">
<meta property="og:locale:alternate" content="${OG_LOCALE[other]}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE_URL}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(t.meta.title)}">
<meta name="twitter:card" content="summary_large_image">
${jsonLd}<meta name="theme-color" content="#222222">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
<script src="/theme.js"></script>
<script src="/app.js" defer></script>
</head>
<body>
<a class="skip" href="#main">${esc(t.skip)}</a>
<header class="os-topbar topbar">
  <div class="wrap topbar-inner">
    ${logo(t, home)}
    ${anchors}
    <div class="topbar-tools">
      <a class="lang" href="${otherPath}" hreflang="${other === "nl" ? "nl-BE" : "en"}" lang="${other === "nl" ? "nl-BE" : "en"}">${esc(t.otherLangLabel)}</a>
      ${themeToggle(t)}
    </div>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="footer">
  <div class="wrap footer-inner">
    <div>
      ${logo(t, home, "bh-bite-foot")}
      <p class="muted">${esc(t.footer.tagline)}</p>
    </div>
    <nav class="footer-links" aria-label="Footer">
      <a href="${routes.privacy[lang]}">${esc(t.footer.privacy)}</a>
      <a href="${routes.cookies[lang]}">${esc(t.footer.cookies)}</a>
      <a href="${routes.terms[lang]}">${esc(t.footer.terms)}</a>
      <a href="${routes.deletion[lang]}">${esc(t.footer.delete)}</a>
      <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>
      <a href="https://asafarim.site/">${esc(t.footer.os)}</a>
    </nav>
    <p class="muted small">© 2026 ${esc(t.footer.rights)}</p>
  </div>
</footer>
</body>
</html>
`;
}

function home(t, lang) {
  const f = t.flow;
  const chips = t.hero.chips.map((c, i) => `<span class="chip chip--${i + 1}">${esc(c)}</span>`).join("");
  const steps = f.steps
    .map(
      (s, i) => `<li>
        <button type="button" class="flow-step${i === 0 ? " is-active" : ""}" data-step="${i}" aria-pressed="${i === 0}">
          <span class="flow-num" aria-hidden="true">${i + 1}</span>
          <span><span class="flow-title">${esc(s.title)}</span><span class="flow-text">${esc(s.text)}</span></span>
        </button>
      </li>`,
    )
    .join("");
  const features = t.why.items
    .map((it) => `<li class="feature">${icon(it.icon)}<h3>${esc(it.title)}</h3><p>${esc(it.text)}</p></li>`)
    .join("");
  const pipeline = t.content.steps
    .map((s, i) => `<li class="pipe-step pipe-step--${i + 1}"><span class="pipe-dot" aria-hidden="true">${i + 1}</span><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></li>`)
    .join("");
  const subjects = (list, cls) => list.map((s) => `<li class="subject ${cls}">${esc(s)}</li>`).join("");
  const safe = t.safe.items.map((s) => `<li>${icon("shield")}<span>${esc(s)}</span></li>`).join("");
  const faq = t.faq.items
    .map((it) => `<details class="faq-item"><summary>${esc(it.q)}</summary><p>${esc(it.a)}</p></details>`)
    .join("");

  const body = `
<section class="hero">
  <div class="wrap hero-inner">
    <div class="hero-copy">
      <p class="kicker">${esc(t.hero.kicker)}</p>
      <h1>${esc(t.hero.title)}</h1>
      <p class="lead">${esc(t.hero.lead)}</p>
      <p class="muted">${esc(t.hero.note)}</p>
      <div class="hero-actions">
        <a class="btn" href="#hoe">${esc(t.hero.cta)}</a>
        <span class="btn btn--ghost btn--static" aria-disabled="true">${esc(t.playSoon)}</span>
      </div>
    </div>
    <div class="hero-art" aria-hidden="true">
      <div class="hero-orb">
        <svg class="hero-mark" viewBox="0 0 64 64" focusable="false">${logoMark("bh-bite-hero")}</svg>
      </div>
      ${chips}
    </div>
  </div>
</section>

<section id="hoe" class="section">
  <div class="wrap">
    <h2>${esc(f.title)}</h2>
    <p class="lead">${esc(f.lead)}</p>
    <div class="flow" data-flow>
      <div class="flow-phone">${phone(t)}<p class="flow-caption" data-flow-caption aria-hidden="true"><strong>1. </strong> ${esc(f.steps[0].title)}</p></div>
      <div class="flow-side">
        <ol class="flow-steps">${steps}</ol>
        <button type="button" class="btn btn--ghost flow-toggle" data-flow-toggle data-play="${esc(f.play)}" data-pause="${esc(f.pause)}" hidden>${esc(f.pause)}</button>
      </div>
    </div>
  </div>
</section>

<section id="waarom" class="section section--alt">
  <div class="wrap">
    <h2>${esc(t.why.title)}</h2>
    <p class="lead">${esc(t.why.lead)}</p>
    <ul class="features">${features}</ul>
  </div>
</section>

<section id="inhoud" class="section">
  <div class="wrap">
    <h2>${esc(t.content.title)}</h2>
    <p class="lead">${esc(t.content.lead)}</p>
    <ol class="pipeline">${pipeline}</ol>
    <h3 class="subjects-title">${esc(t.content.subjectsTitle)}</h3>
    <ul class="subjects" aria-label="${esc(t.content.subjectsTitle)}">
      ${subjects(t.content.first, "subject--first")}${subjects(t.content.later, "subject--later")}
    </ul>
    <p class="muted small subjects-legend"><span class="dot dot--first"></span> ${esc(t.content.subjectsFirst)} <span class="dot dot--later"></span> ${esc(t.content.subjectsLater)}</p>
  </div>
</section>

<section id="veilig" class="section section--alt">
  <div class="wrap two-col">
    <div>
      <h2>${esc(t.safe.title)}</h2>
      <ul class="safe">${safe}</ul>
      <p class="links"><a href="${routes.privacy[lang]}">${esc(t.safe.privacyLink)}</a> · <a href="${routes.deletion[lang]}">${esc(t.safe.deleteLink)}</a></p>
    </div>
    <div class="card">
      <h2>${esc(t.parents.title)}</h2>
      <p>${esc(t.parents.text)}</p>
    </div>
  </div>
</section>

<section id="vragen" class="section">
  <div class="wrap narrow">
    <h2>${esc(t.faq.title)}</h2>
    ${faq}
  </div>
</section>`;
  return layout({ t, lang, page: "home", title: t.meta.title, description: t.meta.description, body, jsonLd: structuredData(t, lang) });
}

/** Fills the {{deleteHref}}, {{privacyHref}} and {{cookiesHref}} placeholders with the page's language's paths. */
function links(text, lang) {
  return text
    .replaceAll("{{deleteHref}}", routes.deletion[lang])
    .replaceAll("{{privacyHref}}", routes.privacy[lang])
    .replaceAll("{{cookiesHref}}", routes.cookies[lang]);
}

function block(item, lang) {
  if (typeof item === "string") return `<p>${links(item, lang)}</p>`;
  if (item.list) return `<ul>${item.list.map((li) => `<li>${li}</li>`).join("")}</ul>`;
  if (item.ordered) return `<ol>${item.ordered.map((li) => `<li>${li}</li>`).join("")}</ol>`;
  return "";
}

function legal(t, lang, page, doc) {
  const sections = doc.sections
    .map(([heading, items]) => `<h2>${esc(heading)}</h2>${items.map((it) => block(it, lang)).join("")}`)
    .join("");
  const body = `<section class="section"><div class="wrap narrow prose">
    <h1>${esc(doc.title)}</h1>
    ${doc.draft ? `<p class="notice">${esc(doc.draft)}</p>` : ""}
    ${doc.lead ? `<p class="lead">${esc(doc.lead)}</p>` : ""}
    ${sections}
    ${doc.updated ? `<p class="muted small">${esc(doc.updated)}</p>` : ""}
    <p><a class="btn btn--ghost" href="${routes.home[lang]}">← Breinhap</a></p>
  </div></section>`;
  return layout({ t, lang, page, title: `${doc.title} · Breinhap`, description: doc.lead ?? doc.title, body, nav: false });
}

function notFound(t) {
  const body = `<section class="section"><div class="wrap narrow prose">
    <h1>${esc(t.notFound.title)}</h1>
    <p>${esc(t.notFound.text)}</p>
    <p><a class="btn" href="/">${esc(t.notFound.home)}</a> <a class="btn btn--ghost" href="/en/">English</a></p>
  </div></section>`;
  return layout({ t, lang: "nl", page: "home", title: `${t.notFound.title} · Breinhap`, description: t.notFound.text, body, nav: false, noindex: true });
}

export { home, legal, notFound };
