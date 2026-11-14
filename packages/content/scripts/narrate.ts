/**
 * Recorded narration prototype: generate read-aloud MP3s for learn cards with ElevenLabs, offline.
 *
 * Nothing in the app or on breinhap.com calls ElevenLabs. This script runs on a developer machine
 * before a release, reads the card texts from the content in this repo, and writes clips named by
 * the hash of the text they speak (see src/narration.ts) plus a manifest and a listening page.
 * Clips whose text and voice are unchanged are reused, so a rerun only pays for what changed.
 *
 *   ELEVENLABS_API_KEY=… pnpm --filter @breinhap/content narrate -- --voice vrouw=<voiceId> --voice man=<voiceId>
 *   pnpm --filter @breinhap/content narrate -- --dry-run          # texts, characters and size, no API call
 *   ELEVENLABS_API_KEY=… pnpm --filter @breinhap/content narrate -- --list-voices
 *
 * --install copies the clips into the Android app (apps/mobile/assets/narration + src/speech/recorded.ts)
 * and the web player (apps/management/narration). Only for a local or preview build until Ali has
 * listened to the samples: the clips then ship with the app and breinhap.com.
 *
 * Options: --missions id,id (default: three reviewed sample missions; "all" for every reviewed one),
 * --model (default eleven_multilingual_v2), --format (default mp3_44100_64), --out (default narration/out).
 *
 * The API key is read from ELEVENLABS_API_KEY only. It is never printed, written to disk or put in
 * a URL, and error output shows the HTTP status and ElevenLabs' message, never the request headers.
 */
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { NARRATION_KEY_VERSION, NARRATION_PREVIEW, NARRATORS, narrationKey, narrationText, normaliseNarration, samplePack, type NarrationManifest, type Narrator } from "../src/index";

const API = process.env.ELEVENLABS_API_URL ?? "https://api.elevenlabs.io"; // overridable for a local fake in tests
const DEFAULT_MISSIONS = ["bio-prikkel-reactie-volgorde", "economie-inflatie-koopkracht-1", "geschiedenis-franse-revolutie-1"];

const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift(); // pnpm passes the separator through
const { values } = parseArgs({
  args: argv,
  options: {
    missions: { type: "string" },
    voice: { type: "string", multiple: true },
    model: { type: "string", default: "eleven_multilingual_v2" },
    format: { type: "string", default: "mp3_44100_64" },
    out: { type: "string", default: resolve(import.meta.dirname, "../narration/out") },
    "dry-run": { type: "boolean", default: false },
    "list-voices": { type: "boolean", default: false },
    install: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

function apiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new Error("Set ELEVENLABS_API_KEY in the environment (never in a file in this repo).");
  return key;
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...init.headers, "xi-api-key": apiKey() } });
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify((await res.json()).detail ?? "").slice(0, 300);
    } catch {}
    throw new Error(`ElevenLabs ${init.method ?? "GET"} ${path.split("?")[0]} answered ${res.status} ${detail}`);
  }
  return res;
}

/** Dutch voices: the account's own, then the shared library's Flemish/Belgian ones. */
async function listVoices() {
  type V = { voice_id: string; name: string; labels?: Record<string, string>; accent?: string; gender?: string; language?: string; description?: string; public_owner_id?: string };
  const own = ((await (await api("/v1/voices")).json()).voices ?? []) as V[];
  const shared = ((await (await api("/v1/shared-voices?language=nl&page_size=100")).json()).voices ?? []) as V[];
  const row = (v: V) =>
    [v.voice_id, v.name, v.gender ?? v.labels?.gender ?? "", v.accent ?? v.labels?.accent ?? "", (v.description ?? v.labels?.description ?? "").slice(0, 60)].join(" | ");
  console.log("Your voices:");
  for (const v of own) console.log("  " + row(v));
  const flemish = (v: V) => /flem|belg|vlaam|antwerp|gent/i.test(`${v.accent} ${v.description} ${v.name}`);
  console.log("\nShared library, Dutch, Flemish-sounding first (add one to your voices in ElevenLabs before using it):");
  for (const v of [...shared.filter(flemish), ...shared.filter((v) => !flemish(v))]) console.log("  " + row(v));
}

