import { parseProfile, type StudyProfile } from "@breinhap/content";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

const STORAGE_KEY = "breinhap.profile.v1";

interface ProfileValue {
  /** False until the stored choice has been read, so home does not flash the picker. */
  loaded: boolean;
  /** School, year and richting the student picked; undefined before the first run. */
  profile: StudyProfile | undefined;
  save: (profile: StudyProfile) => void;
}

const ProfileContext = createContext<ProfileValue | null>(null);

/** The student's school choice. It stays on this device and is never sent anywhere. */
export function ProfileProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [profile, setProfile] = useState<StudyProfile | undefined>(undefined);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (raw) setProfile(parseProfile(JSON.parse(raw)));
      })
      .catch(() => {
        // An unreadable choice just means picking the school again.
      })
      .finally(() => setLoaded(true));
  }, []);

  const value = useMemo<ProfileValue>(
    () => ({
      loaded,
      profile,
      save: (next) => {
        setProfile(next);
        AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
      },
    }),
    [loaded, profile],
  );

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfile(): ProfileValue {
  const value = useContext(ProfileContext);
  if (!value) throw new Error("useProfile must be used inside ProfileProvider");
  return value;
}
