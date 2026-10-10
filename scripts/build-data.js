#!/usr/bin/env node
/**
 * Fetches trial records from the ClinicalTrials.gov v2 API for every tracked
 * ticker, merges with hand-curated catalysts, and writes:
 *
 *   public/data/index.json        - ticker list + counts (small, loaded first)
 *   public/data/ticker/<T>.json   - one file per ticker (loaded on demand)
 *   public/data/events.json       - combined file (back-compat with current UI)
 *
 * Runs server-side: no CORS, no API key. Network failures degrade to curated
 * data rather than failing the build.
 *
 *   node scripts/build-data.js              build everything
 *   node scripts/build-data.js --validate   report bad sponsor mappings only
 *   node scripts/build-data.js --only MRNA,ILMN
 */

const fs = require('fs');
const path = require('path');
const edgar = require('./edgar.js');
const xbrl = require('./xbrl.js');

const ROOT = path.join(__dirname, '..');
const TICKERS_PATH = path.join(ROOT, 'data', 'tickers.json');
const CURATED_PATH = path.join(ROOT, 'data', 'curated.json');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const TICKER_DIR = path.join(OUT_DIR, 'ticker');

const API = 'https://clinicaltrials.gov/api/v2/studies';
const PAGE_SIZE = 200;
const MAX_PAGES = 3;
// ClinicalTrials.gov documents a ~10 req/sec ceiling. Stay well under it.
const REQUEST_GAP_MS = 250;
/**
 * Registry events older than this are dropped from the CALENDAR. Trial
 * completions from years ago are accurate but not catalysts, and they bury
 * what is actually coming. Outcome statistics deliberately ignore this cutoff
 * and keep the full history, because completion rate needs the sample.
 * Set to 0 to keep everything.
 */
const CALENDAR_MAX_AGE_YEARS = 10;
const MAX_RETRIES = 3;

/**
 * Outcome statistics are computed across every study the sponsor has
 * registered, not just the ones that survive the calendar filters. A
 * terminated trial has no useful date but is exactly what we want to count.
 */
function outcomeStats(studies, sponsorQuery){
  const st = { completed:0, terminated:0, withdrawn:0, suspended:0, ongoing:0,
               withResults:0, byPhase:{} };
  for (const s of studies) {
    const p = s.protocolSection || {};
    const lead = (((p.sponsorCollaboratorsModule||{}).leadSponsor)||{}).name || '';
    if (!lead.toLowerCase().includes(sponsorQuery.toLowerCase())) continue;
    const status = (p.statusModule||{}).overallStatus || '';
    const phases = (p.designModule||{}).phases || [];
    const ph = phases.includes('PHASE3') ? 'phase3'
             : phases.includes('PHASE2') ? 'phase2'
             : phases.includes('PHASE1') ? 'phase1' : 'other';
    st.byPhase[ph] = st.byPhase[ph] || { completed:0, terminated:0, total:0 };
    st.byPhase[ph].total++;

    if (status === 'COMPLETED')      { st.completed++;  st.byPhase[ph].completed++; }
    else if (status === 'TERMINATED'){ st.terminated++; st.byPhase[ph].terminated++; }
    else if (status === 'WITHDRAWN') { st.withdrawn++; }
    else if (status === 'SUSPENDED') { st.suspended++; }
    else { st.ongoing++; }
    if (s.hasResults) st.withResults++;
  }

  // Completion rate: of the trials that reached an end state, how many finished.
  const concluded = st.completed + st.terminated + st.withdrawn;
  st.concluded = concluded;
  st.completionRatePct = concluded >= 5
    ? Math.round((st.completed / concluded) * 100)
    : null;   // too few to mean anything
  st.resultsPostedPct = st.completed >= 5
    ? Math.round((st.withResults / st.completed) * 100)
    : null;
  for (const [k, v] of Object.entries(st.byPhase)) {
    const c = v.completed + v.terminated;
    v.completionRatePct = c >= 4 ? Math.round((v.completed / c) * 100) : null;
  }
  return st;
}

const INTERESTING_STATUSES = new Set([
  'RECRUITING',
  'ACTIVE_NOT_RECRUITING',
  'ENROLLING_BY_INVITATION',
  'NOT_YET_RECRUITING',
  'COMPLETED',
  'TERMINATED',
]);

/* Counted for outcome stats but never shown on the calendar. */
const OUTCOME_ONLY_STATUSES = new Set(['WITHDRAWN', 'SUSPENDED']);

