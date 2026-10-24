import { Linking, Switch, View } from "react-native";
import { AppText, Button, Card, Screen, styles } from "../components/ui";
import { useSettings, type ThemePreference } from "../settings/SettingsContext";
import { spacing } from "../theme/tokens";

const THEMES: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "Zoals mijn toestel" },
  { value: "light", label: "Licht" },
  { value: "dark", label: "Donker" },
];

/** The legal pages on the website (Dutch; each links its English version). Google Play also lists the privacy policy. */
const SITE = "https://breinhap.asafarim.site";
const LEGAL: Array<{ label: string; url: string }> = [
  { label: "Privacybeleid", url: `${SITE}/privacy/` },
  { label: "Gebruiksvoorwaarden", url: `${SITE}/voorwaarden/` },
  { label: "Cookies", url: `${SITE}/cookies/` },
  { label: "Je gegevens verwijderen", url: `${SITE}/account-verwijderen/` },
];

function Toggle({ label, hint, value, onChange }: { label: string; hint: string; value: boolean; onChange: (v: boolean) => void }) {
  const { palette } = useSettings();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
      <View style={{ flex: 1 }}>
        <AppText>{label}</AppText>
        <AppText variant="small" muted>
          {hint}
        </AppText>
      </View>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        trackColor={{ true: palette.primary, false: palette.border }}
      />
    </View>
  );
}

export default function SettingsScreen() {
  const { settings, update } = useSettings();
  return (
    <Screen>
      <Card>
        <AppText variant="title">Thema</AppText>
        <View style={styles.row}>
          {THEMES.map((theme) => (
            <Button
              key={theme.value}
              kind={settings.theme === theme.value ? "primary" : "secondary"}
              label={theme.label}
              onPress={() => update({ theme: theme.value })}
            />
          ))}
        </View>
      </Card>
      <Card>
        <Toggle
          label="Rustige modus"
          hint="Zachtere kleuren en niets dat beweegt of flitst."
          value={settings.calm}
          onChange={(calm) => update({ calm })}
        />
        <Toggle
          label="Grote tekst"
          hint="Alle tekst wordt groter."
          value={settings.largeText}
          onChange={(largeText) => update({ largeText })}
        />
      </Card>
      <Card>
        <AppText variant="title">Privacy en voorwaarden</AppText>
        <AppText variant="small" muted>
          Breinhap vraagt nooit naar een diagnose. Deze instellingen blijven op je toestel. De app stuurt niets over jou
          door.
        </AppText>
        <View style={styles.row}>
          {LEGAL.map((page) => (
            <Button
              key={page.url}
              kind="secondary"
              label={page.label}
              accessibilityHint="Opent de website van Breinhap"
              onPress={() => {
                Linking.openURL(page.url).catch(() => {});
              }}
            />
          ))}
        </View>
      </Card>
    </Screen>
  );
}
