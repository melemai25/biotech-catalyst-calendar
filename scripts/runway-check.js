#!/usr/bin/env node
/**
 * Compares the runway the site shows NOW with what the fixed xbrl.js computes
 * from the same SEC data, and shows which tag and period each figure came
 * from. Writes nothing — run it before rebuilding to see what will change.
 *
 *   node scripts/runway-check.js                 every ticker currently on the
 *                                                "Event after cash runs out" list
 *   node scripts/runway-check.js RARE GERN XNCR  just these
 *
 * Uses the same EDGAR contact string as the build (EDGAR_USER_AGENT or
 * data/config.json). Safe to delete once you are happy with the numbers.
 */

const fs = require('fs');
const path = require('path');
const edgar = require('./edgar.js');
const xbrl = require('./xbrl.js');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'public', 'data');
const TODAY = new Date().toISOString().slice(0, 10);

const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const index = read(path.join(DATA, 'index.json'));
const events = (read(path.join(DATA, 'events.json')) || {}).events || [];
const tickerFile = read(path.join(ROOT, 'data', 'tickers.json')) || { tickers: {} };

const $m = (v) => v === null || v === undefined ? '—'
  : (Math.abs(v) >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B' : '$' + (v / 1e6).toFixed(1) + 'M');
const pad = (s, n) => String(s).padEnd(n);
const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

/* The rule the site uses today, and the fixed one. */
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function oldGap(e, m) {
  if (!m || m.runwayMonths === null || m.runwayMonths === undefined) return false;
  const d = days(TODAY, e.date);
  return d > 0 && d > m.runwayMonths * 30;
}
function newGap(e, m) {
  if (!m || m.runwayMonths === null || m.runwayMonths === undefined) return false;
  if (e.type === 'Earnings' || days(TODAY, e.date) <= 0) return false;
  const out = m.cashOutDate || (m.cashAsOf ? addDays(m.cashAsOf, Math.round(m.runwayMonths * 30.4375)) : null);
  return out ? e.date > out : false;
}

function upcomingFor(t) {
  return events.filter(e => e.ticker === t && e.status === 'upcoming');
}

async function main() {
  if (!index) {
    console.error('public/data/index.json not found — run from the repo root after a build.');
    process.exit(1);
  }
  const ua = edgar.getUserAgent();
  if (!ua) {
    console.error('No EDGAR contact string set (EDGAR_USER_AGENT or data/config.json).');
    process.exit(1);
  }

  let tickers = process.argv.slice(2).map(s => s.toUpperCase());
  if (!tickers.length) {
    tickers = Object.keys(index.tickers).filter(t =>
      upcomingFor(t).some(e => oldGap(e, (index.tickers[t] || {}).metrics)));
    console.log(`${tickers.length} ticker(s) are on the "Event after cash runs out" list today.\n`);
  }

  let tickerMap = null;
  const cikOf = async (t) => {
    const meta = tickerFile.tickers[t] || {};
    if (meta.cik) return String(meta.cik).padStart(10, '0');
    if (!tickerMap) tickerMap = await edgar.fetchTickerMap(ua);
    return (tickerMap[t] || {}).cik || null;
  };

  const summary = { before: 0, after: 0, left: [], stayed: [], lapsed: [], noData: [], financed: [] };

  for (const t of tickers) {
    const before = ((index.tickers[t] || {}).metrics) || {};
    const cik = await cikOf(t);
    if (!cik) { console.log(`${t}: no CIK found\n`); summary.noData.push(t); continue; }

    let facts;
    try { facts = await xbrl.fetchCompanyFacts(cik, ua); }
    catch (e) { console.log(`${t}: ${e.message}\n`); summary.noData.push(t); continue; }
    if (!facts) { console.log(`${t}: no XBRL facts\n`); summary.noData.push(t); continue; }

    const after = xbrl.computeMetrics(facts, { explain: true });
    const ex = after.explain;
    const up = upcomingFor(t);
    const nb = up.filter(e => oldGap(e, before)).length;
    const na = up.filter(e => newGap(e, after)).length;
    summary.before += nb; summary.after += na;
    if (nb && !na) summary.left.push(t);
    if (na) summary.stayed.push(t);
    if (after.cashOutDate && after.cashOutDate <= TODAY) summary.lapsed.push(`${t} (${after.cashOutDate})`);

    const parts = [
      ex.cash && `cash ${$m(ex.cash.value)}`,
      ex.shortTermInvestments && `current securities ${$m(ex.shortTermInvestments.value)}`,
      ex.longTermInvestments && `long-dated ${$m(ex.longTermInvestments.value)}`,
    ].filter(Boolean).join(' + ');

    console.log(`${t}  ${facts.entityName || ''}`);
    console.log(`  ${pad('', 20)}${pad('site now', 34)}after fix`);
    console.log(`  ${pad('Cash & investments', 20)}${pad($m(before.totalCashUsd) + (before.cashAsOf ? '  ' + before.cashAsOf : ''), 34)}${$m(after.totalCashUsd)}  ${after.cashAsOf || ''}`);
    console.log(`  ${pad('', 20)}${pad('', 34)}= ${parts || '—'}`);
    console.log(`  ${pad('Quarterly burn', 20)}${pad($m(before.quarterlyBurnUsd) + '  ' + (before.burnPeriod || ''), 34)}${$m(after.quarterlyBurnUsd)}  ${after.burnPeriod || ''}${after.burnBasis ? ' · ' + after.burnBasis : ''}`);
    console.log(`  ${pad('Runway', 20)}${pad(before.runwayMonths != null ? before.runwayMonths + ' mo' : before.cashStatus || '—', 34)}${after.runwayMonths != null ? after.runwayMonths + ' mo, cash out ~' + after.cashOutDate : after.cashStatus}`);
    console.log(`  ${pad('Gap-list events', 20)}${pad(nb, 34)}${na}`);

    // Every investments tag the company has ever used, newest date first —
    // shows at a glance whether a tag switch is what the old code tripped on.
    const seen = [];
    for (const key of ['shortTermInvestments', 'longTermInvestments', 'cashAndShortTermInvestments']) {
      for (const f of xbrl.allFactsFor(facts, xbrl.tagsFor(key))) {
        const newest = f.facts.find(x => !x.start) || f.facts[0];
        seen.push(`${f.tag} ${newest.end} ${$m(newest.val)}`);
      }
    }
    console.log(`  investment tags on file:${seen.length ? '\n    ' + seen.join('\n    ') : ' none'}`);
    console.log(`  burn tag: ${ex.operatingCashFlow ? ex.operatingCashFlow.tag : '—'}`);

    // Anything on the same balance sheet that LOOKS like money but is not in
    // the lists above — catches a deposits or financial-assets tag we have
    // never seen, which is how foreign filers usually go missing.
    const known = new Set(['cash', 'shortTermInvestments', 'longTermInvestments', 'cashAndShortTermInvestments']
      .flatMap(k => xbrl.tagsFor(k)));
    const extra = [];
    for (const tax of ['us-gaap', 'ifrs-full']) {
      for (const [tag, entry] of Object.entries((facts.facts || {})[tax] || {})) {
        if (known.has(tag) || !/deposit|invest|financialasset|securit/i.test(tag)) continue;
        for (const list of Object.values(entry.units || {})) {
          const f = list.find(x => !x.start && x.end === after.cashAsOf);
          if (f) { extra.push(`${tax}:${tag} ${$m(f.val)}`); break; }
        }
      }
    }
    console.log(`  other money-like tags on ${after.cashAsOf || '—'}:${extra.length ? '\n    ' + extra.join('\n    ') : ' none'}`);
    console.log(`  reporting currency: ${after.reportingCurrency || '—'}`);

    // Financing filed after the balance sheet — what the site will now flag.
    let fin = [];
    try {
      const r = await edgar.fetchCompanyEvents(t, cik, TODAY, ua);
      fin = edgar.financingSince(r.financings, after.cashAsOf, 10);
    } catch (e) { console.log(`  financing check failed: ${e.message}`); }
    if (fin.length) summary.financed.push(t);
    console.log(`  financing filed after ${after.cashAsOf || '—'}:${fin.length
      ? '\n    ' + fin.map(f => `${f.date}  ${f.form}  ${f.label}\n      ${f.url}`).join('\n    ')
      : ' none'}\n`);
  }

  console.log('='.repeat(64));
  console.log(`Gap-list rows for these tickers: ${summary.before} now -> ${summary.after} after the fix`);
  console.log('(after also drops earnings rows, which the new filter leaves out)');
  if (summary.left.length) console.log(`Leave the list: ${summary.left.join(', ')}`);
  if (summary.stayed.length) console.log(`Still on it:    ${summary.stayed.join(', ')}`);
  if (summary.lapsed.length) console.log(`Cash-out date already passed (check for financing since): ${summary.lapsed.join(', ')}`);
  if (summary.financed.length) console.log(`Financing filed since their cash figure: ${summary.financed.join(', ')}`);
  if (summary.noData.length) console.log(`Not checked:    ${summary.noData.join(', ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