const FIELDS = [
  'NCTId', 'BriefTitle', 'OverallStatus', 'Phase',
  'PrimaryCompletionDate', 'CompletionDate', 'StartDate',
  'LeadSponsorName', 'Condition', 'EnrollmentCount', 'HasResults', 'StudyType',
].join(',');

const args = process.argv.slice(2);
const VALIDATE_ONLY = args.includes('--validate');
const NO_EDGAR = args.includes('--no-edgar');
const NO_TRIALS = args.includes('--no-trials');
const NO_METRICS = args.includes('--no-metrics');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx !== -1
  ? (args[onlyIdx + 1] || '').split(',').map(s => s.trim().toUpperCase())
  : null;

function log(m) { process.stdout.write(m + '\n'); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ fetch */

async function fetchSponsorStudies(sponsorQuery) {
  const studies = [];
  let pageToken = null;
  let useFields = true;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      'query.spons': sponsorQuery,
      pageSize: String(PAGE_SIZE),
      format: 'json',
    });
    if (useFields) params.set('fields', FIELDS);
    if (pageToken) params.set('pageToken', pageToken);

    let res = null;
    let lastErr = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        res = await fetch(`${API}?${params.toString()}`, {
          headers: { Accept: 'application/json' },
        });
      } catch (e) {
        lastErr = e;
        res = null;
        await sleep(500 * (attempt + 1));
        continue;
      }
      // Back off and retry on rate limiting or transient server errors.
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        res = null;
        await sleep(1000 * (attempt + 1));
        continue;
      }
      break;
    }
    if (!res) throw lastErr || new Error('request failed');

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 400 && useFields) {
        useFields = false;
        page--;
        continue;
      }
      throw new Error(`HTTP ${res.status}${body ? ' - ' + body.slice(0, 120) : ''}`);
    }

    const json = await res.json();
    studies.push(...(json.studies || []));
    pageToken = json.nextPageToken || null;
    await sleep(REQUEST_GAP_MS);
    if (!pageToken) break;
  }
  return studies;
}

/* ----------------------------------------------------------------- mapping */

function normaliseDate(struct) {
  if (!struct || !struct.date) return null;
  const d = struct.date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  if (/^\d{4}-\d{2}$/.test(d)) return `${d}-15`;
  return null;
}

function phaseLabel(phases) {
  if (!phases || !phases.length) return null;
  return phases.map(p => p.replace('PHASE', 'Phase ').replace('NA', 'N/A').trim()).join('/');
}

