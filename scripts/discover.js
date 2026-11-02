#!/usr/bin/env node
/*
 * Builds data/tickers.json (run monthly-ish).
 *  1. page through CT.gov for industry-sponsored, active phase 2/3 trials, count per sponsor
 *  2. match sponsor names to tickers (SEC company_tickers.json)
 *  3. check the SIC code is life sciences, so 'Mirati' can't match some random company
 *  4. score by trial activity
 * Ambiguous matches go to data/discovery-review.json.
 *
 *   node scripts/discover.js
 *   node scripts/discover.js --limit 40
 *   node scripts/discover.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const edgar = require('./edgar.js');

const ROOT = path.join(__dirname, '..');
const OUT_TICKERS = path.join(ROOT, 'data', 'tickers.json');
const OUT_REVIEW = path.join(ROOT, 'data', 'discovery-review.json');
const OVERRIDES = path.join(ROOT, 'data', 'overrides.json');
const ALIASES = path.join(ROOT, 'data', 'aliases.json');

const CT_API = 'https://clinicaltrials.gov/api/v2/studies';
const CT_PAGE_SIZE = 1000;
const CT_MAX_PAGES = 60;
const CT_GAP_MS = 250;

const SEC_SUBMISSIONS = (cik) => `https://data.sec.gov/submissions/CIK${cik}.json`;
const SEC_GAP_MS = 125;

// life sciences SIC codes
const LIFE_SCIENCE_SIC = new Set([
  '2833', // Medicinal Chemicals & Botanical Products
  '2834', // Pharmaceutical Preparations
  '2835', // In Vitro & In Vivo Diagnostic Substances
  '2836', // Biological Products (except diagnostic)
  '3826', // Laboratory Analytical Instruments
  '3841', // Surgical & Medical Instruments
  '8731', // Commercial Physical & Biological Research
]);

// suffixes to strip before matching
const NOISE = /\b(inc|incorporated|corp|corporation|company|co|ltd|limited|llc|lp|plc|sa|ag|nv|bv|as|a\/s|ab|oy|gmbh|holdings?|group|pharmaceuticals?|pharma|therapeutics?|biosciences?|bioscience|biotech(nology)?|laboratories|labs?|sciences?|medicines?|health(care)?|usa|us|america|international|global|and|the|of|research|development|operations|subsidiary)\b/gi;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 300;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function log(m) { process.stdout.write(m + '\n'); }

/* 1. sponsor aggregation */

async function fetchSponsorCounts() {
  const counts = {};        // sponsor -> { total, phase3, phase2 }
  let pageToken = null;
  let pages = 0;
  let studiesSeen = 0;

  while (pages < CT_MAX_PAGES) {
    const params = new URLSearchParams({
      'filter.overallStatus': 'RECRUITING|ACTIVE_NOT_RECRUITING|NOT_YET_RECRUITING',
      'query.term': 'AREA[StudyType]INTERVENTIONAL AND (AREA[Phase]PHASE2 OR AREA[Phase]PHASE3)',
      fields: 'LeadSponsorName,LeadSponsorClass,Phase,OverallStatus',
      pageSize: String(CT_PAGE_SIZE),
      format: 'json',
    });
    if (pageToken) params.set('pageToken', pageToken);

    let res;
    try {
      res = await fetch(`${CT_API}?${params.toString()}`, { headers: { Accept: 'application/json' } });
    } catch (e) {
      throw new Error(`ClinicalTrials.gov unreachable: ${e.message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ClinicalTrials.gov HTTP ${res.status}${body ? ' - ' + body.slice(0, 140) : ''}`);
    }

    const json = await res.json();
    const studies = json.studies || [];
    studiesSeen += studies.length;

    for (const s of studies) {
      const p = s.protocolSection || {};
      const sponsor = ((p.sponsorCollaboratorsModule || {}).leadSponsor) || {};
      if (sponsor.class !== 'INDUSTRY') continue;      // no universities / NIH / hospitals
      const name = (sponsor.name || '').trim();
      if (!name) continue;

      const phases = (p.designModule || {}).phases || [];
      const c = counts[name] || (counts[name] = { total: 0, phase3: 0, phase2: 0 });
      c.total++;
      if (phases.some(x => x.includes('3'))) c.phase3++;
      else if (phases.some(x => x.includes('2'))) c.phase2++;
    }

    pages++;
    pageToken = json.nextPageToken || null;
    log(`  page ${pages}: ${studies.length} studies (${studiesSeen} total, ${Object.keys(counts).length} industry sponsors)`);
    if (!pageToken) break;
    await sleep(CT_GAP_MS);
  }

  return counts;
}

