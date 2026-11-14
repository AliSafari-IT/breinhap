import type { LearningObject, PublicCatalogue } from "@breinhap/content";

interface Storage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<unknown>;
  removeItem(key: string): Promise<unknown>;
}

type Fetch = (url: string, init: { method: "GET"; headers: Record<string, string>; credentials: "omit"; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface Downloaded {
  objects: LearningObject[];
  /** "YYYY-MM-DD": the day this copy was downloaded. */
  fetchedAt: string;
  skipped: number;
}

/** Why a download did not work, in words a student can act on (see the catalogue screen). */
export type DownloadError = "offline" | "unavailable" | "invalid";

export class CatalogueError extends Error {
  readonly kind: DownloadError;
  constructor(kind: DownloadError) {
    super(`catalogue.${kind}`);
    this.kind = kind;
  }
}

const KEY = "breinhap.catalogue.v1";

/**
 * The downloaded public catalogue. The app only goes online when the student taps "Downloaden":
 * one plain GET with no cookie, account or identifier. The answer is kept on the device as text
 * and parsed again at every start, so a copy that no longer fits this app is dropped, never
 * trusted. Without a download (or offline) the app shows its bundled sample missions as before.
 */
export function createCatalogueStore({
  storage,
  fetch,
  parse,
  url,
  today = () => new Date().toISOString().slice(0, 10),
  timeoutMs = 20_000,
}: {
  storage: Storage;
  fetch: Fetch;
  parse: (text: string) => PublicCatalogue;
  url: string;
  today?: () => string;
  timeoutMs?: number;
}) {
  return {
    /** The copy on the device, or null. An unreadable copy is removed. */
    async load(): Promise<Downloaded | null> {
      const raw = await storage.getItem(KEY);
      if (raw === null) return null;
      try {
        const saved = JSON.parse(raw) as { fetchedAt?: unknown; text?: unknown };
        if (typeof saved.fetchedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(saved.fetchedAt) || typeof saved.text !== "string")
          throw new Error("catalogue.invalid");
        return { ...parse(saved.text), fetchedAt: saved.fetchedAt };
      } catch {
        await storage.removeItem(KEY).catch(() => {});
        return null;
      }
    },

    /** Downloads the catalogue and replaces the copy on the device only when it is valid. */
    async download(): Promise<Downloaded & { saved: boolean }> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let text: string;
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: { Accept: "application/json" },
          credentials: "omit",
          signal: controller.signal,
        });
        if (!response.ok) throw new CatalogueError("unavailable");
        text = await response.text();
      } catch (error) {
        throw error instanceof CatalogueError ? error : new CatalogueError("offline");
      } finally {
        clearTimeout(timer);
      }
      let parsed: PublicCatalogue;
      try {
        parsed = parse(text);
      } catch {
        throw new CatalogueError("invalid");
      }
      const fetchedAt = today();
      let saved = true;
      try {
        await storage.setItem(KEY, JSON.stringify({ fetchedAt, text }));
      } catch {
        saved = false;
      }
      return { ...parsed, fetchedAt, saved };
    },

    /** Removes the downloaded missions from the device. */
    forget: () => storage.removeItem(KEY).then(() => undefined),
  };
}
