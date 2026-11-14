/** The legal pages on the website (Dutch; each links its English version). Google Play also lists the privacy policy. */
export const SITE = "https://breinhap.asafarim.site";

export const LEGAL: Array<{ label: string; url: string }> = [
  { label: "Privacybeleid", url: `${SITE}/privacy/` },
  { label: "Gebruiksvoorwaarden", url: `${SITE}/voorwaarden/` },
  { label: "Cookies", url: `${SITE}/cookies/` },
  { label: "Je gegevens verwijderen", url: `${SITE}/account-verwijderen/` },
];

export const CONTACT_EMAIL = "privacy@asafarim.site";

/**
 * The public mission catalogue on breinhap.com (breinhap#35), as JSON. A build can point
 * elsewhere (for a test server) with EXPO_PUBLIC_CATALOGUE_URL; it must be https.
 */
const configured = process.env.EXPO_PUBLIC_CATALOGUE_URL;
export const CATALOGUE_URL =
  configured && configured.startsWith("https://") ? configured : "https://breinhap.com/p/missies.json";
