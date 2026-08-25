# zetamac_google_sheet

Firefox extension and Google Apps Script template for syncing Zetamac scores into a Google Sheet.

This repository is a derivative of Arithmetic Tracker for Zetamac by Nathan Negera, extended to support remote sync through Google Apps Script. The upstream add-on is published on AMO under the MIT License.

## What It Does

- Tracks Zetamac scores locally in Firefox.
- Captures Zetamac's own `/log` request when available, including per-problem timing/error metrics.
- Shows recent stats and a local score chart.
- Exports and imports scores as CSV.
- Uploads scores to a Google Sheet through an append-only Apps Script web app.
- Lets you use the same sheet from multiple computers by giving each machine its own device name.

## Security Model

- The repository does not contain a webhook URL or real shared secret.
- The Apps Script template contains placeholders for `SPREADSHEET_ID` and `SHARED_SECRET`; replace them before deployment and keep the secret private.
- The Firefox extension stores its webhook URL, secret, and device name in Firefox Sync storage. Score history and the upload queue remain local to each Firefox profile.
- If you edit local copies of this repo with real values, do not commit them.

## Repository Layout

- `extension/`: Firefox add-on source.
- `apps-script/Code.gs`: Google Apps Script webhook template.
- `scripts/package.sh`: Builds an unsigned `.xpi` package locally.

## Deploy The Google Apps Script

1. Open the target spreadsheet in Google Sheets.
2. Open `Extensions -> Apps Script`.
3. Replace the default script with the contents of `apps-script/Code.gs`.
4. In `apps-script/Code.gs`, replace `SPREADSHEET_ID` with the ID from the sheet URL and replace `SHARED_SECRET` with a long random secret.
5. Deploy the script as a web app:
   - `Execute as`: `Me`
   - `Who has access`: `Anyone`
6. Copy the generated `/exec` URL.
7. Test the `/exec` URL in a private window.
   It should return JSON from `doGet()`, not a login page.

The bundled Apps Script preserves existing rows, appends richer metric columns after `avg_50` and `time`, and skips backfill duplicates by `id` or by the `timestamp_ms + score` pair.

## Load The Firefox Extension

1. Open Firefox.
2. Go to `about:debugging#/runtime/this-firefox`.
3. Click `Load Temporary Add-on`.
4. Select `extension/manifest.json`.
5. Open the extension Options page.
6. Fill in:
   - the Apps Script `/exec` URL
   - the same shared secret
   - a unique device name such as `desktop`, `laptop`, or `office-arch`
7. Click `Save Remote Settings`.
8. Click `Upload All Local Scores` once to backfill any existing local history.

Repeat the same extension setup on each computer. Use the same webhook URL and secret everywhere, but a different device name on each machine.

## Migrating From The Original AMO Add-On

This repository now uses the same Firefox extension ID as the upstream add-on, `zetamac-tracker@nathan.dev`, so a temporary load keeps the existing local score storage instead of starting from an empty profile.

To backfill old scores, load this extension with `about:debugging`, open Options, and click `Upload All Local Scores`. Export/import is only needed if you intentionally change extension IDs or profiles.

## Development

Build an unsigned `.xpi` locally:

```bash
./scripts/package.sh
```

The output goes into `dist/`.

## Limitations

- On normal Firefox release builds, an unsigned add-on loaded this way is temporary and must be reloaded after browser restart.
- Google Apps Script web apps can behave differently across browsers if CORS or anonymous access is misconfigured. This repo uses a simple `text/plain` POST to avoid Firefox preflight issues.
- Large backfills may take multiple batches.

## Attribution

- Upstream add-on: https://addons.mozilla.org/en-US/firefox/addon/arithmetic-tracker-for-zetamac/
- Upstream author: Nathan Negera
- License: MIT
