import type { Mission } from "@breinhap/content";
import { type Progress, decodeProgress, encodeProgress } from "./model.ts";

interface Storage {
  getAllKeys(): Promise<readonly string[]>;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<unknown>;
  removeItem(key: string): Promise<unknown>;
}

/** One queue per mission: old writes cannot resurrect a cleared or restarted checkpoint. */
export function createProgressStorage(storage: Storage) {
  const tails = new Map<string, Promise<void>>();
  const prefix = "breinhap.mission.v1.";
  const keyOf = (id: string) => `${prefix}${encodeURIComponent(id)}`;
  function writeKey(key: string, raw: string | null): Promise<void> {
    const previous = tails.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        if (raw === null) await storage.removeItem(key);
        else await storage.setItem(key, raw);
      });
    tails.set(key, next);
    // Attach rejection handling immediately, while preserving failure for callers.
    void next
      .catch(() => {})
      .finally(() => {
        if (tails.get(key) === next) tails.delete(key);
      });
    return next;
  }
  return {
    async load(mission: Mission) {
      await tails.get(keyOf(mission.id))?.catch(() => {});
      const raw = await storage.getItem(keyOf(mission.id));
      const progress = raw === null ? null : decodeProgress(mission, raw);
      if (raw !== null && progress === null) await writeKey(keyOf(mission.id), null);
      return { progress, discarded: raw !== null && progress === null };
    },
    save: (mission: Mission, progress: Progress) => writeKey(keyOf(mission.id), encodeProgress(mission, progress)),
    clear: (id: string) => writeKey(keyOf(id), null),
    async prune(missionIds: readonly string[]) {
      // Include checkpoints whose save was already queued when cleanup began.
      await Promise.allSettled([...tails.values()]);
      const retained = new Set(missionIds.map(keyOf));
      const keys = await storage.getAllKeys();
      const stale = keys.filter((key) => key.startsWith(prefix) && !retained.has(key));
      const results = await Promise.allSettled(stale.map((key) => writeKey(key, null)));
      if (results.some((result) => result.status === "rejected")) throw new Error("progress.cleanup_failed");
    },
  };
}
