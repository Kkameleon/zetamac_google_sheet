# zetamac_google_sheet

Firefox extension and Google Apps Script template for syncing Zetamac scores into a Google Sheet.

This repository is a derivative of Arithmetic Tracker for Zetamac by Nathan Negera, extended to support remote sync through Google Apps Script. The upstream add-on is published on AMO under the MIT License.

## What It Does

- Tracks Zetamac scores locally in Firefox.
- Shows recent stats and a local score chart.
- Exports and imports scores as CSV.
- Uploads scores to a Google Sheet through an Apps Script web app.
- Lets you use the same sheet from multiple computers by giving each machine its own device name.

## Security Model

- The repository does not contain a webhook URL, spreadsheet ID, or shared secret.
- The Apps Script template reads `SPREADSHEET_ID`, `SHEET_GID`, and `SHARED_SECRET` from Apps Script project properties.
- The Firefox extension stores its webhook URL, secret, and device name in extension local storage on each machine.
- If you edit local copies of this repo with real values, do not commit them.

## Repository Layout

- `extension/`: Firefox add-on source.
- `apps-script/Code.gs`: Google Apps Script webhook template.
- `scripts/package.sh`: Builds an unsigned `.xpi` package locally.

## Deploy The Google Apps Script

1. Open the target spreadsheet in Google Sheets.
2. Open `Extensions -> Apps Script`.
3. Replace the default script with the contents of `apps-script/Code.gs`.
4. In Apps Script, open `Project Settings`.
5. Under `Script properties`, add:
   - `SPREADSHEET_ID`: the spreadsheet ID from the sheet URL
   - `SHEET_GID`: the target sheet tab ID, usually `0` for the first tab
   - `SHARED_SECRET`: a long random secret
6. Deploy the script as a web app:
   - `Execute as`: `Me`
   - `Who has access`: `Anyone`
7. Copy the generated `/exec` URL.
8. Test the `/exec` URL in a private window.
   It should return JSON from `doGet()`, not a login page.

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

Because this repository uses a different Firefox extension ID, it does not automatically inherit local storage from the upstream add-on.

To migrate old scores:

1. Open the upstream add-on popup.
2. Export CSV.
3. Load this extension.
4. Open Options and import the CSV.
5. Click `Upload All Local Scores`.

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
