import type { LearningObject, Subject } from "@breinhap/content";
import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { useContent } from "../../catalogue/ContentContext";
import { AppText, Button, Card, Screen, styles } from "../../components/ui";
import { subjectLabel } from "../../content";
import { useProfile } from "../../settings/ProfileContext";

const ERRORS = {
  offline: "Downloaden lukt nu niet. Ben je met het internet verbonden? Je missies op dit toestel werken gewoon verder.",
  unavailable: "breinhap.com geeft de missies nu niet. Probeer later opnieuw. Je missies op dit toestel werken gewoon verder.",
  invalid: "Deze download past niet bij deze versie van de app. Werk de app bij en probeer opnieuw.",
  save: "De missies zijn geladen, maar bewaren op je toestel lukte niet. Na het sluiten van de app moet je opnieuw downloaden.",
  forget: "Wissen lukt nu niet. Probeer opnieuw.",
} as const;

function day(iso: string): string {
  const date = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString("nl-BE", { day: "numeric", month: "long", year: "numeric" });
}

/**
 * Meer missies: the public catalogue from breinhap.com. Nothing is fetched until the student taps
 * Downloaden; after that the missions stay on the device and work offline. Filter by vak and jaar.
 */
export default function CatalogueScreen() {
  const { loaded, publicObjects, fetchedAt, skipped, downloading, error, download, forget } = useContent();
  const { profile } = useProfile();
  const [subject, setSubject] = useState<Subject | null>(null);
  const [year, setYear] = useState<number | null | undefined>(undefined);
  const chosenYear = year === undefined ? (profile?.year ?? null) : year;

  if (!loaded) return <Screen>{null}</Screen>;

  const years = [...new Set(publicObjects.map((o) => o.grade))].sort();
  const yearFilter = chosenYear !== null && years.includes(chosenYear) ? chosenYear : null;
  const forYear = publicObjects.filter((o) => yearFilter === null || o.grade === yearFilter);
  const subjects = [...new Set(forYear.map((o) => o.subject))];
  const subjectFilter = subject && subjects.includes(subject) ? subject : null;
  const shown = forYear.filter((o) => subjectFilter === null || o.subject === subjectFilter);

  return (
    <Screen>
      <AppText variant="big">Meer missies</AppText>
      <AppText muted>
        Openbare missies van breinhap.com, nagekeken door ons team. Tik op Downloaden: daarna staan ze op je toestel en werken ze ook zonder internet.
      </AppText>

      <Card>
        <AppText variant="small" muted>
          {fetchedAt ? `Laatst gedownload: ${day(fetchedAt)}` : "Nog niets gedownload."}
        </AppText>
        <Button
          label={downloading ? "Even downloaden…" : fetchedAt ? "Opnieuw downloaden" : "Downloaden"}
          disabled={downloading}
          accessibilityHint="Haalt de openbare missies op van breinhap.com. Er gaat niets over jou mee."
          onPress={() => {
            void download();
          }}
        />
        {error && <AppText>{ERRORS[error]}</AppText>}
        {skipped > 0 && (
          <AppText variant="small" muted>
            {`${skipped} ${skipped === 1 ? "missiepakket past" : "missiepakketten passen"} nog niet in deze versie van de app.`}
          </AppText>
        )}
      </Card>

      {fetchedAt && publicObjects.length === 0 && (
        <Card>
          <AppText>Er staan nog geen openbare missies klaar. Kom later eens terug.</AppText>
        </Card>
      )}

      {publicObjects.length > 0 && (
        <>
          {years.length > 1 && (
            <View style={styles.row}>
              <Chip label="Alle jaren" on={yearFilter === null} onPress={() => setYear(null)} />
              {years.map((y) => (
                <Chip key={y} label={`${y}de jaar`} on={yearFilter === y} onPress={() => setYear(y)} />
              ))}
            </View>
          )}
          {subjects.length > 1 && (
            <View style={styles.row}>
              <Chip label="Alle vakken" on={subjectFilter === null} onPress={() => setSubject(null)} />
              {subjects.map((s) => (
                <Chip key={s} label={subjectLabel[s]} on={subjectFilter === s} onPress={() => setSubject(s)} />
              ))}
            </View>
          )}
          {shown.length === 0 && (
            <Card>
              <AppText>Voor deze keuze is er nog geen missie.</AppText>
              <Button kind="secondary" label="Toon alles" onPress={() => setYear(null)} />
            </Card>
          )}
          {shown.map((object) => (
            <ObjectRow key={object.id} object={object} />
          ))}
          <Button
            kind="secondary"
            label="Gedownloade missies wissen"
            disabled={downloading}
            accessibilityHint="Wist de gedownloade missies van dit toestel. De missies in de app blijven."
            onPress={() => {
              void forget();
            }}
          />
        </>
      )}
    </Screen>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <View style={{ flexGrow: 1, minWidth: 110 }}>
      <Button kind={on ? "primary" : "secondary"} label={label} onPress={onPress} />
    </View>
  );
}

function ObjectRow({ object }: { object: LearningObject }) {
  const minutes = object.missions.reduce((n, m) => n + m.minutes, 0);
  return (
    <Card>
      <AppText variant="title">{object.title}</AppText>
      <AppText muted>
        {`${subjectLabel[object.subject]} · ${object.grade}de jaar · ${object.missions.length} ${
          object.missions.length === 1 ? "missie" : "missies"
        } · ${minutes} min`}
      </AppText>
      <Button kind="secondary" label="Bekijken" onPress={() => router.push(`/missies/${object.id}`)} />
    </Card>
  );
}
