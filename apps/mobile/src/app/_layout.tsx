import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Text } from "react-native";
import { SettingsProvider, useSettings } from "../settings/SettingsContext";
import { versionLabel } from "../version";

function ThemedStack() {
  const { palette } = useSettings();
  return (
    <>
      {/* The header is always dark charcoal, so the status bar text is light. */}
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: palette.header },
          headerTintColor: palette.onHeader,
          contentStyle: { backgroundColor: palette.background },
          animation: "none",
        }}
      >
        <Stack.Screen
          name="index"
          options={{
            title: "Breinhap",
            // The version in the header shows at once whether an update is installed.
            headerRight: () => (
              <Text accessibilityLabel={`Versie ${versionLabel}`} style={{ color: palette.onHeader, opacity: 0.8, fontSize: 14 }}>
                {versionLabel}
              </Text>
            ),
          }}
        />
        <Stack.Screen name="mission/[id]" options={{ title: "Missie" }} />
        <Stack.Screen name="instellingen" options={{ title: "Instellingen" }} />
        <Stack.Screen name="over" options={{ title: "Over Breinhap" }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <SettingsProvider>
      <ThemedStack />
    </SettingsProvider>
  );
}