/** The texts to narrate: every card page (warm-up and learn cards) of the chosen reviewed missions. */
function cardTexts(): { mission: string; title: string; text: string }[] {
  const wanted = values.missions === "all" ? null : new Set(values.missions ? values.missions.split(",") : DEFAULT_MISSIONS);
  const out: { mission: string; title: string; text: string }[] = [];
  for (const object of samplePack.objects) {
    if (object.review.status !== "reviewed") continue;
    for (const mission of object.missions) {
      if (wanted && !wanted.has(mission.id)) continue;
      for (const card of [mission.warmup, ...mission.learn]) out.push({ mission: mission.id, title: mission.title, text: normaliseNarration(narrationText(card)) });
    }
  }
  if (wanted) for (const id of wanted) if (!out.some((t) => t.mission === id)) throw new Error(`No reviewed mission "${id}"`);
  return out;
}

function voices(): Partial<Record<Narrator, string>> {
  const map: Partial<Record<Narrator, string>> = {};
  for (const pair of values.voice ?? []) {
    const [narrator, id] = pair.split("=");
    if (!NARRATORS.includes(narrator as Narrator) || !id) throw new Error(`--voice takes ${NARRATORS.join("|")}=<voiceId>, got "${pair}"`);
    map[narrator as Narrator] = id;
  }
  return map;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);

/** A plain page to listen to every clip side by side: open narration/out/index.html in a browser. */
function listeningPage(manifest: NarrationManifest, texts: ReturnType<typeof cardTexts>): string {
  const narrators = NARRATORS.filter((n) => manifest.narrators[n]);
  const rows = texts
    .map(({ mission, text }, i) => {
      const prev = texts[i - 1]?.mission;
      const head = prev !== mission ? `<h2>${esc(texts[i]!.title)} <small>(${esc(mission)})</small></h2>` : "";
      const players = narrators
        .map((n) => {
          const file = manifest.narrators[n]!.clips[narrationKey(text)];
          return file ? `<div><b>${n}</b> <audio controls preload="none" src="${n}/${file}"></audio></div>` : `<div><b>${n}</b> (geen clip)</div>`;
        })
        .join("");
      return `${head}<section><p>${esc(text)}</p>${players}</section>`;
    })
    .join("\n");
  const voicesLine = narrators.map((n) => `${n}: ${esc(manifest.narrators[n]!.voiceName)} (${esc(manifest.narrators[n]!.model)})`).join(" · ");
  return `<!doctype html><html lang="nl-BE"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Breinhap stemproef</title><style>body{font:16px/1.5 system-ui;max-width:760px;margin:2rem auto;padding:0 1rem}section{border:1px solid #ccd;border-radius:8px;padding:.75rem;margin:.75rem 0}audio{vertical-align:middle;height:36px}small{color:#667}</style><h1>Breinhap stemproef</h1><p>${voicesLine}</p>${rows}</html>`;
}

