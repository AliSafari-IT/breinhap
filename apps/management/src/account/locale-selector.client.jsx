// The ASafariM country & language selector (@asafarim/country-language-selector, the same component as
// asafarim.com) on breinhap.com and on Breinhap's management pages. Bundled into
// apps/site/public/locale-selector.js by scripts/build-locale-selector.mjs, which both hosts serve; the pages stay
// plain HTML and keep their language links as the no-JavaScript fallback.
//
// Choosing a language remembers it in the breinhap-lang cookie on the parent domain (so breinhap.com and
// management.breinhap.com share it), then goes to that language's link from the mount's fallback markup,
// so where each language lives (a path prefix on the website, ?lang= on management) is up to the page.
import { CountryLanguageSelector } from "@asafarim/country-language-selector";
import { createElement } from "react";
import { createRoot } from "react-dom/client";

// Belgium's three languages plus English, as on asafarim.com.
const COUNTRIES = [
	{
		code: "BE",
		name: "Belgium",
		nativeName: "België · Belgique · Belgien",
		flag: "🇧🇪",
		languages: [
			{ code: "nl", label: "Dutch", nativeLabel: "Nederlands" },
			{ code: "fr", label: "French", nativeLabel: "Français" },
			{ code: "de", label: "German", nativeLabel: "Deutsch" },
			{ code: "en", label: "English", nativeLabel: "English" },
		],
	},
];

const mount = document.querySelector("[data-locale-selector]");
if (mount) {
	const language = mount.getAttribute("data-lang") || "nl";
	const links = new Map();
	for (const a of mount.querySelectorAll("a[hreflang]")) links.set(a.getAttribute("lang") || a.hreflang, a.href);
	createRoot(mount).render(
		createElement(CountryLanguageSelector, {
			countries: COUNTRIES,
			value: { country: "BE", language },
			triggerVariant: "compact",
			align: "end",
			ariaLabel: "Taal · Langue · Sprache · Language",
			onChange: (next, meta) => {
				if (meta?.reason === "init" || next.language === language) return;
				const host = window.location.hostname;
				const shared = host === "breinhap.com" || host.endsWith(".breinhap.com") ? "; Secure; Domain=breinhap.com" : "";
				document.cookie = `breinhap-lang=${next.language}; Path=/; Max-Age=31536000; SameSite=Lax${shared}`;
				const target = links.get(next.language);
				if (target) return window.location.assign(target);
				const url = new URL(window.location.href);
				url.searchParams.set("lang", next.language);
				window.location.assign(url.toString());
			},
		}),
	);
}
