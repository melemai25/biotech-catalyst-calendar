#!/usr/bin/env node
/**
 * SEC XBRL CompanyFacts ingestion — free, keyless, public domain.
 *
 * Produces the financial metrics that matter for biotech:
 *   cash, burn, RUNWAY, free cash flow, revenue, R&D, dilution rate.
 *
 * Traps this module handles, every one of which silently corrupts runway:
 *
 *  1. Operating cash flow in a 10-Q is CUMULATIVE year-to-date. A Q2 10-Q
 *     reports six months of burn and no three-month figure at all. The latest
 *     quarter is therefore usually DERIVED (six months minus three), and it
 *     must be preferred over an older quarter that happens to be reported
 *     directly — otherwise every runway in October uses January-to-March burn.
 *
 *  2. Companies change tags over the years. Taking the first tag that exists
 *     and finding it stale must not mean giving up: the next tag may hold this
 *     quarter's figure. Every candidate tag is checked and the newest wins.
 *
 *  3. "Cash" for runway means what companies themselves quote: cash, cash
 *     equivalents and marketable securities — including the long-dated ones.
 *     All components are taken from the SAME balance sheet date, so a stale
 *     investments figure is never added to this quarter's cash.
 *
 *  4. Runway is meaningless for cash-generating companies. If operating cash
 *     flow is positive we report `cash-generating` rather than a number.
 *
 *  5. Runway counts from the balance sheet date, not from today. `cashOutDate`
 *     carries that, so nothing downstream has to remember it.
 */

const COMPANYFACTS = (cik) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;

const REQUEST_GAP_MS = 125;   // 8/sec, under the SEC's 10/sec ceiling
const MAX_RETRIES = 3;
// Facts older than this are ignored: a burn rate or cash figure from years ago
// produces a confidently wrong runway, which is worse than no runway.
const MAX_FACT_AGE_DAYS = 550;
const DAY_MS = 86400000;
const DAYS_PER_MONTH = 30.4375;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Foreign private issuers report under IFRS, not US-GAAP, so their facts live
 * in the `ifrs-full` taxonomy under different tag names. Without these every
 * foreign company returns no financial data at all.
 */
