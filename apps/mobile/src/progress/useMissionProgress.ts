import type { Mission } from "@breinhap/content";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Answer, type Progress, advance, freshProgress, missionPages, updateAnswer } from "./model";
import { createProgressStorage } from "./storage";

export const missionStorage = createProgressStorage(AsyncStorage);

/** The screen is keyed by mission content, so a route/content change gets a fresh session. */
export function useMissionProgress(mission: Mission) {
  const pages = missionPages(mission);
  const [progress, setProgress] = useState<Progress>(freshProgress);
  const current = useRef(progress);
  const [phase, setPhase] = useState<"loading" | "choice" | "active" | "load-error">("loading");
  const [saveError, setSaveError] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const alive = useRef(true);
  const sequence = useRef(0);
  const loadSequence = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const request = ++loadSequence.current;
    setPhase("loading");
    try {
      const result = await missionStorage.load(mission);
      if (!alive.current || request !== loadSequence.current) return;
      current.current = result.progress ?? freshProgress();
      setProgress(current.current);
      setDiscarded(result.discarded);
      setSaveError(false);
      setPhase(result.progress ? "choice" : "active");
    } catch {
      if (alive.current && request === loadSequence.current) setPhase("load-error");
    }
  }, [mission]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(next: Progress): Promise<boolean> {
    const request = ++sequence.current;
    try {
      await missionStorage.save(mission, next);
      if (alive.current && request === sequence.current) setSaveError(false);
      return true;
    } catch {
      if (alive.current && request === sequence.current) setSaveError(true);
      return false;
    }
  }

  function change(next: Progress) {
    if (phase !== "active" || locked.current || next === current.current) return;
    current.current = next;
    setProgress(next);
    void save(next);
  }

  async function restart() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      await missionStorage.clear(mission.id);
      if (!alive.current) return;
      current.current = freshProgress();
      setProgress(current.current);
      setSaveError(false);
      setDiscarded(false);
      setPhase("active");
    } catch {
      if (alive.current) setSaveError(true);
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function leave(onSaved: () => void) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    const saved = await save(current.current);
    locked.current = false;
    if (!alive.current) return;
    setBusy(false);
    if (saved) onSaved();
  }

  return {
    progress,
    pages,
    phase,
    busy,
    saveError,
    discarded,
    resume: () => setPhase("active"),
    restart,
    retryLoad: load,
    retrySave: () => save(current.current),
    leave,
    answer: (index: number, value: Answer) => change(updateAnswer(current.current, pages, index, value)),
    next: (index: number) => change(advance(current.current, pages, index)),
  };
}
