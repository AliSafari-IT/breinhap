import type { Card as CardContent, Question } from "@breinhap/content";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { QuestionView } from "../../components/Questions";
import { StepBar, type Step } from "../../components/StepBar";
import { AppText, Button, Card, ReadAloud, Screen } from "../../components/ui";
import { findMission } from "../../content";
import { useSettings } from "../../settings/SettingsContext";

type Page =
  | { step: Step; kind: "card"; card: CardContent }
  | { step: Step; kind: "question"; question: Question };

/**
 * One mission: Opwarmen → Leren → Doen → Check, one thing per screen.
 * Stopping is always allowed and costs nothing.
 */
export default function MissionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const found = findMission(String(id));
  const { markDone } = useSettings();
  const [index, setIndex] = useState(0);
  const [correct, setCorrect] = useState(0);

  if (!found) {
    return (
      <Screen>
        <AppText variant="title">Deze missie bestaat niet (meer).</AppText>
        <Button label="Terug naar start" onPress={() => router.replace("/")} />
      </Screen>
    );
  }

  const { mission } = found;
  const pages: Page[] = [
    { step: "Opwarmen", kind: "card", card: mission.warmup },
    ...mission.learn.map((card): Page => ({ step: "Leren", kind: "card", card })),
    ...mission.practice.map((question): Page => ({ step: "Doen", kind: "question", question })),
    ...mission.check.map((question): Page => ({ step: "Check", kind: "question", question })),
  ];
  const questionCount = mission.practice.length + mission.check.length;
  const page = pages[index];
  const next = () => setIndex(index + 1);

  if (!page) {
    return (
      <Screen>
        <AppText variant="big">Missie klaar.</AppText>
        <AppText>{`Je had ${correct} van de ${questionCount} vragen juist.`}</AppText>
        {mission.commonMistakes.length > 0 && (
          <Card>
            <AppText variant="title">Veelgemaakte fout</AppText>
            {mission.commonMistakes.map((m) => (
              <AppText key={m.mistake}>{`“${m.mistake}” — ${m.why}`}</AppText>
            ))}
          </Card>
        )}
        <Button
          label="Terug naar start"
          onPress={() => {
            markDone(mission.id);
            router.replace("/");
          }}
        />
      </Screen>
    );
  }

  const isLast = index === pages.length - 1;
  return (
    <Screen>
      <StepBar current={page.step} />
      <AppText muted>{`${mission.title} · ${index + 1} van ${pages.length}`}</AppText>
      {isLast && <AppText muted>Laatste vraag.</AppText>}

      {page.kind === "card" ? (
        <Card>
          <AppText>{page.card.text}</AppText>
          {page.card.example && <AppText muted>{`Voorbeeld: ${page.card.example}`}</AppText>}
          <ReadAloud text={[page.card.text, page.card.example].filter(Boolean).join(" ")} />
          <Button label="Verder" onPress={next} />
        </Card>
      ) : (
        <QuestionView
          key={index}
          seed={index + 1}
          question={page.question}
          onDone={(ok) => {
            if (ok) setCorrect(correct + 1);
            next();
          }}
        />
      )}

      <Button kind="secondary" label="Pauze — later verder" onPress={() => router.back()} />
    </Screen>
  );
}
