import AsyncStorage from "@react-native-async-storage/async-storage";
import { mergeContent, parsePublicCatalogue, type LearningObject } from "@breinhap/content";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { bundledObjects } from "../content";
import { CATALOGUE_URL } from "../links";
import { CatalogueError, createCatalogueStore, type DownloadError } from "./store";

export const catalogueStore = createCatalogueStore({
  storage: AsyncStorage,
  fetch: (url, init) => fetch(url, init),
  parse: parsePublicCatalogue,
  url: CATALOGUE_URL,
});

interface ContentValue {
  /** False until the downloaded copy (if any) has been read from the device. */
  loaded: boolean;
  /** Everything the app shows: bundled samples plus downloaded public missions. */
  objects: readonly LearningObject[];
  /** Only the downloaded public objects. */
  publicObjects: readonly LearningObject[];
  fetchedAt: string | undefined;
  /** Objects in the last download that this app version cannot show. */
  skipped: number;
  downloading: boolean;
  error: DownloadError | "save" | "forget" | undefined;
  download: () => Promise<void>;
  forget: () => Promise<void>;
}

const ContentContext = createContext<ContentValue | null>(null);

export function ContentProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [publicObjects, setPublicObjects] = useState<readonly LearningObject[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | undefined>();
  const [skipped, setSkipped] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<ContentValue["error"]>();
  const busy = useRef(false);

  useEffect(() => {
    let alive = true;
    catalogueStore
      .load()
      .then((copy) => {
        if (!alive || !copy) return;
        setPublicObjects(copy.objects);
        setFetchedAt(copy.fetchedAt);
        setSkipped(copy.skipped);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const download = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setDownloading(true);
    setError(undefined);
    try {
      const copy = await catalogueStore.download();
      setPublicObjects(copy.objects);
      setFetchedAt(copy.fetchedAt);
      setSkipped(copy.skipped);
      if (!copy.saved) setError("save");
    } catch (e) {
      setError(e instanceof CatalogueError ? e.kind : "offline");
    } finally {
      busy.current = false;
      setDownloading(false);
    }
  }, []);

  const forget = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setError(undefined);
    try {
      await catalogueStore.forget();
      setPublicObjects([]);
      setFetchedAt(undefined);
      setSkipped(0);
    } catch {
      setError("forget");
    } finally {
      busy.current = false;
    }
  }, []);

  const value = useMemo<ContentValue>(
    () => ({
      loaded,
      objects: mergeContent(bundledObjects, publicObjects),
      publicObjects,
      fetchedAt,
      skipped,
      downloading,
      error,
      download,
      forget,
    }),
    [loaded, publicObjects, fetchedAt, skipped, downloading, error, download, forget],
  );
  return <ContentContext.Provider value={value}>{children}</ContentContext.Provider>;
}

export function useContent(): ContentValue {
  const value = useContext(ContentContext);
  if (!value) throw new Error("useContent outside ContentProvider");
  return value;
}
