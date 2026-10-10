#!/usr/bin/env node
/**
 * SEC XBRL CompanyFacts ingestion — free, keyless, public domain.
 *
 * Produces the financial metrics that matter for biotech:
 *   cash, burn, RUNWAY, free cash flow, revenue, R&D, dilution rate.
 *
 * Two traps this module handles, both of which silently corrupt runway:
 *
 *  1. Operating cash flow in a 10-Q is usually CUMULATIVE year-to-date.
 *     A Q3 figure is often nine months of burn, not three. We only accept
 *     facts spanning ~90 days; a YTD figure is differenced instead.
 *
 *  2. Runway is meaningless for profitable companies. If operating cash flow
 *     is positive we report `cash-generating` rather than a nonsense number.
 */

const COMPANYFACTS = (cik) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;

const REQUEST_GAP_MS = 125;   // 8/sec, under the SEC's 10/sec ceiling
const MAX_RETRIES = 3;
// Facts older than this are ignored for flow metrics: a burn rate from years
// ago produces a confidently wrong runway, which is worse than no runway.
const MAX_FACT_AGE_DAYS = 550;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Foreign private issuers report under IFRS, not US-GAAP, so their facts live
 * in the `ifrs-full` taxonomy under different tag names. Without these every
 * foreign company returns no financial data at all.
 */
