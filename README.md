# Catalyst Calendar — MRNA · ILMN

A static website showing a navigable calendar of clinical trial dates, FDA decisions, and earnings catalysts for Moderna (MRNA) and Illumina (ILMN). Click any highlighted date to see details; past events show their outcome.

## How the data works

Three sources, merged at build time:

| Source | Provides | Key needed |
|---|---|---|
| **ClinicalTrials.gov v2** | Registered trials: phase, status, enrollment, primary completion dates | None |
| **SEC EDGAR** | 8-K filings: earnings dates, corporate events, material disclosures — plus a *projected* next earnings date from filing cadence | None, but a contact string is required (below) |
| **`data/curated.json`** | PDUFA dates and plain-language outcomes, which neither API publishes | Hand-edited by you |

All fetching happens **server-side in the build step**, so there is no CORS
involvement and nothing is exposed to the browser. If a source is unreachable
the build logs it and continues with the others.

### Required: your SEC contact string

The SEC rejects automated requests that do not identify themselves. Without
this, EDGAR returns 403 and ingestion is skipped (trials still work).

```bash
# Windows
setx EDGAR_USER_AGENT "Your Name you@example.com"
# macOS / Linux
export EDGAR_USER_AGENT="Your Name you@example.com"
```

Or edit `data/config.json`. The placeholder value is deliberately rejected —
put in a real email, since the SEC uses it to contact you rather than block you.

The build stays under the SEC's 10 requests/second limit (it targets 8).
Exceeding that gets your IP blocked for about ten minutes.

### What EDGAR can and cannot give you

8-Ks are filed **after** an event, so EDGAR is a history, not a schedule. The
one forward-looking item is the projected next earnings date, derived from the
median gap between recent item 2.02 filings. It is badged `est.` and is not a
company-confirmed date.

PDUFA dates and trial outcomes still have to be curated by hand, or extracted
from filing text with an LLM. No free API publishes them.

### Tracked tickers

`data/tickers.json` holds ~118 companies across nine tiers. `sponsorQuery` is
matched against the **lead sponsor** name on ClinicalTrials.gov — if it is
wrong, that ticker silently returns nothing, so run:

```bash
npm run validate
```

which fetches without writing and lists every ticker that came back empty.

## Run it

From the project folder:

```bash
npm start
```

That is it. Works the same in PowerShell, Command Prompt, VS Code's terminal,
macOS Terminal, and Linux. It rebuilds the data, picks a free port if 8000 is
taken, serves the site, and opens your browser.

**Windows users:** you can also just double-click **START-HERE.bat**.

Options:

```bash
npm start -- --port 8080   # specific port
npm start -- --no-build    # skip the data fetch
npm start -- --no-open     # don't open a browser
```

Requires Node 18+ and nothing else — no Python, no npm install, no dependencies.
Check yours with `node --version`; get it from https://nodejs.org if missing.

> Don't open `public/index.html` directly by double-clicking it. Browsers block
> `fetch` on `file://` URLs, so the page will not load its data. Use `npm start`.

### If you get no output at all

You are probably running `./run.sh` in PowerShell, which cannot execute shell
scripts. Use `npm start` instead — it works in every shell. The `.sh` scripts
are there for macOS, Linux, Git Bash and WSL only.

## Put it live

```bash
npm run deploy
```

Creates a GitHub repo, pushes, turns on GitHub Pages, and prints your live URL.
Run it again any time to push changes.

Needs `git` and the GitHub CLI (`gh`). If `gh` is missing the script prints the
install command for your OS plus the manual steps.

```bash
npm run deploy -- --name my-calendar   # choose the repo name
npm run deploy -- --private            # private repo (Pages needs a paid plan)
```

Once live, the site refreshes its own trial data daily at 11:00 UTC via the
included GitHub Action. Force a refresh with `gh workflow run "Refresh catalyst data"`.

### Other hosts

#### Netlify / Vercel / Cloudflare Pages

- Build command: `npm run build`
- Publish directory: `public`

For scheduled refreshes on these hosts, use their cron feature (Netlify Scheduled Functions, Vercel Cron) or just keep the GitHub Action running.

### Any static host

Run `npm run build`, then upload the contents of `public/` anywhere — S3, nginx, a shared drive. It's four files plus a JSON.

## Adding or fixing events

Edit `data/curated.json` and re-run `npm run build`. Each event looks like:

```json
{
  "id": "unique-slug",
  "ticker": "MRNA",
  "date": "2026-10-29",
  "title": "Q3 2026 Earnings",
  "type": "Earnings",
  "phase": "Phase 3",
  "estimated": true,
  "summary": "One or two sentences of context.",
  "result": "Outcome, or null if it hasn't happened yet.",
  "source": "Where this came from",
  "sourceUrl": "https://..."
}
```

- `type` — `Trial Readout`, `Regulatory`, `Earnings`, `Conference`, or `Corporate`
- `estimated: true` renders a dashed **est.** badge for dates that aren't officially confirmed
- `status` (past/upcoming) is computed at build time from the date — don't set it yourself
- Curated entries override registry entries if IDs collide

## Adding another ticker

Add an entry under `tickers` in `data/curated.json`:

```json
"PFE": {
  "name": "Pfizer Inc.",
  "sponsorQuery": "Pfizer",
  "note": "Short description shown in the sidebar."
}
```

Then add a color for it in `public/styles.css` (copy the `--mrna` / `--ilmn` pattern, plus the matching `.tick.PFE` and `.badge.PFE` rules) and in the `COLORS` map at the top of `public/app.js`.

## Known limits

- **Registry dates move.** ClinicalTrials.gov primary completion dates are sponsor-estimated and get revised often. They're a rough guide to timing, not a schedule. Estimated ones are badged.
- **Month-only dates** in the registry (`2026-11`) are anchored to the 15th so they have somewhere to sit on the grid.
- **Illumina is not a drug developer.** It's a genomics tools and diagnostics company, so it has few registered interventional trials. Most of its catalysts are curated regulatory, reimbursement, and earnings events.
- **`query.spons` matches collaborators too**, so the build filters to studies where the *lead* sponsor name matches. Without that, Illumina would pull in every trial that merely uses its sequencers.
- Curated entries are a point-in-time snapshot. Verify anything you'd trade on against the primary source — every event links out to one.

This is an information tool, not investment advice.