async function main() {
  if (values["list-voices"]) return listVoices();
  const texts = cardTexts();
  const unique = [...new Set([NARRATION_PREVIEW, ...texts.map((t) => t.text)])];
  const chars = unique.reduce((n, t) => n + t.length, 0);
  // about 14 characters a second in calm Dutch speech; 64 kbit/s is 8 kB a second
  const seconds = chars / 14;
  const kbps = Number(/_(\d+)$/.exec(values.format)?.[1] ?? 64);
  console.log(`${texts.length} cards, ${unique.length} distinct texts, ${chars} characters per voice`);
  console.log(`≈ ${Math.round(seconds)} s of audio, ≈ ${((seconds * kbps) / 8 / 1024).toFixed(1)} MB per voice at ${kbps} kbit/s`);
  if (values["dry-run"]) {
    for (const t of texts) console.log(`  ${narrationKey(t.text)}  ${t.mission}: ${t.text.slice(0, 70)}${t.text.length > 70 ? "…" : ""}`);
    return;
  }

  const chosen = voices();
  if (!Object.keys(chosen).length) throw new Error("Pass at least one --voice vrouw=<voiceId> or --voice man=<voiceId> (find ids with --list-voices).");
  const out = values.out;
  const manifestPath = join(out, "manifest.json");
  let manifest: NarrationManifest = { keyVersion: NARRATION_KEY_VERSION, narrators: {} };
  try {
    const saved = JSON.parse(await readFile(manifestPath, "utf8")) as NarrationManifest;
    if (saved.keyVersion === NARRATION_KEY_VERSION) manifest = saved;
  } catch {}

  for (const [narrator, voiceId] of Object.entries(chosen) as [Narrator, string][]) {
    const dir = join(out, narrator);
    let entry = manifest.narrators[narrator];
    if (!entry || entry.voiceId !== voiceId || entry.model !== values.model || entry.format !== values.format) {
      // another voice, model or format: none of the old clips are valid (look the voice up first, so a
      // bad id or key leaves the old clips in place)
      const info = await (await api(`/v1/voices/${encodeURIComponent(voiceId)}`)).json();
      await rm(dir, { recursive: true, force: true });
      entry = { provider: "elevenlabs", voiceId, voiceName: String(info.name ?? voiceId), model: values.model, format: values.format, clips: {} };
    }
    await mkdir(dir, { recursive: true });
    const keep: Record<string, string> = {};
    let made = 0;
    for (const text of unique) {
      const key = narrationKey(text);
      const file = `${key}.mp3`;
      if (entry.clips[key]) {
        keep[key] = entry.clips[key]!;
        continue;
      }
      const res = await api(`/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(values.format)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: values.model, voice_settings: { stability: 0.6, similarity_boost: 0.75, style: 0, use_speaker_boost: true } }),
      });
      await writeFile(join(dir, file), Buffer.from(await res.arrayBuffer()));
      keep[key] = file;
      made++;
      process.stdout.write(`\r${narrator}: ${made} new clips`);
    }
    // clips for texts that changed or were dropped are removed, so a stale clip never ships
    for (const [key, file] of Object.entries(entry.clips)) if (!keep[key]) await rm(join(dir, file), { force: true });
    entry.clips = keep;
    manifest.narrators[narrator] = entry;
    console.log(`\r${narrator}: ${made} new, ${Object.keys(keep).length - made} reused (${entry.voiceName})`);
  }

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(join(out, "index.html"), listeningPage(manifest, texts));
  console.log(`Listen: ${join(out, "index.html")}`);
  if (values.install) await install(manifest, out);
}

/** Copy the clips into the app and the web player, replacing whatever was installed before. */
async function install(manifest: NarrationManifest, out: string) {
  const repo = resolve(import.meta.dirname, "../../..");
  const mobile = join(repo, "apps/mobile/assets/narration");
  const web = join(repo, "apps/management/narration");
  const requires: string[] = [];
  for (const dir of [mobile, web]) await rm(dir, { recursive: true, force: true });
  for (const narrator of NARRATORS) {
    const entry = manifest.narrators[narrator];
    if (!entry) continue;
    for (const dir of [mobile, web]) await mkdir(join(dir, narrator), { recursive: true });
    for (const file of Object.values(entry.clips)) {
      for (const dir of [mobile, web]) await copyFile(join(out, narrator, file), join(dir, narrator, file));
      requires.push(`  ${JSON.stringify(`${narrator}/${file}`)}: require("../../assets/narration/${narrator}/${file}"),`);
    }
  }
  await writeFile(join(web, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(
    join(repo, "apps/mobile/src/speech/recorded.ts"),
    `// GENERATED by \`pnpm --filter @breinhap/content narrate -- --install\`. Do not edit by hand.
import type { NarrationManifest } from "@breinhap/content";

export const manifest: NarrationManifest | null = ${JSON.stringify(manifest)};

/** "<narrator>/<file>" → the bundled clip asset. */
export const clipAssets: Record<string, number> = {
${requires.join("\n")}
};
`,
  );
  console.log(`Installed ${requires.length} clips into apps/mobile and apps/management.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
