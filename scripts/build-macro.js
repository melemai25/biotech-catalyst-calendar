#!/usr/bin/env node
/**
 * build-macro.js — collects US economic data and writes public/data/macro.json
 *
 * Completely independent of build-data.js. The biotech calendar and the macro
 * page share nothing but the output directory, so either can be rebuilt on its
 * own cadence and a failure in one never blocks the other.
 *
 *   node scripts/build-macro.js
 *   node scripts/build-macro.js --dry-run     fetch and report, write nothing
 *   node scripts/build-macro.js --offline     rebuild from the last payload
 *
 * Needs a free FRED API key (one minute, no payment details):
 *   https://fredaccount.stlouisfed.org/apikeys
 *   setx FRED_API_KEY "your32charkey"          (Windows)
 *   export FRED_API_KEY="your32charkey"        (macOS/Linux)
 * or data/config.json -> { "fredApiKey": "..." }
 *
 * Without a key the script writes an `available: false` payload and exits 0.
 * The macro tab then explains what is missing instead of rendering an error,
 * and the rest of the site is untouched.
 */

const fs = require('fs');
const path = require('path');

const fred = require('./fred');
const macro = require('./macro');
const { INDICATORS, RELEASES, FIXED_EVENTS, GROUPS } = require('./macro-spec');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'data', 'macro.json');
const OVERRIDES = path.join(ROOT, 'data', 'macro-overrides.json');

/** How far ahead the calendar reaches, and how much history to pull. */
const CALENDAR_DAYS_AHEAD = 180;
const CALENDAR_DAYS_BACK = 21;
const HISTORY_YEARS = 6;

const TTY = process.stdout.isTTY;
const c = {
  cyan:  (s) => (TTY ? `\x1b[1;36m${s}\x1b[0m` : s),
  green: (s) => (TTY ? `\x1b[1;32m${s}\x1b[0m` : s),
  amber: (s) => (TTY ? `\x1b[1;33m${s}\x1b[0m` : s),
  red:   (s) => (TTY ? `\x1b[1;31m${s}\x1b[0m` : s),
  dim:   (s) => (TTY ? `\x1b[2m${s}\x1b[0m` : s),
};

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const OFFLINE = argv.includes('--offline');

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
Macro data build

  node scripts/build-macro.js             fetch everything, write macro.json
  node scripts/build-macro.js --dry-run   fetch and report, write nothing
  node scripts/build-macro.js --offline   recompute from the existing payload

