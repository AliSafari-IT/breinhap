import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { AppText, Button, Card } from "../components/ui";
import { learningObjects } from "../content";
import { missionStorage } from "./useMissionProgress";

const missionIds = learningObjects.flatMap((object) => object.missions.map((mission) => mission.id));

/** Cleanup does not depend on navigating to a lesson that no longer exists. */
export function CheckpointCleanup() {
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const alive = useRef(true);
  const clean = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await missionStorage.prune(missionIds);
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
    void clean();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void clean();
    });
    return () => {
      alive.current = false;
      subscription.remove();
    };
  }, [clean]);

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
