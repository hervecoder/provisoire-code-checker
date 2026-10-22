# provisoire-code-checker

Checks Irembo's **provisoire** (provisional driving-licence computer test) service
for available exam slots per district and publishes the result.

- `check.mjs` — Playwright script that walks the Irembo citizen portal, reads the
  live district dropdown and slot rows, then writes `result.json` (+ step
  screenshots). It stores the full district text and the parsed `rows`; the worker
  treats `rows` as the source of truth.
- `.github/workflows/provisoire-check.yml` — runs every 2 hours, day **and**
  night, plus `workflow_dispatch`, and commits `result.json` + `shots/*.png`.
  A capture with zero slot rows keeps the previous good snapshot, prints
  `Ntago nabashije kubona amakuru, wongere ugerageze nyuma.`, and exits green.
- `cloudflare/worker.js` — the Cloudflare Worker (`provisoire-slots`) that serves
  the public page and JSON API over this repo. It uses `result.json` `rows` (with
  a text fallback for old snapshots) and returns a friendly retry note for
  districts with no capture.

## Live

- Page: <https://provisoire-slots.ndatimanah.workers.dev/>
- API: `/api/config`, `/api/result?t=mudasobwa|impapuro`, `/api/health`,
  `/api/shot?d=<district>&t=<type>`, `POST /api/dispatch`

## Run locally

```bash
npm i playwright@latest
npx playwright install chromium
IREMBO_ID=... node check.mjs   # writes result.json + step-*.png
```

The current code and data do not store the applicant ID. CI reads it from the
`IREMBO_ID` Actions secret; a manual dispatch may pass the `id_number` input
instead.

## Required secrets

- `IREMBO_ID` — the ID to check. There is no built-in fallback ID.
- The Worker uses a `GITHUB_TOKEN` secret binding to read this repo and to
  dispatch the workflow.

## Privacy

`result.json` is public. The script redacts the applicant ID, name and date of
birth from every saved text field. District screenshots are refused if the
ID/name is still visible, and the workflow uploads only scrubbed screenshots.