function titleCaseStatus(s) {
  return s.toLowerCase().split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function studyToEvent(study, ticker, sponsorQuery, allowUnphased, oldestAllowed) {
  const p = study.protocolSection || {};
  const ident = p.identificationModule || {};
  const status = p.statusModule || {};
  const design = p.designModule || {};
  const cond = p.conditionsModule || {};
  const sponsor = (p.sponsorCollaboratorsModule || {}).leadSponsor || {};

  // query.spons also matches collaborators, so require the LEAD sponsor to match.
  const leadName = (sponsor.name || '').toLowerCase();
  if (!leadName.includes(sponsorQuery.toLowerCase())) return null;

  if (!INTERESTING_STATUSES.has(status.overallStatus)) return null;

  const date = normaliseDate(status.primaryCompletionDateStruct)
            || normaliseDate(status.completionDateStruct);
  if (!date) return null;

  // Too old to be a catalyst. Counted in outcome stats, kept off the calendar.
  if (oldestAllowed && date < oldestAllowed) return null;

  let phase = phaseLabel(design.phases);
  if (!phase || phase === 'N/A') {
    // Diagnostics companies run observational studies with no phase. Keep them
    // only where the ticker opted in, otherwise they are noise.
    if (!allowUnphased) return null;
    phase = (design.studyType === 'OBSERVATIONAL') ? 'Observational' : 'No phase';
  }

  const enrollment = (design.enrollmentInfo || {}).count;
  const conditions = (cond.conditions || []).slice(0, 3).join(', ');

  const bits = [];
  if (conditions) bits.push(conditions);
  if (enrollment) bits.push(`${enrollment.toLocaleString()} participants`);
  bits.push(`Status: ${titleCaseStatus(status.overallStatus)}`);

  return {
    id: `ct-${ticker}-${ident.nctId}`,
    ticker,
    date,
    title: ident.briefTitle || ident.nctId,
    type: 'Trial Milestone',
    phase,
    estimated: (status.primaryCompletionDateStruct || {}).type === 'ESTIMATED'
            || (status.completionDateStruct || {}).type === 'ESTIMATED',
    summary: bits.join(' \u00b7 '),
    result: study.hasResults
      ? 'Results have been posted to ClinicalTrials.gov. Open the registry record for outcome measures and adverse event data.'
      : null,
    source: `ClinicalTrials.gov ${ident.nctId}`,
    sourceUrl: `https://clinicaltrials.gov/study/${ident.nctId}`,
    origin: 'registry',
  };
}

/* -------------------------------------------------------------------- main */

async function main() {
  const tickerFile = JSON.parse(fs.readFileSync(TICKERS_PATH, 'utf8'));
  const curated = JSON.parse(fs.readFileSync(CURATED_PATH, 'utf8'));
  const today = new Date().toISOString().slice(0, 10);
  const calendarCutoff = CALENDAR_MAX_AGE_YEARS > 0
    ? new Date(Date.now() - CALENDAR_MAX_AGE_YEARS * 365.25 * 86400000).toISOString().slice(0, 10)
    : null;

  let entries = Object.entries(tickerFile.tickers);
  if (ONLY) entries = entries.filter(([t]) => ONLY.includes(t));

  const curatedByTicker = {};
  for (const e of curated.events) {
    (curatedByTicker[e.ticker] = curatedByTicker[e.ticker] || []).push({ ...e, origin: 'curated' });
  }

  log(`Building ${entries.length} tickers (${curated.events.length} curated catalysts on file)`);

  // ---- EDGAR setup (optional; skipped cleanly if no contact string is set) ----
  let edgarUA = null;
  let tickerMap = null;
  if (!NO_EDGAR) {
    edgarUA = edgar.getUserAgent();
    if (!edgarUA) {
      log('\nSEC EDGAR: SKIPPED - no contact string configured.');
      log('  The SEC requires a User-Agent naming you and giving an email,');
      log('  otherwise every request returns 403. Set one with either:');
      log('    Windows      setx EDGAR_USER_AGENT "Your Name you@example.com"');
      log('    macOS/Linux  export EDGAR_USER_AGENT="Your Name you@example.com"');
      log('  ...or edit data/config.json. Then re-run npm run build.');
    } else {
      try {
        log(`\nSEC EDGAR: fetching ticker->CIK map as "${edgarUA}"...`);
        tickerMap = await edgar.fetchTickerMap(edgarUA);
        log(`  mapped ${Object.keys(tickerMap).length.toLocaleString()} tickers to CIKs.`);
      } catch (e) {
        log(`  EDGAR unavailable: ${e.message}`);
        log('  Continuing without EDGAR data.');
        tickerMap = null;
      }
    }
  }
  log('');

  const report = [];
  const edgarMisses = [];
  const metrics = {};
  const metricsMisses = [];
  const metricsErrors = [];
  const nonUsd = [];
  let agedOut = 0;
  const edgarErrors = [];
  const allEvents = [];
  const index = {};
  let done = 0;

  for (const [ticker, meta] of entries) {
    done++;
    const prefix = `[${String(done).padStart(3)}/${entries.length}] ${ticker.padEnd(5)}`;
    let registryEvents = [];
    let trialStats = null;
    let edgarEvents = [];
    let edgarNote = '';
    let error = null;

    try {
      const studies = NO_TRIALS ? [] : await fetchSponsorStudies(meta.sponsorQuery);
      trialStats = outcomeStats(studies, meta.sponsorQuery);
      const unfiltered = studies.map(s => studyToEvent(s, ticker, meta.sponsorQuery, !!meta.allowUnphased, null)).filter(Boolean);
      registryEvents = studies.map(s => studyToEvent(s, ticker, meta.sponsorQuery, !!meta.allowUnphased, calendarCutoff)).filter(Boolean);
      agedOut += unfiltered.length - registryEvents.length;
      const flag = studies.length === 0 ? '  <-- no studies; check sponsorQuery'
                 : registryEvents.length === 0 ? '  <-- studies found but none kept'
                 : '';
      log(`${prefix} ${String(studies.length).padStart(4)} studies -> ${String(registryEvents.length).padStart(3)} events${flag}`);
      report.push({ ticker, sponsorQuery: meta.sponsorQuery, studies: studies.length, events: registryEvents.length, error: null });
    } catch (e) {
      error = e.message;
      log(`${prefix} ERROR: ${error}`);
      report.push({ ticker, sponsorQuery: meta.sponsorQuery, studies: 0, events: 0, error });
    }

    // ---- EDGAR filings for this ticker ----
    if (tickerMap) {
      // discover.js already resolved and stored a CIK; prefer it.
      const hit = meta.cik ? { cik: meta.cik } : tickerMap[ticker];
      if (!hit) {
        edgarNote = 'no CIK';
        edgarMisses.push(ticker);
      } else {
        try {
          const r = await edgar.fetchCompanyEvents(ticker, hit.cik, today, edgarUA);
          edgarEvents = r.events;
          if (r.events.length === 0) {
            const forms = Object.entries(r.formCounts || {})
              .sort((a, b) => b[1] - a[1]).slice(0, 4)
              .map(([f, n]) => `${f}:${n}`).join(' ');
            edgarNote = r.totalFilings === 0
              ? '0 edgar  <-- no filings at all; wrong CIK?'
              : `0 edgar  <-- ${r.totalFilings} filings but none usable [${forms}]`;
          } else {
            edgarNote = `${r.events.length} edgar` + (r.projected ? ` (next earnings ~${r.projected})` : '');
          }
        } catch (e) {
          edgarNote = 'edgar error: ' + e.message.slice(0, 60);
          edgarErrors.push(`${ticker}: ${e.message}`);
        }
      }
      if (edgarNote) log(`${' '.repeat(prefix.length)} ${edgarNote}`);
    }

    // ---- XBRL financial metrics ----
    if (tickerMap && !NO_METRICS) {
      const hit = tickerMap[ticker];
      if (hit) {
        try {
          const m = await xbrl.fetchMetrics(hit.cik, edgarUA);
          if (m) {
            metrics[ticker] = m;
            const ccy = m.reportingCurrency || '';
            const cash = m.totalCashUsd
              ? (m.isUsd ? '$' : ccy + ' ') + (m.totalCashUsd/1e6).toFixed(0) + 'M'
              : 'no cash data';
            const rw = m.runwayMonths ? m.runwayMonths + 'mo runway' : m.cashStatus;
            const tax = m.taxonomy === 'ifrs-full' ? ' [IFRS]' : '';
            const warn = (m.reportingCurrency && !m.isUsd) ? '  <-- non-USD, not comparable' : '';
            log(`${' '.repeat(prefix.length)} ${cash}, ${rw}${tax}${warn}`);
            if (m.reportingCurrency && !m.isUsd) nonUsd.push(`${ticker} (${ccy})`);
          } else {
            metricsMisses.push(ticker);
          }
        } catch (e) {
          metricsErrors.push(`${ticker}: ${e.message}`);
        }
      }
    }

    const events = [...(curatedByTicker[ticker] || []), ...registryEvents, ...edgarEvents]
      .map(e => ({
        ...e,
        status: e.date <= today ? 'past' : 'upcoming',
        estimated: !!e.estimated,
        phase: e.phase || null,
        result: e.result || null,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    if (!VALIDATE_ONLY) {
      fs.mkdirSync(TICKER_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(TICKER_DIR, `${ticker}.json`),
        JSON.stringify({
          ticker, ...meta, generatedDate: today,
          metrics: Object.assign({}, metrics[ticker] || {}, xbrl.trialMetrics(events, today)),
      trialStats,
          events,
        }, null, 2)
      );
    }

    index[ticker] = {
      name: meta.name,
      tier: meta.tier,
      focus: meta.focus,
      // carried from discover.js so the UI can rank by real trial activity
      score: meta.score ?? null,
      activeTrials: meta.activeTrials ?? null,
      phase3: meta.phase3 ?? null,
      counts: {
        total: events.length,
        curated: events.filter(e => e.origin === 'curated').length,
        registry: events.filter(e => e.origin === 'registry').length,
        edgar: events.filter(e => e.origin === 'edgar').length,
        upcoming: events.filter(e => e.status === 'upcoming').length,
      },
      nextDate: (events.find(e => e.status === 'upcoming') || {}).date || null,
      metrics: Object.assign({}, metrics[ticker] || {}, xbrl.trialMetrics(events, today)),
      trialStats,
      error,
    };
    allEvents.push(...events);
  }

  /* ------------------------------------------------------------- reporting */

  const failed = report.filter(r => r.error);
  const empty = report.filter(r => !r.error && r.studies === 0);
  const noEvents = report.filter(r => !r.error && r.studies > 0 && r.events === 0);

  log('\n' + '='.repeat(64));
  log(`Tickers processed : ${report.length}`);
  log(`Total events      : ${allEvents.length}`);
  log(`  curated         : ${allEvents.filter(e => e.origin === 'curated').length}`);
  log(`  registry        : ${allEvents.filter(e => e.origin === 'registry').length}`);
  log(`  edgar           : ${allEvents.filter(e => e.origin === 'edgar').length}`);
  if (calendarCutoff) {
    log(`Aged out of view  : ${agedOut}  (registry events before ${calendarCutoff}; still counted in trial stats)`);
  }
  log(`Fetch errors      : ${failed.length}`);
  log(`Zero studies      : ${empty.length}${empty.length ? '  <-- likely wrong sponsorQuery' : ''}`);
  log(`Metrics fetched   : ${Object.keys(metrics).length}${metricsMisses.length ? '  (' + metricsMisses.length + ' had no XBRL facts)' : ''}`);
  const withRunway = Object.values(metrics).filter(m => m.runwayMonths !== null).length;
  const lowRunway = Object.values(metrics).filter(m => m.cashStatus === 'under-12mo').length;
  log(`  runway computed : ${withRunway}${lowRunway ? '   (' + lowRunway + ' under 12 months)' : ''}`);
  log(`Studies, no events: ${noEvents.length}  (filtered: no phase, no date, or wrong lead sponsor)`);

  if (empty.length) {
    log('\nTickers returning no studies - fix sponsorQuery in data/tickers.json:');
    for (const r of empty) log(`  ${r.ticker.padEnd(6)} "${r.sponsorQuery}"`);
  }
  if (noEvents.length) {
    log('\nTickers with studies but no calendar events:');
    for (const r of noEvents) log(`  ${r.ticker.padEnd(6)} "${r.sponsorQuery}" (${r.studies} studies)`);
  }
  if (failed.length) {
    log('\nTickers that errored:');
    for (const r of failed) log(`  ${r.ticker.padEnd(6)} ${r.error}`);
  }
  if (edgarMisses.length) {
    log(`\nNo CIK found for ${edgarMisses.length} ticker(s) - likely delisted, acquired, or foreign-only:`);
    log('  ' + edgarMisses.join(', '));
  }
  if (nonUsd.length) {
    log(`\n${nonUsd.length} ticker(s) report in a non-USD currency - cash and revenue`);
    log('are in their own currency, so do not compare them across tickers:');
    log('  ' + nonUsd.join(', '));
  }
  if (metricsErrors.length) {
    log(`\nMetrics errors (${metricsErrors.length}):`);
    for (const m of metricsErrors.slice(0, 5)) log('  ' + m);
  }
  if (edgarErrors.length) {
    log(`\nEDGAR errors (${edgarErrors.length}):`);
    for (const m of edgarErrors.slice(0, 10)) log('  ' + m);
  }
  log('='.repeat(64));

  if (VALIDATE_ONLY) {
    log('\n--validate: no files written.');
    return;
  }

  /* ---------------------------------------------------------------- output */

  fs.mkdirSync(OUT_DIR, { recursive: true });
  allEvents.sort((a, b) => a.date.localeCompare(b.date));

  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    generatedDate: today,
    tickerCount: Object.keys(index).length,
    totalEvents: allEvents.length,
    tickers: index,
  }, null, 2));

  // Back-compat: the current UI still reads events.json with a flat tickers map.
  const flatTickers = {};
  for (const [t, v] of Object.entries(index)) {
    flatTickers[t] = { name: v.name, note: v.focus };
  }
  fs.writeFileSync(path.join(OUT_DIR, 'events.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    generatedDate: today,
    tickers: flatTickers,
    warnings: failed.map(r => `${r.ticker}: ${r.error}`),
    counts: {
      total: allEvents.length,
      curated: allEvents.filter(e => e.origin === 'curated').length,
      registry: allEvents.filter(e => e.origin === 'registry').length,
      edgar: allEvents.filter(e => e.origin === 'edgar').length,
    },
    events: allEvents,
  }, null, 2));

  const sizeMB = (fs.statSync(path.join(OUT_DIR, 'events.json')).size / 1048576).toFixed(2);
  log(`\nWrote index.json, events.json (${sizeMB} MB), and ${Object.keys(index).length} per-ticker files.`);
  if (Number(sizeMB) > 2) {
    log('NOTE: events.json is large. The UI should switch to per-ticker loading.');
  }
}

main().catch(e => { console.error('Build failed:', e); process.exit(1); });
