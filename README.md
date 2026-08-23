# HSG Varel - Handball-Crawler

Holt Spielplan + Tabelle der 1. Herren (3. Liga) von handball.net und legt
`handball-data.json` per FTPS in `wp-content/uploads/hsg-1herren/assets/` ab.
Die Vereinsseite (1. Herren) liest diese Datei und rendert Spielbetrieb im HSG-Design.

- `crawl.mjs` - Playwright-Scraper (headless Chromium)
- `upload.mjs` - FTPS-Upload
- `.github/workflows/crawl.yml` - laeuft alle 15 Minuten (+ manuell)

Secrets (Repo -> Settings -> Secrets -> Actions): `FTP_HOST`, `FTP_USER`, `FTP_PASS`.
