import { coursesFor, pickMission, type ProfileCourse } from "@breinhap/content";
import { router } from "expo-router";
import { useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { SchoolPicker, profileLabel } from "../components/SchoolPicker";
import { AppText, Button, Card, Screen, styles } from "../components/ui";
import { includeDrafts, learningObjects, showsDrafts } from "../content";
import { LEGAL } from "../links";
import { useProfile } from "../settings/ProfileContext";
import { useSettings } from "../settings/SettingsContext";

const TIME_OPTIONS = [2, 5, 10, 15] as const;

/**
 * Home. The first time, the student picks their school, year and richting
 * once. After that: pick a vak, then "Ik heb __ minuten" picks the single
 * best next mission, so there is never a long menu to choose from.
 */
export default function Home() {
  const { loaded, profile, save } = useProfile();

  if (!loaded) return <Screen>{null}</Screen>;
  if (!profile) {
    return (
      <Screen>
        <AppText muted>Welkom bij Breinhap. Dit vragen we maar één keer. Het blijft op je toestel.</AppText>
        <SchoolPicker onDone={save} />
        <Footer />
      </Screen>
    );
  }
  return <Study label={profileLabel(profile)} courses={coursesFor(profile, learningObjects)} />;
}

function Study({ label, courses }: { label: string; courses: ProfileCourse[] }) {
  const { doneToday } = useSettings();
  const [courseId, setCourseId] = useState<string | null>(null);
  const [minutes, setMinutes] = useState<number | null>(null);
  const ready = courses.filter((c) => c.objects.length > 0);
  const soon = courses.filter((c) => c.objects.length === 0);
  const current = ready.find((c) => c.course.id === courseId);
  const choice =
    !current || minutes === null
      ? undefined
      : pickMission(current.objects, minutes, { includeDrafts, doneToday });

  return (
    <Screen>
      <AppText variant="small" muted>{label}</AppText>
      {showsDrafts && <AppText muted>Proefversie: deze missies zijn nog niet nagekeken.</AppText>}

      {!current && (
        <>
          <AppText variant="big">Wat wil je nu studeren?</AppText>
          {ready.map(({ course }) => (
            <Button
              key={course.id}
              kind="secondary"
              label={course.label}
              onPress={() => {
                setCourseId(course.id);
                setMinutes(null);
              }}
            />
          ))}
          {ready.length === 0 && (
            <Card>
              <AppText>Voor jouw vakken staan er nog geen missies in deze versie. Ze komen eraan.</AppText>
            </Card>
          )}
          {soon.length > 0 && (
            <Card>
              <AppText variant="small" muted>Binnenkort</AppText>
              <AppText muted>{soon.map((c) => c.course.label).join(", ")}</AppText>
            </Card>
          )}
        </>
      )}

      {current && (
        <>
          <AppText muted>{current.course.label}</AppText>
          <AppText variant="big">Hoeveel tijd heb je?</AppText>
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

          {choice && (
            <Card>
              <AppText variant="title">{choice.mission.title}</AppText>
              <AppText muted>{`${choice.mission.minutes} minuten · 4 stappen · geen tijdsdruk`}</AppText>
              <Button
                label={`Start — ${choice.mission.minutes} min`}
                onPress={() => router.push(`/mission/${choice.mission.id}`)}
              />
            </Card>
          )}

          {minutes !== null && !choice && (
            <Card>
              <AppText>
                {minutes <= 2
                  ? "Geen missie past in 2 minuten. Kies wat meer tijd, of neem een pauze. Dat mag ook."
                  : "Je hebt alles van dit vak voor vandaag al gedaan. Goed bezig. Kies een ander vak of kom morgen terug."}
              </AppText>
            </Card>
          )}

          <Button kind="secondary" label="Ander vak" onPress={() => setCourseId(null)} />
        </>
      )}

      {doneToday.size > 0 && (
        <AppText muted>{`Vandaag: ${doneToday.size} ${doneToday.size === 1 ? "missie" : "missies"} gedaan.`}</AppText>
      )}

      <Footer />
    </Screen>
  );
}

/** Instellingen, Over and the legal pages stay reachable from every home state. */
function Footer() {
  return (
    <>
      <Button kind="secondary" label="Instellingen" onPress={() => router.push("/instellingen")} />
      <Button kind="secondary" label="Over Breinhap" onPress={() => router.push("/over")} />

      <View style={[styles.row, { justifyContent: "center" }]}>
        {LEGAL.slice(0, 2).map((page) => (
          <Pressable
            key={page.url}
            accessibilityRole="link"
            accessibilityHint="Opent de website van Breinhap"
            hitSlop={8}
            onPress={() => {
              Linking.openURL(page.url).catch(() => {});
            }}
          >
            <AppText variant="small" muted style={{ textDecorationLine: "underline" }}>
              {page.label}
            </AppText>
          </Pressable>
        ))}
      </View>
    </>
  );
}