const IFRS_TAGS = {
  cash: ['CashAndCashEquivalents'],
  shortTermInvestments: ['OtherCurrentFinancialAssets', 'CurrentInvestments'],
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

/* Companies tag the same concept differently. Tried in order of preference. */
const TAGS = {
  // Balance sheet (point in time)
  cash: [
    'CashAndCashEquivalentsAtCarryingValue',
    'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
  ],
  shortTermInvestments: [
    'MarketableSecuritiesCurrent',
    'ShortTermInvestments',
    'AvailableForSaleSecuritiesDebtSecuritiesCurrent',
  ],
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

/**
 * All facts for the first tag that exists, newest first.
 * Searches us-gaap then ifrs-full unless a taxonomy is named, so domestic and
 * foreign filers both resolve. `unit` carries the reporting currency, which is
 * not always USD for foreign issuers.
 */
function factsFor(companyFacts, tagList, taxonomy = null) {
  const taxonomies = taxonomy ? [taxonomy] : ['us-gaap', 'ifrs-full'];
  for (const tax of taxonomies) {
    const bucket = ((companyFacts.facts || {})[tax]) || {};
    for (const tag of tagList) {
      const entry = bucket[tag];
      if (!entry || !entry.units) continue;
      const unitKey = Object.keys(entry.units).find(k => k === 'USD')
                   || Object.keys(entry.units).find(k => k === 'shares')
                   || Object.keys(entry.units)[0];
      if (!unitKey) continue;
      const facts = entry.units[unitKey]
        .filter(f => f.end && typeof f.val === 'number')
        .sort((a, b) => b.end.localeCompare(a.end));
      if (facts.length) return { tag, unit: unitKey, taxonomy: tax, facts };
    }
  }
  return null;
}

/** Concatenates the US-GAAP and IFRS candidates for a concept. */
function tagsFor(key) {
  return [...(TAGS[key] || []), ...(IFRS_TAGS[key] || [])];
}

/** Most recent point-in-time value (balance sheet items have no start date). */
function latestInstant(companyFacts, tagList, taxonomy = null) {
  const found = factsFor(companyFacts, tagList, taxonomy);
  if (!found) return null;
  const oldest = Date.now() - MAX_FACT_AGE_DAYS * 86400000;
  const fresh = found.facts.filter(x => new Date(x.end).getTime() >= oldest);
  const pool = fresh.length ? fresh : [];
  const f = pool.find(x => !x.start) || pool[0];
  return f ? { value: f.val, end: f.end, tag: found.tag, stale: false } : null;
}

/**
 * Most recent value covering roughly ONE QUARTER.
 * This is the YTD guard: a fact spanning 180 or 270 days is cumulative and is
 * rejected, because treating it as a quarter overstates runway 2-3x.
 */
function latestQuarterlyDuration(companyFacts, tagList, minDays = 60, maxDays = 115) {
  const found = factsFor(companyFacts, tagList);
  if (!found) return null;
  const oldest = Date.now() - MAX_FACT_AGE_DAYS * 86400000;
  for (const f of found.facts) {
    if (!f.start || !f.end) continue;
    // A burn rate from three years ago says nothing about runway today.
    if (new Date(f.end).getTime() < oldest) continue;
    const days = (new Date(f.end) - new Date(f.start)) / 86400000;
    if (days >= minDays && days <= maxDays) {
      return { value: f.val, start: f.start, end: f.end, days: Math.round(days), tag: found.tag };
    }
  }
  return null;
}

/** Differences two cumulative YTD figures when no clean quarterly fact exists. */
function quarterlyFromCumulative(companyFacts, tagList) {
  const found = factsFor(companyFacts, tagList);
  if (!found) return null;
  const oldest = Date.now() - MAX_FACT_AGE_DAYS * 86400000;
  const withRange = found.facts.filter(f =>
    f.start && f.end && f.fy && f.fp && new Date(f.end).getTime() >= oldest);
  const byYear = {};
  for (const f of withRange) (byYear[f.fy] = byYear[f.fy] || []).push(f);

  for (const y of Object.keys(byYear).sort((a, b) => b - a)) {
    const earliestStart = byYear[y].reduce((min, x) => x.start < min ? x.start : min, '9999');
    const list = byYear[y].filter(f => f.start === earliestStart)
                          .sort((a, b) => b.end.localeCompare(a.end));
    if (list.length >= 2) {
      const [newer, older] = list;
      const days = (new Date(newer.end) - new Date(older.end)) / 86400000;
      if (days >= 60 && days <= 115) {
        return {
          value: newer.val - older.val,
          start: older.end, end: newer.end,
          days: Math.round(days), tag: found.tag, derived: true,
        };
      }
    }
  }
  return null;
}

/**
 * A quarter-equivalent value, normalising longer periods rather than
 * discarding them. Many foreign issuers report only half-yearly or annually,
 * so insisting on a true quarter leaves them with no burn rate at all.
 * `periodDays` and `scaled` record what was actually used.
 */
function quarterly(companyFacts, tagList) {
  const clean = latestQuarterlyDuration(companyFacts, tagList);
  if (clean) return { ...clean, scaled: false, basis: 'quarter' };

  const diffed = quarterlyFromCumulative(companyFacts, tagList);
  if (diffed) return { ...diffed, scaled: false, basis: 'quarter (differenced)' };

  // Half-year: scale to a quarter.
  const half = latestQuarterlyDuration(companyFacts, tagList, 150, 200);
  if (half) {
    return { ...half, value: half.value / 2, scaled: true, basis: 'half-year / 2' };
  }
  // Nine months.
  const nine = latestQuarterlyDuration(companyFacts, tagList, 240, 290);
  if (nine) {
    return { ...nine, value: nine.value / 3, scaled: true, basis: 'nine months / 3' };
  }
  // Full year.
  const year = latestQuarterlyDuration(companyFacts, tagList, 330, 400);
  if (year) {
    return { ...year, value: year.value / 4, scaled: true, basis: 'full year / 4' };
  }
  return null;
}

/** Trailing twelve months: sum of the last four distinct quarters. */
function ttm(companyFacts, tagList) {
  const found = factsFor(companyFacts, tagList);
  if (!found) return null;
  const quarters = found.facts.filter(f => {
    if (!f.start || !f.end) return false;
    const days = (new Date(f.end) - new Date(f.start)) / 86400000;
    return days >= 60 && days <= 115;
  });
  const seen = new Set();
  const picked = [];
  for (const f of quarters) {
    if (seen.has(f.end)) continue;
    seen.add(f.end);
    picked.push(f);
    if (picked.length === 4) break;
  }
  if (picked.length < 4) return null;
  return { value: picked.reduce((s, f) => s + f.val, 0), through: picked[0].end, quarters: 4 };
}

/** Year-over-year change in shares outstanding — the dilution signal. */
function dilutionRate(companyFacts) {
  let found = factsFor(companyFacts, ['EntityCommonStockSharesOutstanding'], 'dei');
  if (!found) found = factsFor(companyFacts, ['CommonStockSharesOutstanding', 'CommonStockSharesIssued']);
  if (!found || found.facts.length < 2) return null;

  const newest = found.facts[0];
  const targetDate = new Date(new Date(newest.end).getTime() - 365 * 86400000);
  // Closest fact to one year before the newest.
  let best = null, bestGap = Infinity;
  for (const f of found.facts.slice(1)) {
    const gap = Math.abs(new Date(f.end) - targetDate);
    if (gap < bestGap) { bestGap = gap; best = f; }
  }
  // Require the comparison point to be within 120 days of a year ago.
  if (!best || bestGap > 120 * 86400000 || !best.val) return null;

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

/** Builds the metrics object for one company. */
function computeMetrics(companyFacts) {
  if (!companyFacts || !companyFacts.facts) return null;

  // --- balance sheet ---
  const cash = latestInstant(companyFacts, tagsFor('cash'));
  const sti = latestInstant(companyFacts, tagsFor('shortTermInvestments'));
  const debt = latestInstant(companyFacts, tagsFor('longTermDebt'));
  const equity = latestInstant(companyFacts, tagsFor('stockholdersEquity'));
  const deficit = latestInstant(companyFacts, tagsFor('accumulatedDeficit'));

  let shares = latestInstant(companyFacts, ['EntityCommonStockSharesOutstanding'], 'dei');
  if (!shares) shares = latestInstant(companyFacts, ['CommonStockSharesOutstanding']);

  // --- flows ---
  const ocf = quarterly(companyFacts, tagsFor('operatingCashFlow'));
  const capex = quarterly(companyFacts, tagsFor('capex'));
  const rnd = quarterly(companyFacts, tagsFor('researchAndDevelopment'));
  const sga = quarterly(companyFacts, tagsFor('sellingGeneralAdmin'));
  const ni = quarterly(companyFacts, tagsFor('netIncome'));
  const rev = quarterly(companyFacts, tagsFor('revenue'));
  const opInc = quarterly(companyFacts, tagsFor('operatingIncome'));
  const issuance = quarterly(companyFacts, tagsFor('stockIssuanceProceeds'));

  const revTtm = ttm(companyFacts, tagsFor('revenue'));
  const ocfTtm = ttm(companyFacts, tagsFor('operatingCashFlow'));
  const capexTtm = ttm(companyFacts, tagsFor('capex'));

  // Foreign issuers may report in EUR, GBP, DKK etc. Capture it so values are
  // never silently compared across currencies.
  const cashFacts = factsFor(companyFacts, tagsFor('cash'));
  const currency = cashFacts ? cashFacts.unit : null;
  const taxonomy = cashFacts ? cashFacts.taxonomy : null;

  const totalCash = (cash ? cash.value : 0) + (sti ? sti.value : 0);

  // --- free cash flow: OCF minus capex (capex is reported as a positive outflow) ---
  const fcfQuarterly = (ocf && capex) ? ocf.value - Math.abs(capex.value)
                     : ocf ? ocf.value : null;
  const fcfTtm = (ocfTtm && capexTtm) ? ocfTtm.value - Math.abs(capexTtm.value)
               : ocfTtm ? ocfTtm.value : null;

  // --- runway ---
  let runwayMonths = null;
  let cashStatus = 'unknown';
  if (ocf && ocf.value > 0) {
    cashStatus = 'cash-generating';
  } else if (ocf && ocf.value < 0 && totalCash > 0) {
    runwayMonths = round((totalCash / Math.abs(ocf.value)) * 3, 1);
    cashStatus = runwayMonths < 12 ? 'under-12mo'
               : runwayMonths < 24 ? 'under-24mo'
               : 'well-funded';
  } else if (totalCash > 0) {
    cashStatus = 'no-burn-data';
  }

  const dilution = dilutionRate(companyFacts);

  return {
    reportingCurrency: currency,
    taxonomy,
    isUsd: currency === 'USD',

    // balance sheet (values are in reportingCurrency, not necessarily USD)
    cashUsd: cash ? cash.value : null,
    shortTermInvestmentsUsd: sti ? sti.value : null,
    totalCashUsd: totalCash || null,
    cashAsOf: cash ? cash.end : null,
    longTermDebtUsd: debt ? debt.value : null,
    netCashUsd: totalCash ? totalCash - (debt ? debt.value : 0) : null,
    stockholdersEquityUsd: equity ? equity.value : null,
    accumulatedDeficitUsd: deficit ? deficit.value : null,

    // burn and runway
    operatingCashFlowUsd: ocf ? ocf.value : null,
    quarterlyBurnUsd: ocf && ocf.value < 0 ? Math.abs(ocf.value) : null,
    burnPeriod: ocf ? `${ocf.start} to ${ocf.end}` : null,
    burnDerived: ocf ? !!ocf.derived : null,
    burnBasis: ocf ? (ocf.basis || 'quarter') : null,
    burnScaled: ocf ? !!ocf.scaled : null,
    runwayMonths,
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
}

async function fetchMetrics(cik, userAgent) {
  const facts = await secFetch(COMPANYFACTS(cik), userAgent);
  if (!facts) return null;
  const m = computeMetrics(facts);
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
      ? Math.round((new Date(next.date) - new Date(today)) / 86400000)
      : null,
  };
}

module.exports = {
  fetchMetrics,
  computeMetrics,
  trialMetrics,
  // exported for testing
  latestInstant,
  latestQuarterlyDuration,
  quarterlyFromCumulative,
  dilutionRate,
  ttm,
  factsFor,
  TAGS,
};
