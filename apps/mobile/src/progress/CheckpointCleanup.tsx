import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { AppText, Button, Card } from "../components/ui";
import { useContent } from "../catalogue/ContentContext";
import { missionStorage } from "./useMissionProgress";

/** Cleanup does not depend on navigating to a lesson that no longer exists. */
export function CheckpointCleanup() {
  const { loaded, objects } = useContent();
  const missionIds = useRef<string[]>([]);
  missionIds.current = objects.flatMap((object) => object.missions.map((mission) => mission.id));
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const alive = useRef(true);
  const clean = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await missionStorage.prune(missionIds.current);
      if (alive.current) setFailed(false);
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    // only once the downloaded missions are known, or their paused progress would be wiped
    if (!loaded) return;
    void clean();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void clean();
    });
    return () => {
      alive.current = false;
      subscription.remove();
    };
  }, [clean, loaded, objects]);

  if (!failed) return null;
  return (
    <Card>
      <AppText>Het wissen van oude missievoortgang lukt nu niet.</AppText>
      <Button
        label="Opnieuw wissen"
        disabled={busy}
        onPress={() => {
          void clean();
        }}
      />
    </Card>
  );
}
