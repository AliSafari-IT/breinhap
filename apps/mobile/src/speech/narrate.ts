import { findClip, type Narrator } from "@breinhap/content";
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import * as Speech from "expo-speech";
import { clipAssets, manifest } from "./recorded";
import { speechOptions, type DeviceVoice, type Tempo } from "./voices";

/**
 * Read-aloud with a recorded Breinhap voice when this build has a clip for the exact text (made
 * offline with ElevenLabs, bundled in the app; see packages/content/scripts/narrate.ts), and with
 * the device voice otherwise. Either way nothing is sent anywhere: the clips are files in the app.
 */

/** The recorded voices bundled in this build (none in a build without clips). */
export const recordedNarrators = Object.keys(manifest?.narrators ?? {}) as Narrator[];

/** Recorded clips play a touch slower for "rustig"; they are already at a calm reading pace. */
const CLIP_RATE: Record<Tempo, number> = { rustig: 0.92, normaal: 1 };

export interface ReadChoice {
  narrator: Narrator | null;
  voiceId: string | null;
  tempo: Tempo;
}

export function recordedClip(narrator: Narrator, text: string): number | undefined {
  const file = findClip(manifest, narrator, text);
  return file ? clipAssets[`${narrator}/${file}`] : undefined;
}

let player: AudioPlayer | null = null;
let playing = false;

export function stopReading(): void {
  void Speech.stop();
  if (player && playing) player.pause();
  playing = false;
}

export async function isReading(): Promise<boolean> {
  return playing || (await Speech.isSpeakingAsync());
}

/** Read `text` aloud, stopping whatever was reading. A missing clip falls back to the device voice. */
export function read(text: string, choice: ReadChoice, voices: readonly DeviceVoice[]): void {
  stopReading();
  const clip = choice.narrator ? recordedClip(choice.narrator, text) : undefined;
  if (clip === undefined) {
    Speech.speak(text, speechOptions(voices, choice));
    return;
  }
  if (!player) {
    player = createAudioPlayer(clip);
    player.addListener("playbackStatusUpdate", (status) => {
      if (status.didJustFinish) playing = false;
    });
  } else {
    player.replace(clip);
  }
  player.setPlaybackRate(CLIP_RATE[choice.tempo], "high");
  void player.seekTo(0);
  player.play();
  playing = true;
}

/** Press to read, press again to stop. */
export async function toggleReading(text: string, choice: ReadChoice, voices: readonly DeviceVoice[]): Promise<void> {
  if (await isReading()) stopReading();
  else read(text, choice, voices);
}
