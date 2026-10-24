import { router } from "expo-router";
import { SchoolPicker } from "../components/SchoolPicker";
import { Screen } from "../components/ui";
import { useProfile } from "../settings/ProfileContext";

/** Change the school, year or richting picked on the first run. */
export default function SchoolScreen() {
  const { profile, save } = useProfile();
  return (
    <Screen>
      <SchoolPicker
        {...(profile ? { initial: profile } : {})}
        onDone={(next) => {
          save(next);
          router.back();
        }}
      />
    </Screen>
  );
}
