import { NARRATION_PREVIEW } from "@breinhap/content";
import { Linking, Platform, View } from "react-native";
import { useSettings } from "../settings/SettingsContext";
import { read, recordedNarrators, type ReadChoice } from "../speech/narrate";
import { useVoices } from "../speech/useVoices";
import { dutchVoices, speechOptions, voiceLabels, type Tempo } from "../speech/voices";
import { AppText, Button, Card, styles } from "./ui";

const PREVIEW = NARRATION_PREVIEW;
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

  const preview = (choice: ReadChoice) => read(PREVIEW, choice, all);

  return (
    <Card>
      <AppText variant="title">Voorleesstem</AppText>
      {recordedNarrators.length > 0 && (
        <>
          <AppText variant="small" muted>
            Breinhap-stem: opgenomen voor de missies in de app. Waar er geen opname is, leest de stem van je toestel voor.
          </AppText>
          <View style={styles.row}>
            {recordedNarrators.map((narrator) => (
              <Button
                key={narrator}
                kind={settings.narrator === narrator ? "primary" : "secondary"}
                label={`Breinhap · ${narrator === "vrouw" ? "Vrouw" : "Man"}`}
                accessibilityHint="Kiest deze stem en laat ze horen"
                onPress={() => {
                  update({ narrator });
                  preview({ ...settings, narrator });
                }}
              />
            ))}
          </View>
        </>
      )}
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
                kind={!settings.narrator && current.voice === voice.identifier ? "primary" : "secondary"}
                label={labels.get(voice.identifier) ?? voice.name}
                accessibilityHint="Kiest deze stem en laat ze horen"
                onPress={() => {
                  update({ voiceId: voice.identifier, narrator: null });
                  preview({ voiceId: voice.identifier, narrator: null, tempo: settings.tempo });
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
              preview({ ...settings, tempo: tempo.value });
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
