/**
 * Read-aloud voices a signed-in person can choose, per reading language (breinhap#124). The recorded voices are
 * the narrators recorded for breinhap.com (apps/web/narration, made offline with ElevenLabs);
 * test/voices.test.mjs fails while this list and that manifest disagree. "device" is the browser's own voice,
 * always available. A language without recorded voices reads with the browser's voice.
 */
export const READING_LANGUAGES = ["nl", "fr", "en", "de"];
export const DEVICE_VOICE = "device";
export const VOICES = {
	nl: [
		["emma", "Emma"],
		["sare", "Sare"],
		["evie", "Evie"],
		["hans", "Hans Claesen"],
		["steven", "Steven"],
	],
};

/** Only known languages and voices survive; anything else (or the browser voice by default) is left out. */
export function cleanVoices(input) {
	const out = {};
	for (const lang of READING_LANGUAGES) {
		const value = input?.[lang];
		if (typeof value !== "string") continue;
		if (value === DEVICE_VOICE || (VOICES[lang] ?? []).some(([id]) => id === value)) out[lang] = value;
	}
	return out;
}
