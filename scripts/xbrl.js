#!/usr/bin/env node
/*
 * SEC XBRL companyfacts -> cash, burn, runway, FCF, revenue, R&D, dilution.
 *
 * Gotchas:
 *  - 10-Q cash flow is year-to-date. Q2 only has a 6 month number, so the latest
 *    quarter is usually 6mo minus 3mo. Prefer that over an older reported quarter.
 *  - Companies switch tags over time. Check every candidate tag, newest wins.
 *  - Cash = cash + short and long term marketable securities, all from the same
 *    balance sheet date.
 *  - Positive operating cash flow = 'cash-generating', no runway.
 *  - Runway counts from the balance sheet date (cashOutDate), not today.
 */

const COMPANYFACTS = (cik) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;

const REQUEST_GAP_MS = 125;   // 8/sec
const MAX_RETRIES = 3;
// ignore facts older than this, stale numbers give a confidently wrong runway
const MAX_FACT_AGE_DAYS = 550;
const DAY_MS = 86400000;
const DAYS_PER_MONTH = 30.4375;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// IFRS tag names for foreign filers
const IFRS_TAGS = {
  cash: ['CashAndCashEquivalents'],
  // term deposits, where foreign biotechs keep most of their cash (ACIU, MDWD).
  // IFRS spells it 'Shortterm'. skip ...ClassifiedAsCashEquivalents, already in cash
  shortTermInvestments: [
    'ShorttermDepositsNotClassifiedAsCashEquivalents',
    'OtherCurrentFinancialAssets',
    'CurrentInvestments',
  ],
  longTermDebt: ['NoncurrentPortionOfNoncurrentBorrowings', 'Borrowings'],
  totalAssets: ['Assets'],
  stockholdersEquity: ['Equity', 'EquityAttributableToOwnersOfParent'],
  accumulatedDeficit: ['RetainedEarnings'],
  revenue: ['Revenue', 'RevenueFromContractsWithCustomers'],
  researchAndDevelopment: ['ResearchAndDevelopmentExpense'],
  sellingGeneralAdmin: ['SellingGeneralAndAdministrativeExpense', 'AdministrativeExpense'],
  operatingIncome: ['ProfitLossFromOperatingActivities'],
  netIncome: ['ProfitLoss'],
  epsDiluted: ['DilutedEarningsLossPerShare'],
  operatingCashFlow: ['CashFlowsFromUsedInOperatingActivities'],
  capex: ['PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities'],
  stockIssuanceProceeds: ['ProceedsFromIssuingShares'],
};

