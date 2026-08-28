# HSG Varel - Handball-Crawler

Holt Spielplan + Tabelle der 1. Herren (3. Liga) von handball.net und legt
`handball-data.json` per FTPS in `wp-content/uploads/hsg-1herren/assets/` ab.
Die Vereinsseite (1. Herren) liest diese Datei und rendert Spielbetrieb im HSG-Design.

- `crawl.mjs` - Playwright-Scraper (headless Chromium)
- `upload.mjs` - FTPS-Upload
- `.github/workflows/crawl.yml` - nur noch manuell ("Run workflow"), siehe unten

## Wo der Crawler laeuft (seit 28.08.2026)

Nicht mehr per GitHub-Actions-Schedule. GitHub hat den Cron `*/15 * * * *` nur
noch 2-3x pro Tag ausgeloest - Schedule-Events sind bei Actions "best effort"
und werden unter Last verworfen. Produktiv laeuft der Crawler jetzt alle 15
Minuten auf dem Metabase-Server:

| | |
|---|---|
| Server | 91.98.166.254 (`metabaseserver`, Hetzner) |
| Code | `/opt/hsg-handball-crawl` (Klon dieses Repos, taeglicher `git pull` 03:40) |
| Runtime | `/opt/hsg-handball-crawl-runtime` (Dockerfile, `run.sh`, `crawl.env`) |
| Image | `hsg-crawl:1.48.2` (Basis `mcr.microsoft.com/playwright:v1.48.2-jammy`) |
| Zeitplan | `/etc/cron.d/hsg-handball-crawl`, `*/15` mit `flock` |
| Log | `/var/log/hsg-handball-crawl/crawl.log` (rotiert bei 5 MB) |

Ein Lauf dauert rund 2,5 Minuten. Aenderungen an `crawl.mjs`/`upload.mjs`
hierher pushen - der Server zieht sie nachts nach, sofort von Hand mit
`ssh root@91.98.166.254 "cd /opt/hsg-handball-crawl && git pull"`.

Secrets fuer den manuellen Workflow (Repo -> Settings -> Secrets -> Actions):
`FTP_HOST`, `FTP_USER`, `FTP_PASS`. Auf dem Server stehen dieselben Werte in
`/opt/hsg-handball-crawl-runtime/crawl.env` (Rechte 0600, nicht im Repo).
