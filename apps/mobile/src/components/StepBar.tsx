import { StyleSheet, View } from "react-native";
import { useSettings } from "../settings/SettingsContext";
import { spacing } from "../theme/tokens";
import { AppText } from "./ui";

export const STEPS = ["Opwarmen", "Leren", "Doen", "Check"] as const;
export type Step = (typeof STEPS)[number];

/** The same four steps on every mission, so the structure never surprises. */
export function StepBar({ current }: { current: Step }) {
  const { palette } = useSettings();
  const index = STEPS.indexOf(current);
  return (
    <View
      accessible
      accessibilityLabel={`Stap ${index + 1} van 4: ${current}`}
      style={styles.bar}
    >
      {STEPS.map((step, i) => (
        <View key={step} style={styles.step}>
          <View
            style={[
              styles.track,
              { backgroundColor: i <= index ? palette.primary : palette.border },
            ]}
          />
          <AppText variant="small" muted={i !== index}>
            {step}
          </AppText>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", gap: spacing.sm },
  step: { flex: 1, gap: spacing.xs },
  track: { height: 6, borderRadius: 3 },
});