// same concept, different tags. newest fact wins, list order breaks ties
const TAGS = {
  // balance sheet
  cash: [
    'CashAndCashEquivalentsAtCarryingValue',
    'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
  ],
  // only one of these is used, several overlap
  shortTermInvestments: [
    'MarketableSecuritiesCurrent',
    'ShortTermInvestments',
    'AvailableForSaleSecuritiesDebtSecuritiesCurrent',
    'DebtSecuritiesAvailableForSaleExcludingAccruedInterestCurrent',
    'AvailableForSaleSecuritiesCurrent',
    'HeldToMaturitySecuritiesCurrent',
    'DebtSecuritiesCurrent',              // Xencor
    // unclassified, keep last (some filers use it for a total). Edgewise uses it
    'MarketableSecurities',
  ],
  // long term marketable securities. not LongTermInvestments, that's usually
  // private equity stakes
  longTermInvestments: [
    'MarketableSecuritiesNoncurrent',
    'AvailableForSaleSecuritiesDebtSecuritiesNoncurrent',
    'DebtSecuritiesAvailableForSaleExcludingAccruedInterestNoncurrent',
    'AvailableForSaleSecuritiesNoncurrent',
    'HeldToMaturitySecuritiesNoncurrent',
    'DebtSecuritiesNoncurrent',           // Xencor
  ],
  // some filers only tag the combined line
  cashAndShortTermInvestments: ['CashCashEquivalentsAndShortTermInvestments'],
  longTermDebt: ['LongTermDebtNoncurrent', 'LongTermDebt'],
  totalAssets: ['Assets'],
  stockholdersEquity: ['StockholdersEquity'],
  accumulatedDeficit: ['RetainedEarningsAccumulatedDeficit'],

  // income statement
  revenue: [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
    'SalesRevenueNet',
  ],
  researchAndDevelopment: ['ResearchAndDevelopmentExpense'],
  sellingGeneralAdmin: ['SellingGeneralAndAdministrativeExpense', 'GeneralAndAdministrativeExpense'],
  operatingIncome: ['OperatingIncomeLoss'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss'],
  epsDiluted: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'],

  // cash flow
  operatingCashFlow: [
    'NetCashProvidedByUsedInOperatingActivities',
    'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
  ],
  capex: [
    'PaymentsToAcquirePropertyPlantAndEquipment',
    'PaymentsToAcquireProductiveAssets',
  ],
  stockIssuanceProceeds: [
    'ProceedsFromIssuanceOfCommonStock',
    'ProceedsFromIssuanceOrSaleOfEquity',
  ],
};

/* dates */

const isoToday = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => (new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / DAY_MS;
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function cutoffFor(opts = {}) {
  return opts.cutoff || addDays(opts.today || isoToday(), -MAX_FACT_AGE_DAYS);
}

/* fetch */

async function secFetch(url, userAgent) {
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': userAgent,
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
      });
    } catch (e) {
      lastErr = e;
      await sleep(600 * (attempt + 1));
      continue;
    }
    if (res.status === 404) return null;
    if (res.status === 403) {
      throw new Error('HTTP 403 - SEC rejected the request (User-Agent missing, or IP rate-limited)');
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`HTTP ${res.status}`);
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await sleep(REQUEST_GAP_MS);
    return res.json();
  }
  throw lastErr || new Error('request failed');
}

/* tag lookup */

function unitOf(entry) {
  const keys = Object.keys(entry.units || {});
  return keys.find(k => k === 'USD') || keys.find(k => k === 'shares') || keys[0] || null;
}

function sortFacts(facts) {
  // newest first, latest filing first (restatements win)
  return facts
    .filter(f => f.end && typeof f.val === 'number')
    .sort((a, b) => b.end.localeCompare(a.end) || (b.filed || '').localeCompare(a.filed || ''));
}

// every matching tag, not just the first
function allFactsFor(companyFacts, tagList, taxonomy = null) {
  const out = [];
  const taxonomies = taxonomy ? [taxonomy] : ['us-gaap', 'ifrs-full'];
  for (const tax of taxonomies) {
    const bucket = ((companyFacts.facts || {})[tax]) || {};
    for (const tag of tagList) {
      const entry = bucket[tag];
      if (!entry || !entry.units) continue;
      const unit = unitOf(entry);
      if (!unit) continue;
      const facts = sortFacts(entry.units[unit]);
      if (facts.length) out.push({ tag, unit, taxonomy: tax, facts });
    }
  }
  return out;
}

function factsFor(companyFacts, tagList, taxonomy = null) {
  return allFactsFor(companyFacts, tagList, taxonomy)[0] || null;
}

function tagsFor(key) {
  return [...(TAGS[key] || []), ...(IFRS_TAGS[key] || [])];
}

/* balance sheet */

// newest value across all candidate tags
function latestInstant(companyFacts, tagList, taxonomy = null, opts = {}) {
  const cutoff = cutoffFor(opts);
  let best = null;
  for (const found of allFactsFor(companyFacts, tagList, taxonomy)) {
    const fresh = found.facts.filter(x => x.end >= cutoff);
    const f = fresh.find(x => !x.start) || fresh[0];
    if (f && (!best || f.end > best.end)) {
      best = { value: f.val, end: f.end, tag: found.tag, unit: found.unit, taxonomy: found.taxonomy };
    }
  }
  return best;
}

