import type { Mission } from "@breinhap/content";
import { type Progress, decodeProgress, encodeProgress } from "./model.ts";

interface Storage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<unknown>;
  removeItem(key: string): Promise<unknown>;
}

/** One queue per mission: old writes cannot resurrect a cleared or restarted checkpoint. */
export function createProgressStorage(storage: Storage) {
  const tails = new Map<string, Promise<void>>();
  const keyOf = (id: string) => `breinhap.mission.v1.${encodeURIComponent(id)}`;
  function write(id: string, raw: string | null): Promise<void> {
    const previous = tails.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        if (raw === null) await storage.removeItem(keyOf(id));
        else await storage.setItem(keyOf(id), raw);
      });
    tails.set(id, next);
    // Attach rejection handling immediately, while preserving failure for callers.
    void next
      .catch(() => {})
      .finally(() => {
        if (tails.get(id) === next) tails.delete(id);
      });
    return next;
  }
  return {
    async load(mission: Mission) {
      await tails.get(mission.id)?.catch(() => {});
      const raw = await storage.getItem(keyOf(mission.id));
      const progress = raw === null ? null : decodeProgress(mission, raw);
      if (raw !== null && progress === null) await write(mission.id, null);
      return { progress, discarded: raw !== null && progress === null };
    },
    save: (mission: Mission, progress: Progress) => write(mission.id, encodeProgress(mission, progress)),
    clear: (id: string) => write(id, null),
  };
}
