// breinhap#signup: the ASafariM country & language selector (@asafarim/country-language-selector, the
// same component as asafarim.com) on Breinhap's sign-in and registration pages. Bundled into
// src/vendor/locale-selector.js by scripts/build-locale-selector.mjs; the server pages stay plain HTML
// and keep their language links as the no-JavaScript fallback.
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
	createRoot(mount).render(
		createElement(CountryLanguageSelector, {
			countries: COUNTRIES,
			value: { country: "BE", language },
			triggerVariant: "compact",
			align: "end",
			ariaLabel: "Taal · Langue · Sprache · Language",
			onChange: (next, meta) => {
				if (meta?.reason === "init" || next.language === language) return;
				const url = new URL(window.location.href);
				url.searchParams.set("lang", next.language);
				window.location.assign(url.toString());
			},
		}),
	);
}
