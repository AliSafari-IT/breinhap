import {
  YEARS,
  cities,
  findRichting,
  findSchool,
  richtingenFor,
  schoolsIn,
  type StudyProfile,
  type Year,
} from "@breinhap/content";
import { useState } from "react";
import { TextInput, View } from "react-native";
import { useSettings } from "../settings/SettingsContext";
import { fontSize, radius, spacing } from "../theme/tokens";
import { AppText, Button, Card } from "./ui";

type Step = "city" | "school" | "year" | "richting";
const STEPS: readonly Step[] = ["city", "school", "year", "richting"];

/** Above this many options a search field appears; short lists stay plain. */
const SEARCH_FROM = 8;

export function yearLabel(year: Year): string {
  return `${year}${year === 1 ? "ste" : "de"} jaar`;
}

/** One line that tells the student what they picked, e.g. on home and in Instellingen. */
export function profileLabel(profile: StudyProfile): string {
  const school = findSchool(profile.schoolId);
  const richting = findRichting(profile.richtingId);
  return [school && `${school.name}, ${school.city}`, yearLabel(profile.year), richting?.label]
    .filter(Boolean)
    .join(" · ");
}

/**
 * First run: gemeente → school → jaar → richting, one question per screen.
 * Every step has a way out ("staat er niet bij"), so nobody gets stuck.
 */
export function SchoolPicker({ initial, onDone }: { initial?: StudyProfile; onDone: (profile: StudyProfile) => void }) {
  const [step, setStep] = useState<Step>("city");
  const [city, setCity] = useState<string | null>(findSchool(initial?.schoolId ?? null)?.city ?? null);
  const [schoolId, setSchoolId] = useState<string | null>(initial?.schoolId ?? null);
  const [year, setYear] = useState<Year | null>(initial?.year ?? null);

  const back = () => {
    if (step === "school") setStep("city");
    if (step === "year") setStep(city === null ? "city" : "school");
    if (step === "richting") setStep("year");
  };

  return (
    <View style={{ gap: spacing.md }}>
      <AppText variant="small" muted>{`Stap ${STEPS.indexOf(step) + 1} van 4`}</AppText>

      {step === "city" && (
        <Choices
          question="In welke gemeente is je school?"
          options={cities().map((c) => ({ id: c.name, label: c.name, hint: c.postcode }))}
          selected={city}
          notListed="Mijn gemeente staat er niet bij"
          onPick={(id) => {
            setCity(id);
            if (id === null) {
              setSchoolId(null);
              setStep("year");
            } else {
              if (findSchool(schoolId)?.city !== id) setSchoolId(null);
              setStep("school");
            }
          }}
        />
      )}

      {step === "school" && city !== null && (
        <Choices
          question="Welke school?"
          options={schoolsIn(city).map((s) => ({ id: s.id, label: s.name }))}
          selected={schoolId}
          notListed="Mijn school staat er niet bij"
          onPick={(id) => {
            setSchoolId(id);
            setStep("year");
          }}
        />
      )}

      {step === "year" && (
        <Choices
          question="In welk jaar zit je?"
          options={YEARS.map((y) => ({ id: String(y), label: yearLabel(y) }))}
          selected={year === null ? null : String(year)}
          onPick={(id) => {
            setYear(Number(id) as Year);
            setStep("richting");
          }}
        />
      )}

      {step === "richting" && year !== null && (
        <Choices
          question="Welke richting volg je?"
          options={richtingenFor(schoolId, year).map((r) => ({ id: r.id, label: r.label }))}
          selected={initial?.year === year ? (initial.richtingId ?? null) : null}
          notListed="Mijn richting staat er niet bij"
          empty="Voor dit jaar kennen we de richtingen nog niet. Je ziet dan alle vakken die er al zijn."
          onPick={(richtingId) => onDone({ schoolId, year, richtingId })}
        />
      )}

      {step !== "city" && <Button kind="secondary" label="Terug" onPress={back} />}
    </View>
  );
}

interface Option {
  id: string;
  label: string;
  hint?: string;
}

function Choices({
  question,
  options,
  selected,
  notListed,
  empty,
  onPick,
}: {
  question: string;
  options: Option[];
  selected: string | null;
  /** Label for the way out; picking it passes null. */
  notListed?: string;
  /** Shown instead of the options when there are none. */
  empty?: string;
  onPick: (id: string | null) => void;
}) {
  const { palette, textScale } = useSettings();
  const [search, setSearch] = useState("");
  const needle = search.trim().toLocaleLowerCase("nl");
  const shown = needle
    ? options.filter((o) => `${o.label} ${o.hint ?? ""}`.toLocaleLowerCase("nl").includes(needle))
    : options;

  return (
    <>
      <AppText variant="big">{question}</AppText>
      {options.length > SEARCH_FROM && (
        <TextInput
          accessibilityLabel="Zoeken"
          placeholder="Zoeken"
          placeholderTextColor={palette.muted}
          value={search}
          onChangeText={setSearch}
          style={{
            minHeight: 52,
            borderWidth: 1,
            borderRadius: radius.md,
            borderColor: palette.border,
            backgroundColor: palette.surface,
            color: palette.text,
            fontSize: fontSize.body * textScale,
            paddingHorizontal: spacing.md,
          }}
        />
      )}
      {options.length === 0 && empty && (
        <Card>
          <AppText>{empty}</AppText>
        </Card>
      )}
      {shown.map((option) => (
        <Button
          key={option.id}
          kind={option.id === selected ? "primary" : "secondary"}
          label={option.hint ? `${option.label} (${option.hint})` : option.label}
          onPress={() => onPick(option.id)}
        />
      ))}
      {notListed && (
        <Button
          kind="secondary"
          label={options.length === 0 ? "Verder" : notListed}
          onPress={() => onPick(null)}
        />
      )}
    </>
  );
}
