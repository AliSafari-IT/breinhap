import * as Speech from "expo-speech";
import { Linking, Platform, View } from "react-native";
import { useSettings } from "../settings/SettingsContext";
import { useVoices } from "../speech/useVoices";
import { dutchVoices, speechOptions, voiceLabels, type Tempo } from "../speech/voices";
import { AppText, Button, Card, styles } from "./ui";

const PREVIEW = "Hallo! Zo klink ik als ik een kaart voorlees.";
const TEMPOS: Array<{ value: Tempo; label: string }> = [
  { value: "rustig", label: "Rustig" },
  { value: "normaal", label: "Normaal" },
];

function openSpeechSettings() {
  if (Platform.OS !== "android") return;
  Linking.sendIntent("com.android.settings.TTS_SETTINGS").catch(() => {
    Linking.openSettings().catch(() => {});
  });
}

/**
 * Instellingen → Voorleesstem: pick one of the Dutch voices on the device (tapping one plays a short
 * preview), and a tempo. Only on-device voices are offered, so read-aloud works offline and the text
 * never leaves the phone. Without a Dutch voice, it explains how to install one.
 */
export function VoicePicker() {
  const { settings, update } = useSettings();
  const { voices: all, loaded } = useVoices();
  const voices = dutchVoices(all);
  const labels = voiceLabels(voices);
  const current = speechOptions(all, settings);

  const preview = (choice: { voiceId: string | null; tempo: Tempo }) => {
    void Speech.stop().finally(() => Speech.speak(PREVIEW, speechOptions(all, choice)));
  };

  return (
    <Card>
      <AppText variant="title">Voorleesstem</AppText>
      {loaded && voices.length === 0 ? (
        <AppText muted>
          Er staat nog geen Nederlandse stem op je toestel. Installeer er een via de spraakinstellingen van je toestel. Daarna kies je hier je stem.
        </AppText>
      ) : (
        <>
          <AppText variant="small" muted>
            Tik op een stem om ze te horen. De stemmen staan op je toestel: voorlezen werkt zonder internet.
          </AppText>
          <View style={styles.row}>
            {voices.map((voice) => (
              <Button
                key={voice.identifier}
                kind={current.voice === voice.identifier ? "primary" : "secondary"}
                label={labels.get(voice.identifier) ?? voice.name}
                accessibilityHint="Kiest deze stem en laat ze horen"
                onPress={() => {
                  update({ voiceId: voice.identifier });
                  preview({ voiceId: voice.identifier, tempo: settings.tempo });
                }}
              />
            ))}
          </View>
        </>
      )}
      <AppText variant="small" muted>
        Tempo
      </AppText>
      <View style={styles.row}>
        {TEMPOS.map((tempo) => (
          <Button
            key={tempo.value}
            kind={settings.tempo === tempo.value ? "primary" : "secondary"}
            label={tempo.label}
            onPress={() => {
              update({ tempo: tempo.value });
              preview({ voiceId: settings.voiceId, tempo: tempo.value });
            }}
          />
        ))}
      </View>
      {Platform.OS === "android" && (
        <Button
          kind="secondary"
          label="Meer stemmen installeren"
          accessibilityHint="Opent de spraakinstellingen van je toestel"
          onPress={openSpeechSettings}
        />
      )}
    </Card>
  );
}
