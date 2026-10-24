import type { LearningObject, Subject } from "./schema";

/**
 * Where a student studies: school, year and studierichting, which give their
 * list of vakken. Everything here ships inside the app and the choice stays on
 * the device; nothing about the student leaves the phone.
 *
 * The schools come from the Flemish government's open data on the
 * onderwijsaanbod, reduced to what the picker needs. Vakken per richting
 * follow the school's lessentabel. Add a school by adding it to SCHOOLS; add a
 * richting once and let schools list its id.
 */

/** Years of secondary school (1 = 1ste middelbaar). */
export const YEARS = [1, 2, 3, 4, 5, 6] as const;
export type Year = (typeof YEARS)[number];

export interface CatalogCourse {
  id: string;
  label: string;
  /** The content subject this vak draws from; without one it shows as "binnenkort". */
  subject?: Subject;
}

export interface Studierichting {
  id: string;
  label: string;
  years: readonly Year[];
  courses: readonly CatalogCourse[];
}

export interface School {
  id: string;
  name: string;
  city: string;
  postcode: string;
  /** Ids from STUDIERICHTINGEN this school offers. */
  richtingen: readonly string[];
}

export const STUDIERICHTINGEN: readonly Studierichting[] = [
  {
    id: "economie-wiskunde",
    label: "Economie-wiskunde",
    years: [5, 6],
    courses: [
      { id: "wiskunde", label: "Wiskunde", subject: "wiskunde" },
      { id: "economie", label: "Economie", subject: "economie" },
      { id: "nederlands", label: "Nederlands", subject: "nederlands" },
      { id: "frans", label: "Frans", subject: "frans" },
      { id: "engels", label: "Engels", subject: "engels" },
      { id: "duits", label: "Duits" },
      { id: "geschiedenis", label: "Geschiedenis", subject: "geschiedenis" },
      { id: "aardrijkskunde", label: "Aardrijkskunde", subject: "aardrijkskunde" },
      { id: "natuurwetenschappen", label: "Natuurwetenschappen" },
      { id: "godsdienst", label: "Godsdienst" },
      { id: "lichamelijke-opvoeding", label: "Lichamelijke opvoeding" },
    ],
  },
];

export const SCHOOLS: readonly School[] = [
  {
    id: "sint-martinusscholen-herk-de-stad",
    name: "Sint-Martinusscholen",
    city: "Herk-de-Stad",
    postcode: "3540",
    richtingen: ["economie-wiskunde"],
  },
];

export const subjectLabel: Record<Subject, string> = {
  wiskunde: "Wiskunde",
  biologie: "Biologie",
  chemie: "Chemie",
  fysica: "Fysica",
  nederlands: "Nederlands",
  engels: "Engels",
  frans: "Frans",
  aardrijkskunde: "Aardrijkskunde",
  geschiedenis: "Geschiedenis",
  economie: "Economie",
  "digitale-vaardigheden": "Digitale vaardigheden",
};

/** What the student picked once. A null school or richting means "staat er niet bij". */
export interface StudyProfile {
  schoolId: string | null;
  year: Year;
  richtingId: string | null;
}

export interface City {
  name: string;
  postcode: string;
}

/** Every city that has a school in the catalogue, alphabetically. */
export function cities(schools: readonly School[] = SCHOOLS): City[] {
  const byName = new Map<string, City>();
  for (const school of schools) byName.set(school.city, { name: school.city, postcode: school.postcode });
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, "nl"));
}

export function schoolsIn(city: string, schools: readonly School[] = SCHOOLS): School[] {
  return schools.filter((school) => school.city === city).sort((a, b) => a.name.localeCompare(b.name, "nl"));
}

export function findSchool(id: string | null, schools: readonly School[] = SCHOOLS): School | undefined {
  return id === null ? undefined : schools.find((school) => school.id === id);
}

export function findRichting(id: string | null): Studierichting | undefined {
  return id === null ? undefined : STUDIERICHTINGEN.find((richting) => richting.id === id);
}

/**
 * The richtingen to offer for a year: the school's own, or every known
 * richting when the student's school is not in the catalogue.
 */
export function richtingenFor(schoolId: string | null, year: Year): Studierichting[] {
  const school = findSchool(schoolId);
  return STUDIERICHTINGEN.filter(
    (richting) => richting.years.includes(year) && (!school || school.richtingen.includes(richting.id)),
  );
}

export interface ProfileCourse {
  course: CatalogCourse;
  /** Content for this vak in the student's year; empty means "binnenkort". */
  objects: LearningObject[];
}

/**
 * The student's vakken with the content each one has. With a known richting
 * this is its lessentabel in order; without one, every subject that has
 * content for the student's year.
 */
export function coursesFor(profile: StudyProfile, objects: readonly LearningObject[]): ProfileCourse[] {
  const forYear = objects.filter((object) => object.grade === profile.year);
  const richting = findRichting(profile.richtingId);
  if (richting?.years.includes(profile.year)) {
    return richting.courses.map((course) => ({
      course,
      objects: course.subject ? forYear.filter((object) => object.subject === course.subject) : [],
    }));
  }
  const subjects = [...new Set(forYear.map((object) => object.subject))];
  return subjects.map((subject) => ({
    course: { id: subject, label: subjectLabel[subject], subject },
    objects: forYear.filter((object) => object.subject === subject),
  }));
}

/** Read a stored profile, refusing anything that no longer fits the catalogue. */
export function parseProfile(value: unknown): StudyProfile | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { schoolId, year, richtingId } = value as Record<string, unknown>;
  if (!YEARS.includes(year as Year)) return undefined;
  if (schoolId !== null && (typeof schoolId !== "string" || !findSchool(schoolId))) return undefined;
  if (richtingId !== null && (typeof richtingId !== "string" || !findRichting(richtingId))) return undefined;
  return { schoolId, year: year as Year, richtingId };
}
