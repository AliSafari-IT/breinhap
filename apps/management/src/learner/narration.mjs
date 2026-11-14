import { readFile } from "node:fs/promises";
import { NARRATORS, findClip, narrationKey } from "../vendor/content-narration.mjs";
import { esc } from "./pages.mjs";
import { t } from "./messages.mjs";

/**
 * Recorded narration on breinhap.com (prototype). Clips are made offline with ElevenLabs by
 * packages/content/scripts/narrate.ts --install and land in apps/management/narration/. The server
 * only serves those files: no text is ever sent to a speech service, and a page whose text has no
 * clip (or a server without the folder, which is every deployed image today: the Dockerfile does not
 * copy it) gets the browser's own speech, or no button without JavaScript.
 */

const DIR = new URL("../../narration/", import.meta.url);
const CLIP_PATH = /^\/p\/audio\/([a-z]+)\/([0-9a-f]{16})\.mp3$/;

/** The installed manifest, or null when there is none. Read once at startup. */
export async function loadNarration(dir = DIR) {
	try {
		const manifest = JSON.parse(await readFile(new URL("manifest.json", dir), "utf8"));
		return { manifest, dir };
	} catch {
		return null;
	}
}

/**
 * The data attributes for a read-aloud block: the text (for the browser's own voice) and, per
 * recorded narrator, the clip URL when there is one for this exact text.
 */
export function narrationAttrs(lang, narration, text) {
	const clips = NARRATORS.map((n) => [n, findClip(narration?.manifest, n, text)])
		.filter(([, file]) => file)
		.map(([n, file]) => ` data-clip-${n}="/p/audio/${n}/${esc(file)}"`)
		.join("");
	const labels = [
		["read", t(lang, "readAloud")],
		["stop", t(lang, "stopReading")],
		["voice", t(lang, "voice")],
		["device", t(lang, "voiceDevice")],
		...NARRATORS.map((n) => [n, t(lang, `voice_${n}`)]),
	]
		.map(([k, v]) => ` data-label-${k}="${esc(v)}"`)
		.join("");
	return ` data-narration="${esc(text)}"${clips}${labels}`;
}

/** GET /p/audio/{narrator}/{key}.mp3: an installed clip, or null. Only manifest entries are served. */
export async function narrationClip(narration, path) {
	const match = CLIP_PATH.exec(path);
	if (!match || !narration) return null;
	const [, narrator, key] = match;
	const file = narration.manifest?.narrators?.[narrator]?.clips?.[key];
	if (!NARRATORS.includes(narrator) || file !== `${key}.mp3`) return null;
	try {
		return await readFile(new URL(`${narrator}/${file}`, narration.dir));
	} catch {
		return null;
	}
}

export { narrationKey };
