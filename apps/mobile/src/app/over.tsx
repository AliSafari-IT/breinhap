import * as Application from "expo-application";
import Constants from "expo-constants";
import { Linking, View } from "react-native";
import { AppText, Button, Card, Screen, styles } from "../components/ui";
import { learningObjects } from "../content";
import { CONTACT_EMAIL, LEGAL, SITE } from "../links";

function open(url: string) {
  Linking.openURL(url).catch(() => {});
}

/** "1 januari 2026" from "2026-01-01"; the date stays as given if it does not parse. */
function formatDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("nl-BE", { day: "numeric", month: "long", year: "numeric" });
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
      <AppText muted>{label}</AppText>
      <AppText>{value}</AppText>
    </View>
  );
}

export default function AboutScreen() {
  const version = Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? "?";
  const build = Application.nativeBuildVersion;
  const buildDate = formatDate(Constants.expoConfig?.extra?.buildDate as string | undefined);
  const reviewed = learningObjects
    .map((object) => (object.review.status === "reviewed" ? object.review.reviewedAt : undefined))
    .filter((date): date is string => date !== undefined)
    .sort()
    .at(-1);
  const contentDate = formatDate(reviewed);

  return (
    <Screen>
      <AppText variant="big">Breinhap</AppText>
      <AppText>
        Korte, rustige leermissies voor het 3de middelbaar. Elke missie gaat zo: opwarmen, leren, doen, check.
      </AppText>
      <Card>
        <Row label="Versie" value={build ? `${version} (${build})` : version} />
        {buildDate && <Row label="Laatst bijgewerkt" value={buildDate} />}
        {contentDate && <Row label="Inhoud nagekeken" value={contentDate} />}
        <Row label="Missies in deze versie" value={String(learningObjects.reduce((n, o) => n + o.missions.length, 0))} />
      </Card>
      <Card>
        <AppText variant="title">Privacy en voorwaarden</AppText>
        <AppText variant="small" muted>
          Breinhap werkt zonder account en stuurt niets over jou door. Je instellingen blijven op je toestel.
        </AppText>
        <View style={styles.row}>
          {LEGAL.map((page) => (
            <Button
              key={page.url}
              kind="secondary"
              label={page.label}
              accessibilityHint="Opent de website van Breinhap"
              onPress={() => open(page.url)}
            />
          ))}
        </View>
      </Card>
      <Card>
        <AppText variant="title">Contact</AppText>
        <AppText variant="small" muted>
          Een fout gevonden in een missie, of een vraag over privacy? Mail ons.
        </AppText>
        <Button kind="secondary" label={CONTACT_EMAIL} onPress={() => open(`mailto:${CONTACT_EMAIL}`)} />
        <Button kind="secondary" label="Website van Breinhap" onPress={() => open(SITE)} />
      </Card>
    </Screen>
  );
}
