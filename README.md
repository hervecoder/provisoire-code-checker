# provisoire-code-checker

Checks Irembo's **provisoire** (provisional driving-licence computer test) service
for available exam slots per district and publishes the result.

- `check.mjs` — Playwright script that walks the Irembo citizen portal, selects
  each district, reads the slots and writes `result.json` (+ step screenshots).
- `.github/workflows/provisoire-check.yml` — runs `check.mjs` daily and on
  `workflow_dispatch`, commits `result.json` and `shots/*.png`.
- `cloudflare/worker.js` — the Cloudflare Worker (`provisoire-slots`) that serves
  the public page and JSON API over this repo.

## Live

- Page: <https://provisoire-slots.ndatimanah.workers.dev/>
- API: `/api/result`, `/api/health`, `/api/shot?d=<district>`, `POST /api/dispatch`

## Run locally

```bash
npm i playwright@latest
npx playwright install chromium
node check.mjs        # writes result.json + step-*.png
```

Override the ID being checked with the `IREMBO_ID` secret or the
`id_number` dispatch input (defaults to the owner's number).

## Required secrets

- `IREMBO_ID` — optional; the ID to check (falls back to the built-in default).
- The Worker uses a `GITHUB_TOKEN` secret binding to read this repo and to
  dispatch the workflow.