Needs FRED_API_KEY. Get one free at https://fredaccount.stlouisfed.org/apikeys
`);
  process.exit(0);
}

const warnings = [];
const warn = (msg) => { warnings.push(msg); console.log(c.amber('    ! ' + msg)); };

function addDays(isoDate, n) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function readOverrides() {
  if (!fs.existsSync(OVERRIDES)) return {};
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES, 'utf8'));
  } catch (e) {
    warn(`macro-overrides.json is not valid JSON (${e.message}) — ignoring it.`);
    return {};
  }
}

function writePayload(payload) {
  if (DRY) {
    console.log(c.dim('\n  --dry-run: nothing written.'));
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  // Written minified. Pretty-printing puts every [date, value] pair of every
  // sparkline on four lines, which quadrupled the payload for no benefit —
  // nobody hand-edits generated data.
  fs.writeFileSync(OUT, JSON.stringify(payload));
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(c.green(`\n==> Wrote public/data/macro.json (${kb} KB)`));
}

/** The payload shape the UI reads when there is no key or no data. */
function unavailable(reason, detail) {
  return {
    available: false,
    reason,
    detail,
    generatedAt: new Date().toISOString(),
    generatedDate: new Date().toISOString().slice(0, 10),
    groups: GROUPS,
    releases: [],
    indicators: [],
    risk: null,
    positioning: [],
  };
}

/* ------------------------------------------------------------------ *
 * Release calendar
 * ------------------------------------------------------------------ */

/**
 * Resolves each spec entry to the FRED release id that serves it. Done as its
 * own step because the ids are what we then fetch dates for, one by one.
 */
function matchReleases(releases) {
  const byId = new Map();
  for (const spec of RELEASES) {
    const hit = releases.find((r) => spec.match.test(r.name));
    if (!hit) {
      warn(`FRED has no release matching ${spec.key} (${spec.name}) — skipped.`);
      continue;
    }
    byId.set(hit.id, { spec, release: hit });
  }
  return byId;
}

/**
 * Stamps each date with the time, agency and importance the spec supplies.
 * FRED gives dates; everything a reader needs to act on them comes from
 * macro-spec.js.
 */
function buildCalendar(byId, forwardDates, today) {
  const from = addDays(today, -CALENDAR_DAYS_BACK);
  const to = addDays(today, CALENDAR_DAYS_AHEAD);
  const out = [];

  for (const d of forwardDates) {
    const entry = byId.get(d.releaseId);
    if (!entry) continue;
    if (d.date < from || d.date > to) continue;

    const { spec } = entry;
    out.push({
      key: `${spec.key}-${d.date}`,
      releaseKey: spec.key,
      date: d.date,
      time: spec.time,
      tz: 'ET',
      short: spec.short,
      name: spec.name,
      group: spec.group,
      importance: spec.importance,
      agency: spec.agency,
      sourceUrl: spec.url,
      refPeriod: null,       // FRED does not publish the reference period
      valueAvailable: true,
      note: null,
      status: d.date < today ? 'past' : 'upcoming',
    });
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(c.cyan(`==> Macro build for ${today}\n`));

  if (OFFLINE) {
    if (!fs.existsSync(OUT)) {
      console.error(c.red('--offline needs an existing public/data/macro.json.'));
      process.exit(1);
    }
    console.log(c.dim('  --offline: leaving the existing payload in place.'));
    return;
  }

  const apiKey = fred.getApiKey();
  if (!apiKey) {
    console.log(c.amber('  FRED: SKIPPED — no API key configured.'));
    console.log(c.dim('    Get one free in about a minute, no payment details:'));
    console.log(c.dim('      https://fredaccount.stlouisfed.org/apikeys'));
    console.log(c.dim('    Then: setx FRED_API_KEY "your32charkey"   (Windows)'));
    console.log(c.dim('          export FRED_API_KEY="your32charkey" (macOS/Linux)'));
    console.log(c.dim('    or put it in data/config.json as "fredApiKey".'));
    writePayload(unavailable(
      'no-api-key',
      'Set FRED_API_KEY, or add "fredApiKey" to data/config.json, then run node scripts/build-macro.js'
    ));
    return;
  }

  const overrides = readOverrides();
  const hidden = new Set(overrides.hide || []);

  /* ---- 1. Release calendar ---- */
  console.log(c.cyan('==> Release calendar'));
  let calendar = [];
  try {
    const releases = await fred.fetchReleases(apiKey);
    const matched = matchReleases(releases);
    console.log(`    ${releases.length} releases tracked by FRED, ${matched.size} of ours matched`);

    // One request per release we actually want. Asking FRED to assemble the
    // forward calendar for all ~300 at once times out.
    const { dates, failed } = await fred.fetchReleaseDatesFor([...matched.keys()], apiKey, {
      from: addDays(today, -CALENDAR_DAYS_BACK),
      to: addDays(today, CALENDAR_DAYS_AHEAD),
    });

    for (const f of failed) {
      const entry = matched.get(f.releaseId);
      warn(`Release dates for ${entry ? entry.spec.short : f.releaseId}: ${f.error}`);
    }

    calendar = buildCalendar(matched, dates, today);
    console.log(`    ${calendar.length} dated events in window`);
    if (!calendar.length) {
      warn('The release calendar came back empty. Scheduled releases will be missing.');
    }
  } catch (e) {
    warn(`Release calendar failed: ${e.message}`);
  }

  /* ---- 2. Licensed-value releases with mechanical dates ---- */
  const fixed = macro.expandFixedEvents(
    FIXED_EVENTS,
    addDays(today, -CALENDAR_DAYS_BACK),
    addDays(today, CALENDAR_DAYS_AHEAD)
  ).map((e) => ({ ...e, status: e.date < today ? 'past' : 'upcoming' }));
  console.log(`    ${fixed.length} ISM events added from the published business-day rule`);

  /* ---- 3. FOMC ---- */
  console.log(c.cyan('\n==> FOMC calendar'));
  let fomc = [];
  if (Array.isArray(overrides.fomc) && overrides.fomc.length) {
    fomc = overrides.fomc;
    console.log(`    ${fomc.length} meetings taken from data/macro-overrides.json`);
  } else {
    const res = await macro.fetchFomcDates();
    if (res.warning) warn(res.warning);
    fomc = res.meetings;
    console.log(`    ${fomc.length} meetings parsed from federalreserve.gov`);
  }

  const fomcEvents = fomc
    .filter((m) => m.date >= addDays(today, -CALENDAR_DAYS_BACK) && m.date <= addDays(today, CALENDAR_DAYS_AHEAD))
    .map((m) => ({
      key: `fomc-${m.date}`,
      releaseKey: 'fomc',
      date: m.date,
      time: '14:00',
      tz: 'ET',
      // Every other row reads "short name / full name" — CPI / Consumer Price
      // Index. These read "FOMC decision / FOMC rate decision", the same words
      // twice, which made four distinct meetings look like one repeated four
      // times. The expansion goes in `name`, as everywhere else.
      short: 'FOMC decision',
      name: 'Federal Open Market Committee',
      // What actually separates one meeting from the next, beyond the date:
      // four of the eight carry the Summary of Economic Projections, and those
      // are the ones that move the rates market hardest.
      tag: m.sep ? 'dot plot' : null,
      group: 'fed',
      importance: 3,
      agency: 'Federal Reserve',
      sourceUrl: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
      refPeriod: null,
      valueAvailable: true,
      note: m.sep
        ? 'Rate decision plus the Summary of Economic Projections and dot plot.'
        : 'Rate decision and statement.',
      status: m.date < today ? 'past' : 'upcoming',
    }));

  /* ---- 4. Indicators ---- */
  console.log(c.cyan('\n==> Indicators'));
  const start = `${new Date().getUTCFullYear() - HISTORY_YEARS}-01-01`;

  // Several indicators share a series (CPI year-over-year and month-over-month
  // are the same observations transformed twice), so fetch each series once.
  const needed = [...new Set(INDICATORS.filter((i) => !hidden.has(i.id)).map((i) => i.series))];
  const rawBySeries = new Map();
  const metaBySeries = new Map();

  for (const seriesId of needed) {
    try {
      const obs = await fred.fetchSeries(seriesId, apiKey, { start });
      if (!obs.length) {
        warn(`${seriesId}: no observations returned.`);
        continue;
      }
      rawBySeries.set(seriesId, obs);
      try {
        const meta = await fred.fetchSeriesMeta(seriesId, apiKey);
        if (meta) metaBySeries.set(seriesId, meta);
      } catch { /* metadata is a nicety, not a requirement */ }
      process.stdout.write(c.dim('.'));
    } catch (e) {
      const spec = INDICATORS.find((i) => i.series === seriesId);
      const label = spec ? `${seriesId} (${spec.label})` : seriesId;
      if (spec && spec.critical) {
        warn(`${label} FAILED and is marked critical: ${e.message}`);
      } else {
        warn(`${label}: ${e.message}`);
      }
    }
  }
  process.stdout.write('\n');

  const indicators = [];
  // The composite needs the full transformed series, which the indicator's own
  // `history` field deliberately truncates. Kept out of the payload.
  const fullById = {};

  for (const spec of INDICATORS) {
    if (hidden.has(spec.id)) continue;
    const obs = rawBySeries.get(spec.series);
    if (!obs) continue;
    const ind = macro.buildIndicator(spec, obs, metaBySeries.get(spec.series) || null);
    if (!ind) {
      warn(`${spec.id}: not enough history to compute ${spec.transform}.`);
      continue;
    }
    indicators.push(ind);
    fullById[spec.id] = macro
      .transformSeries(obs, spec.transform, spec.freq, spec.scale || 1)
      .map((p) => p.value);
  }

  console.log(`    ${indicators.length} of ${INDICATORS.length - hidden.size} indicators built from ${rawBySeries.size} series`);

  /* ---- 5. Risk composite ---- */
  console.log(c.cyan('\n==> Risk composite'));
  const byId = Object.fromEntries(indicators.map((i) => [i.id, i]));
  const risk = macro.buildRiskComposite(byId, fullById);
  if (risk.score === null) {
    warn('Risk composite not computed: ' + (risk.note || 'insufficient inputs'));
  } else {
    if (risk.components.length < 4) {
      warn(`Risk composite is running on ${risk.components.length} of 4 components — ` +
           'one of VIXCLS, BAMLH0A0HYM2, SP500 or T10Y2Y is missing or too short.');
    }
    console.log(`    ${risk.score}/100 — ${risk.label} (${risk.components.length} components)`);
    for (const comp of risk.components) {
      console.log(c.dim(`      ${String(comp.score).padStart(3)}  ${comp.label} — ${comp.detail}`));
    }
  }

  /* ---- 6. Positioning ---- */
  console.log(c.cyan('\n==> CFTC positioning'));
  const pos = await macro.fetchPositioning();
  if (pos.warning) warn(pos.warning);
  if (pos.positioning.length) {
    console.log(`    ${pos.positioning.length} contracts as of ${pos.asOf}`);
  }

  /* ---- 7. Merge and write ---- */
  // Three sources feed one list, and FRED can return the same release date
  // under more than one realtime vintage. Nothing observed has duplicated yet,
  // but a calendar that lists an event twice reads as broken, and the guard
  // costs one pass.
  const byKey = new Map();
  let dupes = 0;
  for (const ev of [...calendar, ...fixed, ...fomcEvents]) {
    const k = `${ev.releaseKey}|${ev.date}`;
    if (byKey.has(k)) { dupes++; continue; }
    byKey.set(k, ev);
  }
  if (dupes) console.log(c.dim(`    (collapsed ${dupes} duplicate release date${dupes === 1 ? '' : 's'})`));

  const releasesAll = [...byKey.values()]
    .sort((a, b) =>
      a.date.localeCompare(b.date) ||
      b.importance - a.importance ||
      String(a.time).localeCompare(String(b.time))
    );

  const nextBig = releasesAll.find((r) => r.status === 'upcoming' && r.importance === 3);

  const payload = {
    available: indicators.length > 0 || releasesAll.length > 0,
    reason: null,
    detail: null,
    generatedAt: new Date().toISOString(),
    generatedDate: today,
    groups: GROUPS,
    counts: {
      releases: releasesAll.length,
      upcoming: releasesAll.filter((r) => r.status === 'upcoming').length,
      indicators: indicators.length,
    },
    releases: releasesAll,
    indicators,
    risk,
    positioning: pos.positioning,
    positioningAsOf: pos.asOf || null,
    // Attribution, shown in the page footer.
    //
    // Build diagnostics and the catalogue of licensed data we leave out are
    // deliberately NOT in this payload. macro.json is served publicly, so
    // anything put here is published; those notes are for whoever runs the
    // build, and they belong in the build log and the README instead.
    notes: {
      sources: [
        { name: 'FRED (St. Louis Fed)', url: 'https://fred.stlouisfed.org/', covers: 'Indicator values and the release calendar' },
        { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', covers: 'FOMC meeting dates' },
        { name: 'CFTC', url: 'https://publicreporting.cftc.gov/', covers: 'Speculative positioning' },
      ],
    },
  };

  if (nextBig) {
    console.log(c.dim(`\n  Next major release: ${nextBig.date} ${nextBig.time} ET — ${nextBig.name}`));
  }

  writePayload(payload);

  if (warnings.length) {
    console.log(c.amber(`\n  ${warnings.length} warning(s) above. The page renders without the missing pieces.`));
  }
}

main().catch((e) => {
  console.error(c.red('\nMacro build failed: ' + e.message));
  console.error(c.dim(e.stack));
  // Leave a payload the UI can explain rather than a missing file it cannot fetch.
  try {
    if (!DRY) writePayload(unavailable('build-failed', e.message));
  } catch { /* nothing more to do */ }
  process.exit(1);
});
