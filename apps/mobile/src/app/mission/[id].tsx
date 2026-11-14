import type { Mission } from "@breinhap/content";
import { router, useLocalSearchParams, usePreventRemove } from "expo-router";
import { useEffect, useState } from "react";
import { QuestionView } from "../../components/Questions";
import { StepBar } from "../../components/StepBar";
import { AppText, Button, Card, ReadAloud, Screen } from "../../components/ui";
import { useContent } from "../../catalogue/ContentContext";
import { findMission } from "../../content";
import { score } from "../../progress/model";
import { missionStorage, useMissionProgress } from "../../progress/useMissionProgress";
import { useSettings } from "../../settings/SettingsContext";

/**
 * One mission: Opwarmen → Leren → Doen → Check, one thing per screen.
 * Stopping is always allowed and costs nothing.
 */
export default function MissionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { loaded, objects } = useContent();
  // wait for the downloaded missions: "unavailable" clears a paused mission's progress
  if (!loaded)
    return (
      <Screen>
        <AppText>Even laden…</AppText>
      </Screen>
    );
  const found = findMission(objects, String(id));
  return found ? <MissionSession key={JSON.stringify(found.mission)} mission={found.mission} /> : <Unavailable id={String(id)} />;
}

function Unavailable({ id }: { id: string }) {
  useEffect(() => {
    void missionStorage.clear(id).catch(() => {});
  }, [id]);
  return (
    <Screen>
      <AppText variant="title">Deze missie bestaat niet (meer).</AppText>
      <Button label="Terug naar start" onPress={() => router.replace("/")} />
    </Screen>
  );
}

function MissionSession({ mission }: { mission: Mission }) {
  const { markDone } = useSettings();
  const session = useMissionProgress(mission);
  const { progress, pages, phase, busy, saveError } = session;
  const { index } = progress;
  const [leaving, setLeaving] = useState(false);
  const disablePrevention = usePreventRemove(phase === "active" && !leaving, () => {
    void leaveHome();
  });
  function leaveHome() {
    return session.leave(() => {
      setLeaving(true);
      disablePrevention();
      if (index === pages.length) markDone(mission.id);
      router.replace("/");
    });
  }
  const correct = score(progress, pages);
  const questionCount = mission.practice.length + mission.check.length;
  const page = pages[index];
  const next = () => session.next(index);
  const warning = saveError && (
    <Card>
      <AppText>Opslaan lukt nu niet. Je kunt hier verder oefenen. Probeer opnieuw op te slaan voordat je weggaat.</AppText>
      <Button
        label="Opnieuw opslaan"
        disabled={busy}
        onPress={() => {
          void session.retrySave();
        }}
      />
    </Card>
  );

  if (phase === "loading")
    return (
      <Screen>
        <AppText>Je voortgang wordt geladen…</AppText>
      </Screen>
    );
  if (phase === "load-error")
    return (
      <Screen>
        <AppText variant="title">Je voortgang kon niet worden geladen.</AppText>
        <AppText>Probeer opnieuw, of wis de opgeslagen voortgang van deze missie en begin opnieuw.</AppText>
        {saveError && <AppText>Wissen kon niet worden bevestigd. Probeer opnieuw of laad je voortgang opnieuw.</AppText>}
        <Button
          label="Opnieuw laden"
          disabled={busy}
          onPress={() => {
            void session.retryLoad();
          }}
        />
        <Button
          kind="secondary"
          label="Wissen en opnieuw beginnen"
          disabled={busy}
          onPress={() => {
            void session.restart();
          }}
        />
        <Button kind="secondary" label="Terug naar start" disabled={busy} onPress={() => router.replace("/")} />
      </Screen>
    );
  if (phase === "choice")
    return (
      <Screen>
        <AppText variant="title">Verder met je missie?</AppText>
        <AppText>{mission.title}</AppText>
        <AppText muted>{`Je was bij stap ${index + 1} van ${pages.length}. Je antwoorden blijven bewaard.`}</AppText>
        {saveError && <AppText>Opnieuw beginnen kon niet worden bevestigd. Probeer opnieuw of ga verder.</AppText>}
        <Button label="Verdergaan" disabled={busy} onPress={session.resume} />
        <Button
          kind="secondary"
          label="Opnieuw beginnen"
          disabled={busy}
          onPress={() => {
            void session.restart();
          }}
        />
        <Button kind="secondary" label="Terug naar start" disabled={busy} onPress={() => router.replace("/")} />
      </Screen>
    );

  if (!page) {
    return (
      <Screen>
        <AppText variant="big">Missie klaar.</AppText>
        {warning}
        <AppText>
          {correct > 0
            ? `Je had ${correct} van de ${questionCount} vragen juist.`
            : `Je hebt ${questionCount} vragen geoefend. Lees de uitleg nog eens rustig na.`}
        </AppText>
        {mission.commonMistakes.length > 0 && (
          <Card>
            <AppText variant="title">Veelgemaakte fout</AppText>
            {mission.commonMistakes.map((m) => (
              <AppText key={m.mistake}>{`“${m.mistake}” — ${m.why}`}</AppText>
            ))}
          </Card>
        )}
        <Button
          label={busy ? "Even opslaan…" : "Terug naar start"}
          disabled={busy}
          onPress={() => {
            void leaveHome();
          }}
        />
      </Screen>
    );
  }

  const isLast = index === pages.length - 1;
  return (
    <Screen>
      {warning}
      {session.discarded && <AppText muted>De opgeslagen voortgang past niet meer bij deze missie. Je begint opnieuw.</AppText>}
      <StepBar current={page.step} />
      <AppText muted>{`${mission.title} · ${index + 1} van ${pages.length}`}</AppText>
      {isLast && <AppText muted>Laatste vraag.</AppText>}

      {page.kind === "card" ? (
        <Card>
          <AppText>{page.card.text}</AppText>
          {page.card.example && <AppText muted>{`Voorbeeld: ${page.card.example}`}</AppText>}
          <ReadAloud text={[page.card.text, page.card.example].filter(Boolean).join(" ")} />
          <Button label="Verder" onPress={next} disabled={busy} />
        </Card>
      ) : (
        <QuestionView
          key={index}
          seed={index + 1}
          question={page.question}
          answer={progress.answers[index]}
          onAnswer={(answer) => session.answer(index, answer)}
          disabled={busy}
          onDone={next}
        />
      )}

      <Button
        kind="secondary"
        label={busy ? "Even opslaan…" : "Pauze — later verder"}
        disabled={busy}
        onPress={() => {
          void leaveHome();
        }}
      />
    </Screen>
  );
}
