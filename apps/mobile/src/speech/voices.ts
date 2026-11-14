/**
 * Choosing a read-aloud voice from the text-to-speech voices installed on the device.
 *
 * Only Dutch voices that run on the device are offered: a "network" voice sends the text to the
 * speech provider's servers, so it is left out (read-aloud stays offline and private). Android does
 * not say whether a voice is male or female; for the voice names of Google's and Samsung's speech
 * engines we know it, otherwise the voice is just "Stem 2". The preview lets the student hear it.
 */

export interface DeviceVoice {
  identifier: string;
  name: string;
  quality: string; // "Default" | "Enhanced"
  language: string;
}

export type Gender = "vrouw" | "man";
export type Tempo = "rustig" | "normaal";

/** Speech rate per tempo (1 is the engine's normal speed). A little slower sounds less hurried. */
export const RATE: Record<Tempo, number> = { rustig: 0.85, normaal: 1 };

const lang = (v: DeviceVoice) => v.language.toLowerCase().replace("_", "-");
const isDutch = (v: DeviceVoice) => /^nl(-|$)/.test(lang(v));
const isNetwork = (v: DeviceVoice) => /network/i.test(`${v.identifier} ${v.name}`);
const isFlemish = (v: DeviceVoice) => lang(v).startsWith("nl-be");

/**
 * Genders of known engine voice codes. Google: nl-be-x-bec / -bed, nl-nl-x-…; Samsung: SMTf / SMTm.
 * A hint only: the label says "vrouw" or "man", and the preview is the truth.
 */
const GOOGLE: Record<string, Gender> = {
  bec: "vrouw",
  bed: "man",
  tfb: "vrouw",
  lfc: "vrouw",
  yfr: "vrouw",
  bmh: "man",
  dma: "man",
};

export function voiceGender(v: DeviceVoice): Gender | undefined {
  const id = `${v.identifier} ${v.name}`.toLowerCase();
  const google = /nl-(?:be|nl)-x-([a-z]{3})-/.exec(id);
  if (google) return GOOGLE[google[1] as string];
  const samsung = /smt([fm])\d/.exec(id);
  if (samsung) return samsung[1] === "f" ? "vrouw" : "man";
  if (/female|vrouw/.test(id)) return "vrouw";
  if (/\bmale\b|\bman\b/.test(id)) return "man";
  return undefined;
}

/** The Dutch on-device voices, best first: Flemish, then enhanced quality, then by name. */
export function dutchVoices(voices: readonly DeviceVoice[]): DeviceVoice[] {
  const seen = new Set<string>();
  return voices
    .filter((v) => isDutch(v) && !isNetwork(v) && !seen.has(v.identifier) && seen.add(v.identifier))
    .sort(
      (a, b) =>
        Number(isFlemish(b)) - Number(isFlemish(a)) ||
        Number(b.quality === "Enhanced") - Number(a.quality === "Enhanced") ||
        (a.identifier.toLowerCase() < b.identifier.toLowerCase() ? -1 : a.identifier.toLowerCase() > b.identifier.toLowerCase() ? 1 : 0),
    );
}

/** "Vrouw · Vlaams", "Man 2 · Nederlands", "Stem 3 · Vlaams · beter". Numbers count per gender. */
export function voiceLabels(voices: readonly DeviceVoice[]): Map<string, string> {
  const counts = new Map<string, number>();
  const totals = new Map<string, number>();
  const kind = (v: DeviceVoice) => voiceGender(v) ?? "stem";
  for (const v of voices) totals.set(kind(v), (totals.get(kind(v)) ?? 0) + 1);
  const labels = new Map<string, string>();
  for (const v of voices) {
    const k = kind(v);
    const n = (counts.get(k) ?? 0) + 1;
    counts.set(k, n);
    const base = k === "vrouw" ? "Vrouw" : k === "man" ? "Man" : "Stem";
    const numbered = k === "stem" || (totals.get(k) ?? 0) > 1 ? `${base} ${n}` : base;
    labels.set(
      v.identifier,
      [numbered, isFlemish(v) ? "Vlaams" : "Nederlands", v.quality === "Enhanced" ? "beter" : ""].filter(Boolean).join(" · "),
    );
  }
  return labels;
}

/**
 * What to pass to the speech engine. A chosen voice that is no longer installed falls back to the
 * best available Dutch voice; without any, the engine's own nl-BE default is used.
 */
export function speechOptions(
  available: readonly DeviceVoice[],
  choice: { voiceId: string | null; tempo: Tempo },
): { language: string; voice?: string; rate: number } {
  const voices = dutchVoices(available);
  const voice = voices.find((v) => v.identifier === choice.voiceId) ?? voices[0];
  return voice ? { language: voice.language, voice: voice.identifier, rate: RATE[choice.tempo] } : { language: "nl-BE", rate: RATE[choice.tempo] };
}