// value on an exact date
function instantAt(companyFacts, tagList, date, taxonomy = null) {
  if (!date) return null;
  for (const found of allFactsFor(companyFacts, tagList, taxonomy)) {
    const f = found.facts.find(x => !x.start && x.end === date);
    if (f) return { value: f.val, end: f.end, tag: found.tag };
  }
  return null;
}

/* flows */

// dedupe by period, keep the latest filing
function uniqueDurations(facts) {
  const byKey = new Map();
  for (const f of facts) {
    if (!f.start || !f.end || typeof f.val !== 'number') continue;
    const k = f.start + '|' + f.end;
    const prev = byKey.get(k);
    if (!prev || (f.filed || '') > (prev.filed || '')) byKey.set(k, f);
  }
  return [...byKey.values()];
}

const isQuarterLength = (d) => d >= 60 && d <= 115;

// all quarters for one tag: reported ~90 day facts, or derived from YTD figures
// with the same start (6mo-3mo = Q2, 9mo-6mo = Q3, FY-9mo = Q4)
function quarterSeries(facts) {
  const durations = uniqueDurations(facts);
  const quarters = new Map();

  for (const f of durations) {
    const d = daysBetween(f.start, f.end);
    if (!isQuarterLength(d)) continue;
    const prev = quarters.get(f.end);
    if (!prev || Math.abs(d - 91) < Math.abs(prev.days - 91)) {
      quarters.set(f.end, { value: f.val, start: f.start, end: f.end, days: Math.round(d), derived: false });
    }
  }

  const byStart = new Map();
  for (const f of durations) {
    if (!byStart.has(f.start)) byStart.set(f.start, []);
    byStart.get(f.start).push(f);
  }
  for (const list of byStart.values()) {
    list.sort((a, b) => a.end.localeCompare(b.end));
    for (let i = 1; i < list.length; i++) {
      const older = list[i - 1], newer = list[i];
      const d = daysBetween(older.end, newer.end);
      if (!isQuarterLength(d) || quarters.has(newer.end)) continue;
      quarters.set(newer.end, {
        value: newer.val - older.val,
        start: addDays(older.end, 1), end: newer.end,
        days: Math.round(d), derived: true,
      });
    }
  }
  return [...quarters.values()].sort((a, b) => b.end.localeCompare(a.end));
}

// fallback for filers with no quarters (half-year / annual), scaled down
const SCALED = [
  { min: 150, max: 200, div: 2, basis: 'half-year / 2' },
  { min: 240, max: 290, div: 3, basis: 'nine months / 3' },
  { min: 330, max: 400, div: 4, basis: 'full year / 4' },
];

function quarterCandidates(facts, cutoff) {
  const out = [];
  const latest = quarterSeries(facts).find(q => q.end >= cutoff);
  if (latest) {
    out.push({ ...latest, scaled: false,
      basis: latest.derived ? 'quarter (differenced)' : 'quarter',
      rank: latest.derived ? 1 : 0 });
  }
  const durations = uniqueDurations(facts)
    .filter(f => f.end >= cutoff)
    .sort((a, b) => b.end.localeCompare(a.end));
  SCALED.forEach((s, i) => {
    const f = durations.find(x => { const d = daysBetween(x.start, x.end); return d >= s.min && d <= s.max; });
    if (f) {
      out.push({ value: f.val / s.div, start: f.start, end: f.end,
        days: Math.round(daysBetween(f.start, f.end)), derived: false,
        scaled: true, basis: s.basis, rank: 2 + i });
    }
  });
  return out;
}

// latest quarter across tags: newest end date, then reported > derived > scaled
function quarterly(companyFacts, tagList, opts = {}) {
  const cutoff = cutoffFor(opts);
  const all = [];
  allFactsFor(companyFacts, tagList).forEach((found, tagIdx) => {
    for (const c of quarterCandidates(found.facts, cutoff)) all.push({ ...c, tag: found.tag, tagIdx });
  });
  all.sort((a, b) => b.end.localeCompare(a.end) || a.rank - b.rank || a.tagIdx - b.tagIdx);
  if (!all.length) return null;
  const { rank, tagIdx, ...best } = all[0];
  return best;
}

