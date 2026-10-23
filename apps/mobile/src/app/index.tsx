import { pickMission } from "@breinhap/content";
import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { AppText, Button, Card, Screen, styles } from "../components/ui";
import { includeDrafts, learningObjects, subjectLabel } from "../content";
import { useSettings } from "../settings/SettingsContext";

const TIME_OPTIONS = [2, 5, 10, 15] as const;

/**
 * Home: one question, one answer. "Ik heb __ minuten" picks the single best
 * next mission, so the student never has to choose from a long menu first.
 */
export default function Home() {
  const { doneToday } = useSettings();
  const [minutes, setMinutes] = useState<number | null>(null);
  const choice =
    minutes === null ? undefined : pickMission(learningObjects, minutes, { includeDrafts, doneToday });

  return (
    <Screen>
      <AppText variant="big">Hoeveel tijd heb je?</AppText>
      {includeDrafts && <AppText muted>Proefversie: deze missies zijn nog niet nagekeken.</AppText>}
      <View style={styles.row}>
        {TIME_OPTIONS.map((option) => (
          <View key={option} style={{ flexGrow: 1, minWidth: 120 }}>
            <Button
              kind={minutes === option ? "primary" : "secondary"}
              label={`${option} minuten`}
              onPress={() => setMinutes(option)}
            />
          </View>
        ))}
      </View>

      {minutes !== null && choice && (
        <Card>
          <AppText muted>{subjectLabel[choice.object.subject] ?? choice.object.subject}</AppText>
          <AppText variant="title">{choice.mission.title}</AppText>
          <AppText muted>
            {`${choice.mission.minutes} minuten · 4 stappen · geen tijdsdruk`}
          </AppText>
          <Button
            label={`Start — ${choice.mission.minutes} min`}
            onPress={() => router.push(`/mission/${choice.mission.id}`)}
          />
        </Card>
      )}

      {minutes !== null && !choice && (
        <Card>
          <AppText>
            {learningObjects.length === 0
              ? "Er staan nog geen missies in deze versie. Ze komen eraan."
              : minutes <= 2
              ? "Geen missie past in 2 minuten. Kies wat meer tijd, of neem een pauze. Dat mag ook."
              : "Je hebt alles van vandaag al gedaan. Goed bezig. Morgen is er meer."}
          </AppText>
        </Card>
      )}

      {doneToday.size > 0 && (
        <AppText muted>{`Vandaag: ${doneToday.size} ${doneToday.size === 1 ? "missie" : "missies"} gedaan.`}</AppText>
      )}

      <Button kind="secondary" label="Instellingen" onPress={() => router.push("/instellingen")} />
    </Screen>
  );
}
