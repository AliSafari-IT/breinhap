import * as Speech from "expo-speech";
import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { type DeviceVoice } from "./voices";

let cache: DeviceVoice[] | null = null;

/** The voices installed on the device. Refreshed when the app returns (a voice may have been installed). */
export function useVoices(): { voices: DeviceVoice[]; loaded: boolean } {
  const [voices, setVoices] = useState<DeviceVoice[]>(cache ?? []);
  const [loaded, setLoaded] = useState(cache !== null);
  const load = useCallback(() => {
    Speech.getAvailableVoicesAsync()
      .then((list) => {
        cache = list;
        setVoices(list);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);
  useEffect(() => {
    load();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") load();
    });
    return () => sub.remove();
  }, [load]);
  return { voices, loaded };
}