function contiguousYear(series) {
  if (!series.length) return null;
  const run = [series[0]];
  while (run.length < 4) {
    const last = run[run.length - 1];
    const prev = series.find(q => { const g = daysBetween(q.end, last.start); return g >= 0 && g <= 7; });
    if (!prev) return null;
    run.push(prev);
  }
  return run;
}

// TTM = 4 consecutive quarters or the latest full year
function ttm(companyFacts, tagList, opts = {}) {
  const cutoff = cutoffFor(opts);
  const all = [];
  allFactsFor(companyFacts, tagList).forEach((found, tagIdx) => {
    const run = contiguousYear(quarterSeries(found.facts));
    if (run && run[0].end >= cutoff) {
      all.push({ value: run.reduce((s, q) => s + q.value, 0), through: run[0].end,
        quarters: 4, rank: 1, tagIdx });
    }
    const year = uniqueDurations(found.facts)
      .filter(f => f.end >= cutoff)
      .sort((a, b) => b.end.localeCompare(a.end))
      .find(f => { const d = daysBetween(f.start, f.end); return d >= 330 && d <= 400; });
    if (year) all.push({ value: year.val, through: year.end, quarters: 4, rank: 0, tagIdx });
  });
  all.sort((a, b) => b.through.localeCompare(a.through) || a.rank - b.rank || a.tagIdx - b.tagIdx);
  if (!all.length) return null;
  const { rank, tagIdx, ...best } = all[0];
  return best;
}

// share count change over a year
function dilutionRate(companyFacts) {
  let found = factsFor(companyFacts, ['EntityCommonStockSharesOutstanding'], 'dei');
  if (!found) found = factsFor(companyFacts, ['CommonStockSharesOutstanding', 'CommonStockSharesIssued']);
  if (!found || found.facts.length < 2) return null;

  const newest = found.facts[0];
  const targetDate = new Date(new Date(newest.end).getTime() - 365 * DAY_MS);
  let best = null, bestGap = Infinity;
  for (const f of found.facts.slice(1)) {
    const gap = Math.abs(new Date(f.end) - targetDate);
    if (gap < bestGap) { bestGap = gap; best = f; }
  }
  // comparison point has to be within 120 days of a year ago
  if (!best || bestGap > 120 * DAY_MS || !best.val) return null;

  const pct = ((newest.val - best.val) / best.val) * 100;
  return {
    pct: Math.round(pct * 10) / 10,
    from: best.val, to: newest.val,
    fromDate: best.end, toDate: newest.end,
  };
}