const IFRS_TAGS = {
  cash: ['CashAndCashEquivalents'],
  // Term deposits are where foreign biotechs usually keep most of their money
  // (AC Immune, MediWound). Note the IFRS spelling: "Shortterm", one word.
  // Not ...ClassifiedAsCashEquivalents — those are already inside cash.
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

/*
 * Companies tag the same concept differently. Order is the tie-break when two
 * tags report the same date; otherwise the tag with the NEWEST fact wins.
 */
const TAGS = {
  // Balance sheet (point in time)
  cash: [
    'CashAndCashEquivalentsAtCarryingValue',
    'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
  ],
  // One of these is used per balance sheet — never two added together, since
  // several describe the same securities.
  shortTermInvestments: [
    'MarketableSecuritiesCurrent',
    'ShortTermInvestments',
    'AvailableForSaleSecuritiesDebtSecuritiesCurrent',
    'DebtSecuritiesAvailableForSaleExcludingAccruedInterestCurrent',
    'AvailableForSaleSecuritiesCurrent',
    'HeldToMaturitySecuritiesCurrent',
    'DebtSecuritiesCurrent',              // Xencor
    // Unclassified. Last, because a few filers use it for a total; Edgewise
    // uses it for the current line.
    'MarketableSecurities',
  ],
  // Long-dated marketable securities. Biotechs commonly hold a third or more
  // of their money here and include it when they quote their own runway.
  // Deliberately NOT `LongTermInvestments`, which often holds equity stakes in
  // private companies that cannot be sold to fund a trial.
  longTermInvestments: [
    'MarketableSecuritiesNoncurrent',
    'AvailableForSaleSecuritiesDebtSecuritiesNoncurrent',
    'DebtSecuritiesAvailableForSaleExcludingAccruedInterestNoncurrent',
    'AvailableForSaleSecuritiesNoncurrent',
    'HeldToMaturitySecuritiesNoncurrent',
    'DebtSecuritiesNoncurrent',           // Xencor
  ],
  // Some filers tag only the combined line.
  cashAndShortTermInvestments: ['CashCashEquivalentsAndShortTermInvestments'],
  longTermDebt: ['LongTermDebtNoncurrent', 'LongTermDebt'],
  totalAssets: ['Assets'],
  stockholdersEquity: ['StockholdersEquity'],
  accumulatedDeficit: ['RetainedEarningsAccumulatedDeficit'],

  // Income statement (period)
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

  // Cash flow (period)
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

/* ------------------------------------------------------------------ dates */

const isoToday = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => (new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / DAY_MS;
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Oldest fact end date still considered current. */
function cutoffFor(opts = {}) {
  return opts.cutoff || addDays(opts.today || isoToday(), -MAX_FACT_AGE_DAYS);
}

/* ------------------------------------------------------------------ fetch */

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
    if (res.status === 404) return null;   // plenty of filers have no XBRL facts
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

/* ------------------------------------------------------------- tag lookup */

function unitOf(entry) {
  const keys = Object.keys(entry.units || {});
  return keys.find(k => k === 'USD') || keys.find(k => k === 'shares') || keys[0] || null;
}

function sortFacts(facts) {
  // Newest period first; for the same period, the most recently filed first,
  // so a restated figure beats the original.
  return facts
    .filter(f => f.end && typeof f.val === 'number')
    .sort((a, b) => b.end.localeCompare(a.end) || (b.filed || '').localeCompare(a.filed || ''));
}

/**
 * EVERY tag in the list that has facts, in list order. us-gaap before
 * ifrs-full unless a taxonomy is named. `unit` carries the reporting
 * currency, which is not always USD for foreign issuers.
 */
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

/** The first tag that has any facts. Used where recency does not matter. */
function factsFor(companyFacts, tagList, taxonomy = null) {
  return allFactsFor(companyFacts, tagList, taxonomy)[0] || null;
}

/** Concatenates the US-GAAP and IFRS candidates for a concept. */
function tagsFor(key) {
  return [...(TAGS[key] || []), ...(IFRS_TAGS[key] || [])];
}

/* ------------------------------------------------------- balance sheet */

/**
 * Most recent point-in-time value across ALL candidate tags.
 * The newest date wins; list order breaks ties.
 */
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

/** The value of a balance-sheet concept on one exact date, or null. */
function instantAt(companyFacts, tagList, date, taxonomy = null) {
  if (!date) return null;
  for (const found of allFactsFor(companyFacts, tagList, taxonomy)) {
    const f = found.facts.find(x => !x.start && x.end === date);
    if (f) return { value: f.val, end: f.end, tag: found.tag };
  }
  return null;
}

/* ----------------------------------------------------------------- flows */

/** One fact per (start, end) period, the most recently filed. */
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

/**
 * Every quarter that can be read or derived from one tag's facts, newest
 * first. A quarter is either reported directly (a ~90-day fact) or derived by
 * differencing two cumulative figures that share a start date: six months
 * minus three gives Q2, nine minus six gives Q3, the full year minus nine
 * gives Q4. A directly reported quarter wins when both exist.
 */
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

/*
 * Longer periods scaled to a quarter, for filers that never report one (many
 * foreign issuers file half-yearly or annually). Ranked after real quarters:
 * used only when nothing quarter-length is as recent.
 */
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

/**
 * The most recent quarter-equivalent value for a concept, across every
 * candidate tag. Newest period end wins; then a real quarter beats a derived
 * one beats a scaled one; then tag order.
 */
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

/** Four back-to-back quarters ending at the newest one, or null. */
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

/**
 * Trailing twelve months: four CONSECUTIVE quarters (reported or derived), or
 * the latest full fiscal year when that is as recent. The quarters must join
 * up — four Q1s from four different years are not a year.
 */
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

/** Year-over-year change in shares outstanding — the dilution signal. */
function dilutionRate(companyFacts) {
  let found = factsFor(companyFacts, ['EntityCommonStockSharesOutstanding'], 'dei');
  if (!found) found = factsFor(companyFacts, ['CommonStockSharesOutstanding', 'CommonStockSharesIssued']);
  if (!found || found.facts.length < 2) return null;

  const newest = found.facts[0];
  const targetDate = new Date(new Date(newest.end).getTime() - 365 * DAY_MS);
  // Closest fact to one year before the newest.
  let best = null, bestGap = Infinity;
  for (const f of found.facts.slice(1)) {
    const gap = Math.abs(new Date(f.end) - targetDate);
    if (gap < bestGap) { bestGap = gap; best = f; }
  }
  // Require the comparison point to be within 120 days of a year ago.
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

/**
 * Builds the metrics object for one company.
 *   opts.today    ISO date treated as today (tests pass a fixed one)
 *   opts.explain  also return `explain`: which tag and period each figure
 *                 came from. Off in the build, to keep index.json small.
 */
function computeMetrics(companyFacts, opts = {}) {
  if (!companyFacts || !companyFacts.facts) return null;
  const o = { cutoff: cutoffFor(opts) };

  // --- balance sheet, all read from the same date as the cash ---
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

  // --- flows ---
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

  // Foreign issuers may report in EUR, GBP, DKK etc. Capture it so values are
  // never silently compared across currencies.
  const cashFacts = factsFor(companyFacts, tagsFor('cash'));
  const currency = cash ? cash.unit : cashFacts ? cashFacts.unit : null;
  const taxonomy = cash ? cash.taxonomy : cashFacts ? cashFacts.taxonomy : null;

  // Cash + short-term investments, or the combined line when a filer tags only
  // that. Then long-dated securities on top.
  let liquid = (cash ? cash.value : 0) + (sti ? sti.value : 0);
  if (combined && combined.value > liquid) liquid = combined.value;
  const totalCash = liquid + (lti ? lti.value : 0);

  // --- free cash flow: OCF minus capex (capex is reported as a positive outflow) ---
  const fcfQuarterly = (ocf && capex) ? ocf.value - Math.abs(capex.value)
                     : ocf ? ocf.value : null;
  const fcfTtm = (ocfTtm && capexTtm) ? ocfTtm.value - Math.abs(capexTtm.value)
               : ocfTtm ? ocfTtm.value : null;

  // --- runway, counted from the balance sheet date ---
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

    // balance sheet (values are in reportingCurrency, not necessarily USD)
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

    // needs a price source the SEC does not publish
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

/** Trial-derived metrics, computed from events already in hand. */
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
  // exported for testing and scripts/runway-check.js
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
