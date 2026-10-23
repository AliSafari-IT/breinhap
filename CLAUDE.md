# CLAUDE.md

Guidance for Claude Code in this repository.

## What this is

Breinhap: an Android study companion for Flemish students in 3de middelbaar, designed to work well for students with ADHD and AuDHD. Android first; the web side is only the landing page at `breinhap.asafarim.site`.

## Where the docs live

This repo carries **no docs**. The plan (product, ADHD/AuDHD design, safe AI with minors, privacy, Google Play requirements, MVP, architecture) lives in the private repo `AliSafari-IT/asafarim-docs` under `ventures/breinhap/` (start at `product-plan-phase-01.md`). A code change that changes documented behaviour gets a matching docs PR there. Deploy details stay out of this repo: the landing page is served by `asafarim-os`.

## Layout

```
apps/mobile/       Expo (React Native, SDK 58) Android app, Expo Router in src/app/
apps/site/         Landing page: static HTML built by src/build.mjs (Node built-ins only), served by nginx
packages/content/  @breinhap/content: learning-object schema (Zod), the mission picker, sample content
```

## Commands

```bash
pnpm install
pnpm typecheck            # all packages
pnpm test                 # content tests (Vitest) + site tests (node:test)
pnpm mobile               # Expo dev server (Expo Go or a dev build)
pnpm site                 # build the site and serve it on http://localhost:4300
pnpm --filter @breinhap/mobile exec expo install <pkg>   # add native deps with SDK-compatible versions
```

## Rules that matter

- **Content is data.** The app renders `LearningObject`s and knows nothing about subjects. Change the schema in `packages/content` and bump `SCHEMA_VERSION` on breaking changes.
- **AI never grades or decides.** Picking, scoring and review scheduling are deterministic (`pickMission`), to stay out of the EU AI Act's high-risk category. AI may draft content; only `review.status: "reviewed"` content reaches students (drafts show in dev builds only).
- **Never collect a diagnosis** or other health data; no ads, no third-party analytics or tracking SDKs. Settings stay on the device.
- **Predictability is a feature.** Every mission is Opwarmen → Leren → Doen → Check. No streaks, lives or time pressure; feedback says "Klopt." / "Nog niet." with the explanation.
- **Style:** the ASafariM OS look (charcoal header, cool light-blue light theme with navy actions, charcoal dark theme with light-blue accents, theme toggle). No beige. Colours live in `apps/mobile/src/theme/tokens.ts` and `apps/site/src/theme.css` (a copy of asafarim-os `packages/theme/theme.css`).
- **Site CSP** is `script-src 'self'; style-src 'self'`: no inline scripts, `<style>` or `style=""` (the site tests check). Respect `prefers-reduced-motion`; anything that moves on its own can be paused.
- Android package id is `com.asafarim.breinhap`. It is permanent once published on Google Play.