function round(n, dp = 1) {
  if (n === null || n === undefined || !isFinite(n)) return null;
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

// opts.today: fixed date for tests. opts.explain: include source tags (debug only)
function computeMetrics(companyFacts, opts = {}) {
  if (!companyFacts || !companyFacts.facts) return null;
  const o = { cutoff: cutoffFor(opts) };

  // balance sheet, everything from the cash date
  const cash = latestInstant(companyFacts, tagsFor('cash'), null, o);
  const asOf = cash ? cash.end : null;
  const sti = instantAt(companyFacts, tagsFor('shortTermInvestments'), asOf);
  const lti = instantAt(companyFacts, tagsFor('longTermInvestments'), asOf);
  const combined = instantAt(companyFacts, tagsFor('cashAndShortTermInvestments'), asOf);
  const sameDateOrLatest = (key) =>
    instantAt(companyFacts, tagsFor(key), asOf) || latestInstant(companyFacts, tagsFor(key), null, o);
  const debt = sameDateOrLatest('longTermDebt');
  const equity = sameDateOrLatest('stockholdersEquity');
  const deficit = sameDateOrLatest('accumulatedDeficit');

  let shares = latestInstant(companyFacts, ['EntityCommonStockSharesOutstanding'], 'dei', o);
  if (!shares) shares = latestInstant(companyFacts, ['CommonStockSharesOutstanding'], null, o);

  // flows
  const ocf = quarterly(companyFacts, tagsFor('operatingCashFlow'), o);
  const capex = quarterly(companyFacts, tagsFor('capex'), o);
  const rnd = quarterly(companyFacts, tagsFor('researchAndDevelopment'), o);
  const sga = quarterly(companyFacts, tagsFor('sellingGeneralAdmin'), o);
  const ni = quarterly(companyFacts, tagsFor('netIncome'), o);
  const rev = quarterly(companyFacts, tagsFor('revenue'), o);
  const opInc = quarterly(companyFacts, tagsFor('operatingIncome'), o);
  const issuance = quarterly(companyFacts, tagsFor('stockIssuanceProceeds'), o);

  const revTtm = ttm(companyFacts, tagsFor('revenue'), o);
  const ocfTtm = ttm(companyFacts, tagsFor('operatingCashFlow'), o);
  const capexTtm = ttm(companyFacts, tagsFor('capex'), o);

  // foreign filers can report in EUR, CHF etc
  const cashFacts = factsFor(companyFacts, tagsFor('cash'));
  const currency = cash ? cash.unit : cashFacts ? cashFacts.unit : null;
  const taxonomy = cash ? cash.taxonomy : cashFacts ? cashFacts.taxonomy : null;

  // cash + ST investments (or the combined line) + LT securities
  let liquid = (cash ? cash.value : 0) + (sti ? sti.value : 0);
  if (combined && combined.value > liquid) liquid = combined.value;
  const totalCash = liquid + (lti ? lti.value : 0);

  // FCF = OCF - capex
  const fcfQuarterly = (ocf && capex) ? ocf.value - Math.abs(capex.value)
                     : ocf ? ocf.value : null;
  const fcfTtm = (ocfTtm && capexTtm) ? ocfTtm.value - Math.abs(capexTtm.value)
               : ocfTtm ? ocfTtm.value : null;

  // runway
  let runwayMonths = null;
  let cashOutDate = null;
  let cashStatus = 'unknown';
  if (ocf && ocf.value > 0) {
    cashStatus = 'cash-generating';
  } else if (ocf && ocf.value < 0 && totalCash > 0) {
    const months = (totalCash / Math.abs(ocf.value)) * 3;
    runwayMonths = round(months, 1);
    cashOutDate = asOf ? addDays(asOf, Math.round(months * DAYS_PER_MONTH)) : null;
    cashStatus = runwayMonths < 12 ? 'under-12mo'
               : runwayMonths < 24 ? 'under-24mo'
               : 'well-funded';
  } else if (totalCash > 0) {
    cashStatus = 'no-burn-data';
  }

  const dilution = dilutionRate(companyFacts);

  const metrics = {
    reportingCurrency: currency,
    taxonomy,
    isUsd: currency === 'USD',

    // balance sheet (in reportingCurrency)
    cashUsd: cash ? cash.value : null,
    shortTermInvestmentsUsd: sti ? sti.value : null,
    longTermInvestmentsUsd: lti ? lti.value : null,
    totalCashUsd: totalCash || null,
    cashAsOf: asOf,
    longTermDebtUsd: debt ? debt.value : null,
    netCashUsd: totalCash ? totalCash - (debt ? debt.value : 0) : null,
    stockholdersEquityUsd: equity ? equity.value : null,
    accumulatedDeficitUsd: deficit ? deficit.value : null,

    // burn and runway
    operatingCashFlowUsd: ocf ? ocf.value : null,
    quarterlyBurnUsd: ocf && ocf.value < 0 ? Math.abs(ocf.value) : null,
    burnPeriod: ocf ? `${ocf.start} to ${ocf.end}` : null,
    burnAsOf: ocf ? ocf.end : null,
    burnDerived: ocf ? !!ocf.derived : null,
    burnBasis: ocf ? (ocf.basis || 'quarter') : null,
    burnScaled: ocf ? !!ocf.scaled : null,
    runwayMonths,
    cashOutDate,
    cashStatus,

    // free cash flow
    capexQuarterlyUsd: capex ? Math.abs(capex.value) : null,
    freeCashFlowQuarterlyUsd: fcfQuarterly,
    freeCashFlowTtmUsd: fcfTtm,

    // income statement
    revenueQuarterlyUsd: rev ? rev.value : null,
    revenueTtmUsd: revTtm ? revTtm.value : null,
    rndQuarterlyUsd: rnd ? rnd.value : null,
    sgaQuarterlyUsd: sga ? sga.value : null,
    operatingIncomeQuarterlyUsd: opInc ? opInc.value : null,
    netIncomeQuarterlyUsd: ni ? ni.value : null,

    // dilution
    sharesOutstanding: shares ? shares.value : null,
    dilutionPctYoy: dilution ? dilution.pct : null,
    dilutionFrom: dilution ? dilution.fromDate : null,
    stockIssuanceQuarterlyUsd: issuance ? issuance.value : null,

    // derived ratios
    cashPerShare: (totalCash && shares && shares.value)
      ? round(totalCash / shares.value, 2) : null,
    rndIntensityPct: (rnd && sga && (rnd.value + sga.value))
      ? round((rnd.value / (rnd.value + sga.value)) * 100, 0) : null,
    fcfMarginPct: (fcfTtm !== null && revTtm && revTtm.value > 0)
      ? round((fcfTtm / revTtm.value) * 100, 1) : null,

    // SEC doesn't publish prices
    marketCapUsd: null,
  };

  if (opts.explain) {
    const src = (x) => x ? { tag: x.tag, value: x.value, end: x.end,
      ...(x.start ? { start: x.start } : {}), ...(x.basis ? { basis: x.basis } : {}) } : null;
    metrics.explain = {
      cash: src(cash), shortTermInvestments: src(sti), longTermInvestments: src(lti),
      combinedCashAndShortTerm: src(combined), operatingCashFlow: src(ocf),
    };
  }
  return metrics;
}

async function fetchCompanyFacts(cik, userAgent) {
  return secFetch(COMPANYFACTS(cik), userAgent);
}

async function fetchMetrics(cik, userAgent, opts = {}) {
  const facts = await fetchCompanyFacts(cik, userAgent);
  if (!facts) return null;
  const m = computeMetrics(facts, opts);
  if (m) m.entityName = facts.entityName || null;
  return m;
}

function trialMetrics(events, today) {
  const registry = events.filter(e => e.origin === 'registry');
  const phaseRank = (p) => {
    if (!p) return 0;
    if (p.includes('4')) return 4;
    if (p.includes('3')) return 3;
    if (p.includes('2')) return 2;
    if (p.includes('1')) return 1;
    return 0;
  };
  const upcoming = events.filter(e => e.status === 'upcoming')
                         .sort((a, b) => a.date.localeCompare(b.date));
  const next = upcoming[0] || null;

  return {
    activeTrials: registry.length,
    phase3Count: registry.filter(e => (e.phase || '').includes('3')).length,
    phase2Count: registry.filter(e => (e.phase || '').includes('2')).length,
    leadPhase: registry.reduce((max, e) => Math.max(max, phaseRank(e.phase)), 0) || null,
    upcomingCount: upcoming.length,
    nextCatalystDate: next ? next.date : null,
    nextCatalystType: next ? next.type : null,
    daysToNextCatalyst: next
      ? Math.round((new Date(next.date) - new Date(today)) / DAY_MS)
      : null,
  };
}

module.exports = {
  fetchMetrics,
  fetchCompanyFacts,
  computeMetrics,
  trialMetrics,
  allFactsFor,
  latestInstant,
  instantAt,
  quarterSeries,
  quarterly,
  dilutionRate,
  ttm,
  factsFor,
  tagsFor,
  TAGS,
};
