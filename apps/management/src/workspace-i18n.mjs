import { AsyncLocalStorage } from "node:async_hooks";
import { MESSAGES } from "./workspace-messages.mjs";

const locale = new AsyncLocalStorage();
const LOCALES = { nl: "nl-BE", fr: "fr-BE", en: "en-GB", de: "de-BE" };
export const uiLocale = () => locale.getStore() ?? "nl";
export const formatLocale = () => LOCALES[uiLocale()];
export const withLocale = (lang, work) => locale.run(Object.hasOwn(LOCALES, lang) ? lang : "nl", work);
const marker = /\uE000(\d+)\uE001/g;
const escape = (text) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const normalized = (text) => text.trim().replace(/\s+/g, " ");

/** Translate only trusted message literals. Interpolated names/content are never inspected. */
export function tr(message, ...values) {
	if (Array.isArray(message)) message = message.reduce((out, part, i) => out + (i ? `{${i - 1}}` : "") + part, "");
	const translated = MESSAGES[normalized(message)]?.[uiLocale()] ?? message;
	return translated.replace(/\{(\d+)\}/g, (token, index) => index < values.length ? String(values[index]) : token);
}

const templates = new WeakMap();
/**
 * Localize static text and accessible attributes of a trusted HTML template BEFORE interpolation.
 * Unlike translating rendered HTML, this cannot touch a name, lesson, URL, token or schema key.
 * Values retain the escaping performed by their caller; translated literals are HTML escaped.
 */
export function ui(strings, ...values) {
	let compiled = templates.get(strings);
	if (!compiled) {
		compiled = new Map();
		templates.set(strings, compiled);
	}
	const lang = uiLocale();
	let html = compiled.get(lang);
	if (html === undefined) {
		html = strings.reduce((out, part, i) => out + (i ? `\uE000${i - 1}\uE001` : "") + part, "");
		if (lang !== "nl") html = html.replace(/<[^>]*>|[^<]+/g, (part) => {
			const translate = (text) => {
				const indices = [];
				const key = normalized(text).replace(marker, (_, index) => `{${indices.push(index) - 1}}`);
				const message = MESSAGES[key]?.[lang];
				if (message === undefined) return text;
				const translated = escape(message).replace(/\{(\d+)\}/g, (_, index) => `\uE000${indices[index]}\uE001`);
				return text.slice(0, text.length - text.trimStart().length) + translated + text.slice(text.trimEnd().length);
			};
			return part.startsWith("<")
				? part.replace(/((?:aria-label|title|placeholder)=")([^"]*)(")/g, (_, before, text, after) => before + translate(text) + after)
				: translate(part);
		});
		html = html.replace(/<form\b[^>]*method="get"[^>]*>/g, (tag) => `${tag}<input type="hidden" name="lang" value="${lang}">`);
		compiled.set(lang, html);
	}
	return html.replace(marker, (_, index) => String(values[index]));
}

const DIAGNOSTICS = [
	"Schemaversie {0} wordt niet ondersteund (alleen {1}).",
	'{0}: het bestand zegt "nagekeken"; dat wordt genegeerd. Het leerobject wordt een concept.',
	"Rij {0}: een cel begint met =, + of @. Ze wordt als gewone tekst bewaard, nooit als formule.",
	"Verschilt van rij {0} voor hetzelfde leerobject.",
	"De code {0} staat twee keer in het bestand.",
	"De missiecode {0} staat ook bij {1} in het bestand.",
	"Het bestand is te groot (maximaal {0} MB).",
	"Vul er minstens {0} in.", "Minstens {0}.", "Hoogstens {0}.",
	"Je had {0} van de {1} vragen juist.",
	"Je hebt {0} vragen geoefend. Lees de uitleg nog eens rustig na.",
];

/** Stored import diagnostics stay canonical; translate their known templates only when displayed. */
export function diagnostic(message) {
	if (Object.hasOwn(MESSAGES, message)) return tr(message);
	for (const key of DIAGNOSTICS) {
		const pattern = key.split(/\{\d+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.+?)");
		const match = new RegExp(`^${pattern}$`).exec(message);
		if (match) return tr(key, ...match.slice(1));
	}
	return message;
}
