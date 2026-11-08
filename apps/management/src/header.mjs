/**
 * The header every management page shares, the same markup as breinhap.com (apps/web): the logo and name on the
 * left, the language selector and the OS light/dark toggle on the right, in a centred container on the charcoal
 * ASafariM bar. `tools` is already-safe markup.
 */
const THEME_LABEL = { nl: "Donker thema", fr: "Thème sombre", en: "Dark theme", de: "Dunkles Design" };

/** The OS's sun-that-sets-into-a-moon toggle (asafarim-os packages/theme/toggle.html), styled by theme.css. */
export const themeToggle = (lang = "nl") => {
	const label = THEME_LABEL[lang] ?? THEME_LABEL.nl;
	return `<button type="button" class="os-theme-toggle" data-theme-toggle aria-label="${label}" aria-pressed="false" title="${label}"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><mask id="os-theme-moon"><rect width="24" height="24" fill="#fff"/><circle class="os-theme-bite" cx="17.5" cy="6.5" r="6" fill="#000"/></mask><circle class="os-theme-core" cx="12" cy="12" r="5" fill="currentColor" mask="url(#os-theme-moon)"/><path class="os-theme-rays" d="M12 1.5v2.5M12 20v2.5M1.5 12h2.5M20 12h2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg></button>`;
};

/** breinhap.com's home page in a language (where the logo links to). */
export const websiteHome = (lang = "nl") => `https://breinhap.com/${lang === "nl" ? "" : `${lang}/`}`;

export function header({ lang = "nl", name = "Breinhap", href = websiteHome(lang), tools = "", navigation = "" }) {
	return `<header class="os-topbar"><div class="topbar-inner"><a class="brand" href="${href}"><img src="/logo.svg" width="40" height="40" alt=""><span>${name}</span></a>${navigation}<div class="tools">${tools}${themeToggle(lang)}</div></div></header>`;
}

/** Dezelfde publieke en juridische links als op breinhap.com. */
export function managementFooter(version) {
	return `<footer class="management-footer"><div class="footer-inner"><p><strong>Breinhap</strong> · Kleine stappen. Op jouw tempo. · Breinhap beheer · ${version}</p><nav aria-label="Juridisch"><a href="https://breinhap.com/">Breinhap web</a><a href="https://breinhap.asafarim.site/">Over Breinhap</a><a href="https://breinhap.asafarim.site/privacy/">Privacy</a><a href="https://breinhap.asafarim.site/voorwaarden/">Voorwaarden</a><a href="https://breinhap.asafarim.site/cookies/">Cookies</a><a href="https://breinhap.asafarim.site/account-verwijderen/">Je gegevens verwijderen</a></nav></div></footer>`;
}