/* 2. name matching */

function normalise(name) {
  return String(name)
    .toLowerCase()
    .replace(/[.,&()'"\/-]/g, ' ')
    .replace(NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// first real word of a name
function headword(name) {
  const n = normalise(name);
  return n.split(' ')[0] || '';
}

function buildSecIndex(tickerMap) {
  const byNorm = new Map();
  const byHead = new Map();
  const byTicker = new Map();
  for (const [ticker, info] of Object.entries(tickerMap)) {
    byTicker.set(ticker.toUpperCase(), { ticker, ...info });
    const n = normalise(info.title);
    if (n && !byNorm.has(n)) byNorm.set(n, { ticker, ...info });
    const h = headword(info.title);
    if (h && h.length >= 4) {
      if (!byHead.has(h)) byHead.set(h, []);
      byHead.get(h).push({ ticker, ...info });
    }
  }
  return { byNorm, byHead, byTicker };
}

// same word or one is a prefix of the other
function tokenAkin(a, b) {
  if (a === b) return true;
  if (a.length >= 5 && b.length >= 5) {
    if (a.startsWith(b) || b.startsWith(a)) return true;   // moderna / modernatx
  }
  return false;
}

// share of A's tokens found in B
function tokenOverlap(aTokens, bTokens) {
  if (!aTokens.length) return 0;
  let hits = 0;
  for (const t of aTokens) if (bTokens.some(u => tokenAkin(t, u))) hits++;
  return hits / aTokens.length;
}

function matchSponsor(sponsorName, index, aliases) {
  const raw = String(sponsorName).toLowerCase();

  // 1. subsidiary aliases (Janssen -> JNJ, Genentech -> Roche...)
  if (aliases) {
    for (const [frag, ticker] of Object.entries(aliases)) {
      if (!ticker) continue;
      if (raw.includes(frag)) {
        const info = index.byTicker.get(ticker.toUpperCase());
        if (info) return { ...info, confidence: 'alias', aliasFrom: frag };
      }
    }
  }

  const n = normalise(sponsorName);
  if (!n) return null;
  const nTokens = n.split(' ').filter(Boolean);

  // 2. exact match
  if (index.byNorm.has(n)) return { ...index.byNorm.get(n), confidence: 'exact' };

  // 3. first word match, prefixes ok
  const h = nTokens[0] || '';
  const headCands = [];
  if (h.length >= 4) {
    for (const [key, list] of index.byHead) {
      if (tokenAkin(h, key)) headCands.push(...list);
    }
  }
  if (headCands.length === 1) return { ...headCands[0], confidence: 'headword' };

  // 4. token overlap, has to be strong both ways and a clear winner
  let best = null, bestScore = 0, runnerUp = 0;
  for (const [norm, info] of index.byNorm) {
    const bTokens = norm.split(' ').filter(Boolean);
    if (!bTokens.length) continue;
    const score = Math.min(tokenOverlap(nTokens, bTokens), tokenOverlap(bTokens, nTokens));
    if (score > bestScore) { runnerUp = bestScore; bestScore = score; best = info; }
    else if (score > runnerUp) { runnerUp = score; }
  }
  if (best && bestScore >= 0.6) {
    // too close to call -> review
    if (bestScore - runnerUp < 0.15) {
      return { ...best, confidence: 'ambiguous', alternatives: [best.ticker] };
    }
    return { ...best, confidence: bestScore >= 0.9 ? 'strong' : 'overlap' };
  }

  if (headCands.length > 1) {
    return { ...headCands[0], confidence: 'ambiguous', alternatives: headCands.map(c => c.ticker) };
  }
  return null;
}

/* 3. SIC verification */

async function fetchSic(cik, userAgent) {
  let res;
  try {
    res = await fetch(SEC_SUBMISSIONS(cik), {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/json', 'Accept-Encoding': 'gzip, deflate' },
    });
  } catch (e) {
    return { error: e.message };
  }
  if (res.status === 404) return { error: 'no submissions record' };
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const j = await res.json();
  await sleep(SEC_GAP_MS);
  return {
    sic: j.sic ? String(j.sic) : null,
    sicDescription: j.sicDescription || null,
    name: j.name || null,
    tickers: j.tickers || [],
    exchanges: j.exchanges || [],
  };
}

/* 4. scoring */

function scoreCompany(counts) {
  return counts.phase3 * 3 + counts.phase2 * 1;
}

function tierFor(sic, counts) {
  if (sic === '3826' || sic === '3841' || sic === '2835') return 'tools';
  if (counts.phase3 >= 15) return 'large-pharma';
  if (counts.phase3 >= 5) return 'large-biotech';
  if (counts.phase3 >= 1) return 'mid-cap';
  return 'clinical-stage';
}

/* main */

async function main() {
  const userAgent = edgar.getUserAgent();
  if (!userAgent) {
    log('ERROR: no SEC contact string configured.');
    log('  Discovery needs it to resolve tickers and verify SIC codes.');
    log('    Windows      setx EDGAR_USER_AGENT "Your Name you@example.com"');
    log('    macOS/Linux  export EDGAR_USER_AGENT="Your Name you@example.com"');
    process.exit(1);
  }

  let aliases = {};
  if (fs.existsSync(ALIASES)) {
    try { aliases = JSON.parse(fs.readFileSync(ALIASES, 'utf8')).aliases || {}; }
    catch { log('  (aliases.json unreadable; ignoring)'); }
  }

  let overrides = { alwaysInclude: {}, neverInclude: [] };
  if (fs.existsSync(OVERRIDES)) {
    try { overrides = Object.assign(overrides, JSON.parse(fs.readFileSync(OVERRIDES, 'utf8'))); }
    catch { log('  (overrides.json present but unreadable; ignoring)'); }
  }
  const never = new Set((overrides.neverInclude || []).map(s => s.toUpperCase()));

  log('Step 1/4  Aggregating industry sponsors from ClinicalTrials.gov');
  log('          (interventional, Phase 2/3, recruiting or active)\n');
  const counts = await fetchSponsorCounts();
  const sponsors = Object.entries(counts).sort((a, b) => scoreCompany(b[1]) - scoreCompany(a[1]));
  log(`\n  ${sponsors.length.toLocaleString()} industry sponsors found.\n`);

  log('Step 2/4  Fetching SEC ticker -> CIK map');
  const tickerMap = await edgar.fetchTickerMap(userAgent);
  log(`  ${Object.keys(tickerMap).length.toLocaleString()} registrants.\n`);
  const index = buildSecIndex(tickerMap);
  log(`  ${Object.keys(aliases).filter(k => aliases[k]).length} subsidiary aliases loaded.\n`);

  log('Step 3/4  Matching sponsors to tickers and verifying SIC codes');
  const accepted = {};
  const review = [];
  let checked = 0;

  for (const [sponsorName, c] of sponsors) {
    if (Object.keys(accepted).length >= LIMIT) break;
    const m = matchSponsor(sponsorName, index, aliases);
    if (!m) {
      review.push({ sponsorName, reason: 'no ticker match (likely private)', counts: c });
      continue;
    }
    if (never.has(m.ticker)) continue;
    if (accepted[m.ticker]) {
      // merge subsidiaries
      accepted[m.ticker]._counts.total += c.total;
      accepted[m.ticker]._counts.phase3 += c.phase3;
      accepted[m.ticker]._counts.phase2 += c.phase2;
      continue;
    }

    checked++;
    const sec = await fetchSic(m.cik, userAgent);
    if (sec.error) {
      review.push({ sponsorName, ticker: m.ticker, reason: 'SEC lookup failed: ' + sec.error, counts: c });
      continue;
    }
    if (!LIFE_SCIENCE_SIC.has(sec.sic)) {
      review.push({
        sponsorName, ticker: m.ticker, reason: `SIC ${sec.sic} (${sec.sicDescription}) is not life sciences`,
        confidence: m.confidence, counts: c,
      });
      continue;
    }
    if (m.confidence === 'ambiguous') {
      review.push({
        sponsorName, ticker: m.ticker, reason: 'ambiguous name match',
        alternatives: m.alternatives, counts: c,
      });
      continue;
    }

    accepted[m.ticker] = {
      name: sec.name || m.title,
      sponsorQuery: sponsorName,       // exact registry string
      tier: tierFor(sec.sic, c),
      focus: sec.sicDescription || '',
      sic: sec.sic,
      cik: m.cik,
      matchConfidence: m.confidence,
      _counts: { ...c },
    };

    if (checked % 25 === 0) {
      log(`  ${checked} checked, ${Object.keys(accepted).length} accepted, ${review.length} to review`);
    }
  }

  // overrides win
  for (const [ticker, meta] of Object.entries(overrides.alwaysInclude || {})) {
    accepted[ticker] = Object.assign({ matchConfidence: 'override' }, meta);
  }

  log(`\n  accepted: ${Object.keys(accepted).length}   needs review: ${review.length}\n`);

  log('Step 4/4  Scoring and writing output');
  const ranked = Object.entries(accepted)
    .map(([ticker, meta]) => {
      const c = meta._counts || { total: 0, phase3: 0, phase2: 0 };
      return [ticker, { ...meta, score: scoreCompany(c), activeTrials: c.total, phase3: c.phase3, phase2: c.phase2 }];
    })
    .sort((a, b) => b[1].score - a[1].score);

  const out = { tickers: {} };
  out._comment = 'GENERATED by scripts/discover.js - do not hand-edit. '
    + 'Use data/overrides.json to force a ticker in or out. '
    + 'sponsorQuery is the exact lead sponsor string from ClinicalTrials.gov.';
  out._generatedAt = new Date().toISOString();
  out._sourceSponsors = sponsors.length;

  for (const [ticker, meta] of ranked) {
    const { _counts, ...clean } = meta;
    out.tickers[ticker] = clean;
  }

  if (DRY_RUN) {
    log('\n--dry-run: nothing written.\n');
  } else {
    if (fs.existsSync(OUT_TICKERS)) {
      fs.copyFileSync(OUT_TICKERS, OUT_TICKERS + '.bak');
      log(`  previous tickers.json backed up to tickers.json.bak`);
    }
    fs.writeFileSync(OUT_TICKERS, JSON.stringify(out, null, 2));
    fs.writeFileSync(OUT_REVIEW, JSON.stringify({
      generatedAt: new Date().toISOString(),
      acceptedCount: ranked.length,
      reviewCount: review.length,
      review: review.slice(0, 400),
    }, null, 2));
    log(`  wrote data/tickers.json (${ranked.length} tickers)`);
    log(`  wrote data/discovery-review.json (${review.length} entries)`);
  }

  log('\n' + '='.repeat(64));
  log('Top 15 by trial activity:');
  for (const [t, m] of ranked.slice(0, 15)) {
    log(`  ${t.padEnd(6)} ${String(m.score).padStart(4)}  P3:${String(m.phase3).padStart(3)} P2:${String(m.phase2).padStart(3)}  ${m.name.slice(0, 40)}`);
  }
  log('='.repeat(64));
  if (review.length) {
    log(`\n${review.length} sponsors need review - see data/discovery-review.json`);
    log('Most are private companies with no ticker, which is expected.');
  }
}

main().catch(e => { console.error('\nDiscovery failed:', e.message); process.exit(1); });
