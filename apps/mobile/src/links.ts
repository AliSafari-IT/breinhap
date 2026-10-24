/** The legal pages on the website (Dutch; each links its English version). Google Play also lists the privacy policy. */
export const SITE = "https://breinhap.asafarim.site";

export const LEGAL: Array<{ label: string; url: string }> = [
  { label: "Privacybeleid", url: `${SITE}/privacy/` },
  { label: "Gebruiksvoorwaarden", url: `${SITE}/voorwaarden/` },
  { label: "Cookies", url: `${SITE}/cookies/` },
  { label: "Je gegevens verwijderen", url: `${SITE}/account-verwijderen/` },
];

export const CONTACT_EMAIL = "privacy@asafarim.site";
