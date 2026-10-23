// Renders the static site into dist/ with Node built-ins only (no install needed, also in the Docker build).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { languages } from "./content.mjs";
import { cookies, deletion, privacy, terms } from "./legal.mjs";
import { SITE_URL, home, legal, notFound, routes } from "./render.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
cpSync(join(root, "public"), dist, { recursive: true });
// One stylesheet: the shared OS theme, then Breinhap's own styles.
writeFileSync(
  join(dist, "styles.css"),
  readFileSync(join(root, "src/theme.css"), "utf8") + "\n" + readFileSync(join(root, "src/site.css"), "utf8"),
);

function write(urlPath, html) {
  const file = join(dist, urlPath.endsWith("/") ? `${urlPath}index.html` : urlPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}

for (const lang of ["nl", "en"]) {
  const t = languages[lang];
  write(routes.home[lang], home(t, lang));
  write(routes.privacy[lang], legal(t, lang, "privacy", privacy[lang]));
  write(routes.deletion[lang], legal(t, lang, "deletion", deletion[lang]));
  write(routes.cookies[lang], legal(t, lang, "cookies", cookies[lang]));
  write(routes.terms[lang], legal(t, lang, "terms", terms[lang]));
}
write("/404.html", notFound(languages.nl));

const urls = Object.values(routes).flatMap((byLang) => Object.values(byLang));
write(
  "/sitemap.xml",
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${SITE_URL}${u}</loc></url>`)
    .join("\n")}\n</urlset>\n`,
);

console.log(`Built ${dist}`);
