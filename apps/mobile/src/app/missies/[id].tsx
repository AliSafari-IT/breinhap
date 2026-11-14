import { router, useLocalSearchParams } from "expo-router";
import { useContent } from "../../catalogue/ContentContext";
import { AppText, Button, Card, Screen } from "../../components/ui";
import { subjectLabel } from "../../content";
import { useSettings } from "../../settings/SettingsContext";

/** One downloaded object: its leerdoel, then one Start per mission (Opwarmen → Leren → Doen → Check). */
export default function PublicObjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { loaded, publicObjects } = useContent();
  const { doneToday } = useSettings();
  if (!loaded) return <Screen>{null}</Screen>;
  const object = publicObjects.find((o) => o.id === String(id));
  if (!object)
    return (
      <Screen>
        <AppText variant="title">Deze missies staan niet (meer) op je toestel.</AppText>
        <Button label="Terug naar Meer missies" onPress={() => router.replace("/missies")} />
      </Screen>
    );
  return (
    <Screen>
      <AppText variant="big">{object.title}</AppText>
      <AppText muted>{`${subjectLabel[object.subject]} · ${object.grade}de jaar`}</AppText>
      <AppText>{object.curriculum.leerdoel}</AppText>
      <AppText muted>Elke missie gaat zo: opwarmen, leren, doen, check. Geen tijdsdruk.</AppText>
      {object.missions.map((mission) => (
        <Card key={mission.id}>
          <AppText variant="title">{mission.title}</AppText>
          <AppText muted>
            {`${mission.minutes} minuten · ${mission.practice.length + mission.check.length} vragen${
              doneToday.has(mission.id) ? " · vandaag gedaan" : ""
            }`}
          </AppText>
          <Button label={`Start — ${mission.minutes} min`} onPress={() => router.push(`/mission/${mission.id}`)} />
        </Card>
      ))}
    </Screen>
  );
}
