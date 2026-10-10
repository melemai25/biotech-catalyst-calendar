# Catalyst Calendar

A static website showing a navigable calendar of clinical trial dates, FDA
decisions, and earnings catalysts across the biotech sector. Click any
highlighted date for details; past events show their outcome. A second tab
gives a searchable, filterable table of every event with composable filters
such as `phase:3 status:upcoming runway:<12`.

The ticker universe, trial data, SEC filings and financial metrics are all
collected by scripts. The only thing still maintained by hand is
`data/curated.json`, which holds PDUFA dates and plain-language trial outcomes
— neither exists in any free structured feed.

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

### Tracked tickers — generated, not hand-written

`data/tickers.json` is **generated output**. Do not hand-edit it.

```bash
npm run discover        # rebuild the ticker universe (monthly is plenty)
npm run discover:dry    # report only, write nothing
```

Discovery finds companies by **active Phase 2/3 trial count**, not market cap,
because market cap does not predict catalysts. It:

1. Pages ClinicalTrials.gov for every industry-sponsored interventional
   Phase 2/3 study that is recruiting or active, counting studies per sponsor
2. Matches each sponsor name to a ticker via SEC `company_tickers.json`
3. Verifies the match by SIC code (2833/2834/2835/2836/3826/3841/8731)
4. Scores `phase3 x 3 + phase2 x 1` and writes the ranked list

Because the sponsor string comes straight from the registry, `sponsorQuery` is
exact — no more silently-empty tickers from a guessed company name.

Anything it cannot resolve goes to `data/discovery-review.json` with a reason.
Most entries there are private companies with no ticker, which is expected.

**To force a ticker in or out**, edit `data/overrides.json`. It is applied last,
so it always wins. That is the only file you hand-maintain for the universe.

### Suggested cadence

| Command | How often | Why |
|---|---|---|
| `npm run discover` | monthly | The universe changes slowly |
| `npm run build` | daily | Trials and filings move |

## Run it

Three independent steps. Only the first touches the network.

| Command | Does | Takes | When |
|---|---|---|---|
| `node scripts/discover.js` | Rebuild the ticker universe | ~3 min | Monthly |
| `node scripts/build-data.js` | Fetch trials, filings, financials | ~6 min | Daily |
| `node scripts/build-pages.js` | Regenerate the static SEO pages | <1 s | After data, or after editing the page template |
| `node scripts/serve.js` | Serve what is already on disk | instant | Whenever |

**Serving never refetches.** Editing anything in `public/` needs only a browser
refresh — no rebuild, no waiting. Use `--build` if you explicitly want fresh
data in the same command.

```bash
node scripts/serve.js            # instant, offline
node scripts/serve.js --build    # refetch everything first
node scripts/serve.js --port 8080
node scripts/serve.js --help
```

On Windows run these with `node`, not `npm`, unless you have set
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

> Do not open `public/index.html` by double-clicking. Browsers block `fetch`
> on `file://` URLs, so the page cannot load its data.

## Pages and SEO

The app at `/` is a single URL by design. A watchlist is a private combination
of tickers and nobody searches for one, so indexing every combination would
create an unbounded set of duplicate pages.

Instead `build-pages.js` generates the pages people actually search for:

| URL | Content | Indexed |
|---|---|---|
| `/` | The app | Yes |
| `/?tickers=LLY,MRNA` | The same app, shareable | No — canonical to `/` |
| `/ticker/MRNA/` | One company: catalysts, runway, history | Yes |
| `/calendar/2026-11/` | Every company that month | Yes |

Each generated page is real HTML with its content already in it, so crawlers
see the events without running JavaScript, and each carries schema.org `Event`
markup. Pages with fewer than two events are skipped rather than published as
thin content.

Pass your live URL so canonical tags and the sitemap are correct:

```bash
node scripts/build-pages.js --base https://you.github.io/your-repo
```

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
