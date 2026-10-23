import * as Speech from "expo-speech";
import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type TextStyle } from "react-native";
import { useSettings } from "../settings/SettingsContext";
import { fontSize, radius, spacing } from "../theme/tokens";

export function Screen({ children }: { children: ReactNode }) {
  const { palette } = useSettings();
  return (
    <ScrollView
      style={{ backgroundColor: palette.background }}
      contentContainerStyle={styles.screen}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

type Variant = "body" | "small" | "title" | "big";

export function AppText({
  children,
  variant = "body",
  muted,
  style,
}: {
  children: ReactNode;
  variant?: Variant;
  muted?: boolean;
  style?: TextStyle;
}) {
  const { palette, textScale } = useSettings();
  const size = fontSize[variant] * textScale;
  return (
    <Text
      accessibilityRole={variant === "title" || variant === "big" ? "header" : "text"}
      style={[
        {
          color: muted ? palette.muted : palette.text,
          fontSize: size,
          lineHeight: size * 1.45,
          fontWeight: variant === "title" || variant === "big" ? "700" : "400",
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

export function Button({
  label,
  onPress,
  kind = "primary",
  disabled,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "secondary";
  disabled?: boolean;
  accessibilityHint?: string;
}) {
  const { palette, textScale } = useSettings();
  const primary = kind === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      {...(accessibilityHint ? { accessibilityHint } : {})}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: primary ? palette.primary : palette.surface,
          borderColor: primary ? palette.primary : palette.border,
          opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
        },
      ]}
    >
      <Text
        style={{
          color: primary ? palette.onPrimary : palette.text,
          fontSize: fontSize.body * textScale,
          fontWeight: "600",
          textAlign: "center",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Card({ children }: { children: ReactNode }) {
  const { palette } = useSettings();
  return (
    <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }]}>
      {children}
    </View>
  );
}

/** Read a text aloud in Flemish Dutch. Pressing again stops it. */
export function ReadAloud({ text }: { text: string }) {
  return (
    <Button
      kind="secondary"
      label="🔊 Voorlezen"
      accessibilityHint="Leest de tekst voor"
      onPress={async () => {
        if (await Speech.isSpeakingAsync()) {
          Speech.stop();
        } else {
          Speech.speak(text, { language: "nl-BE" });
        }
      }}
    />
  );
}

export const styles = StyleSheet.create({
  screen: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xl },
  button: {
    minHeight: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    justifyContent: "center",
  },
  card: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, gap: spacing.sm },
  row: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
});
