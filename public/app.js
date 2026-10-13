/* Catalyst Calendar — reads the static events.json produced by scripts/build-data.js */

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
// Deterministic colour per ticker: same ticker always gets the same hue.
// Muted clinical palette: medium-saturation hues that sit calmly together on
// pale surfaces while staying distinguishable, all carrying white text.
// Weighted toward the blue-green family with a few warm hues for separation.
const TICKER_PALETTE = [
  '#0E8C97', // teal
  '#3A7CC4', // soft blue
  '#2E9E6B', // green
  '#6B74C9', // periwinkle
  '#4A9A8E', // seafoam
  '#C97B5A', // clay
  '#8E7BC0', // lavender
  '#D4635F', // rose
  '#5C8F4A', // sage
  '#2E7A9E', // steel blue
  '#B07CA8', // mauve
  '#C79A3C', // ochre
];
const FIXED_COLORS = { MRNA: '#0E8C97', ILMN: '#3A7CC4' };
function tickerColor(t){
  if (FIXED_COLORS[t]) return FIXED_COLORS[t];
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return TICKER_PALETTE[h % TICKER_PALETTE.length];
}

const state = {
  data: null,
  filters: {},
  showRegistry: true,
  viewMonth: startOfMonth(new Date()),
  selectedDate: null,
  tickerQuery: '',
  watchlist: [],        // tickers the user has added, in order
  hidden: {},           // ticker -> true means loaded but not displayed
  addOpen: false,
  analyzeTicker: null,
  compareWith: [],
  sources: { curated:true, registry:true, edgar:true },
  // Macro lives in its own payload and is fetched only when the tab is opened,
  // so the biotech calendar never waits on it.
  macro: null,
  macroLoading: false,
  macroGroup: 'all',
  macroWindow: 60,
  cache: {},
  loading: false,
  modalDate: null,
  tab: (location.hash.replace('#','') || 'calendar'),
  q: '',
  sortKey: 'date',
  sortDir: 'asc',
  error: null,
};

function startOfMonth(d){ return new Date(d.getFullYear(), d.getMonth(), 1); }
function iso(d){
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
const TODAY_ISO = iso(new Date());

/* ---------- tiny DOM helper ---------- */
function el(tag, attrs, children){
  const n = document.createElement(tag);
  if(attrs) for(const [k,v] of Object.entries(attrs)){
    if(v === null || v === undefined || v === false) continue;
    if(k === 'class') n.className = v;
    else if(k === 'html') n.innerHTML = v;
    else if(k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for(const c of (children||[])){
    if(c === null || c === undefined || c === false) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

/* ---------- data ---------- */
async function loadTicker(t){
  if(state.cache[t]) return;
  try{
    const res = await fetch('data/ticker/' + t + '.json', {cache:'no-cache'});
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    state.cache[t] = d.events || [];
  }catch(err){
    state.cache[t] = [];
    console.warn('Could not load ticker ' + t + ':', err.message);
  }
}

async function ensureLoaded(){
  const need = state.watchlist.filter(t => !state.cache[t]);
  if(!need.length) return;
  state.loading = true; render();
  await Promise.all(need.map(loadTicker));
  state.loading = false;
}

async function load(){
  try{
    // index.json is small: ticker list and counts only.
    let data;
    const res = await fetch('data/index.json', {cache:'no-cache'});
    if(res.ok){
      const idx = await res.json();
      if(idx.tickers && Object.keys(idx.tickers).length){
        data = { generatedDate: idx.generatedDate, tickers: idx.tickers, perTicker: true,
                 counts: { total: idx.totalEvents||0, curated:0, registry:0, edgar:0 } };
      }
    }
    if(!data){
      // Fall back to the combined file if index.json has no ticker map.
      const r2 = await fetch('data/events.json', {cache:'no-cache'});
      if(!r2.ok) throw new Error('Could not load data (HTTP ' + r2.status + ')');
      data = await r2.json();
      data.perTicker = false;
    }
    state.data = data;
    // Precedence: the URL wins (someone followed a link), then a saved
    // watchlist, then the most active tickers as a starting point.
    const known = Object.keys(data.tickers || {});
    const fromUrl = watchlistFromUrl(known);
    if (fromUrl) {
      state.watchlist = fromUrl;
    } else {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem('watchlist') || 'null'); } catch {}
      if (Array.isArray(saved) && saved.length) {
        state.watchlist = saved.filter(t => known.includes(t));
      }
    }
    if (!state.watchlist.length) {
      state.watchlist = rankedTickers(data).slice(0, 2).map(([t]) => t);
    }
  }catch(err){
    state.error = err.message;
    render();
    return;
  }
  if(state.data.perTicker){ await ensureLoaded(); }
  syncUrl();
  render();
}

function visibleEvents(){
  if(!state.data) return [];
  let pool;
  const active = state.watchlist.filter(t => !state.hidden[t]);
  if(state.data.perTicker){
    pool = [];
    for(const t of active) if(state.cache[t]) pool = pool.concat(state.cache[t]);
  } else {
    pool = (state.data.events || []).filter(e => active.includes(e.ticker));
  }
  return pool
    .filter(e => state.sources[e.origin] !== false)
    .sort((a,b) => a.date.localeCompare(b.date));
}

/* ---------- render ---------- */
function render(){
  const root = document.getElementById('root');
  root.textContent = '';
  if(state.error){
    root.appendChild(el('div',{class:'app'},[
      el('div',{class:'panel'},[
        el('div',{class:'panel-head'},['Data unavailable']),
        el('div',{class:'panel-body'},[
          el('p',{class:'about-text'},[state.error]),
          el('p',{class:'about-text'},[
            'If you opened this file directly from your file system, the browser blocks the data fetch. Serve the folder over HTTP instead — see the README for the one-line command.'
          ]),
        ])
      ])
    ]));
    return;
  }
  if(!state.data){
    root.appendChild(el('div',{class:'loading'},['Loading catalyst data…']));
    return;
  }
  // The macro page is market-wide, so a watchlist sidebar would be dead space.
  const wide = state.tab === 'macro';
  root.appendChild(el('div',{class:'app'},[
    masthead(),
    wide
      ? el('div',{class:'layout layout-wide'},[ main() ])
      : el('div',{class:'layout'},[ sidebar(), main() ])
  ]));
}

function masthead(){
  const d = state.data;
  return el('div',{class:'masthead'},[
    el('div',{},[
      el('p',{class:'eyebrow'},['Trial & Regulatory Tracker']),
      el('h1',{},['Biotech ', el('span',{class:'accent'},['Tracker'])]),
    ]),
    el('div',{class:'masthead-right'},[
      el('div',{},[el('span',{class:'dot'}), 'Data built ' + (d.generatedDate || '\u2014')]),
    ]),
  ]);
}

/** Tickers ordered by how much is actually in flight, biggest first. */
function rankedTickers(data){
  return Object.entries(data.tickers || {}).sort((a, b) => {
    const sa = a[1].score ?? a[1].activeTrials ?? (a[1].counts || {}).total ?? 0;
    const sb = b[1].score ?? b[1].activeTrials ?? (b[1].counts || {}).total ?? 0;
    if (sb !== sa) return sb - sa;
    return a[0].localeCompare(b[0]);
  });
}

function saveWatchlist(){
  try { localStorage.setItem('watchlist', JSON.stringify(state.watchlist)); } catch {}
  syncUrl();
}

/**
 * Mirrors the watchlist into ?tickers= so a view can be shared or linked to
 * from a landing page. Sorted alphabetically so the same set always produces
 * the same URL — otherwise click order would fragment analytics and caching.
 * The page carries a canonical tag back to "/" so these never get indexed
 * separately; there is no search demand for a ticker combination.
 */
function syncUrl(){
  try {
    const url = new URL(location.href);
    if (state.watchlist.length) {
      url.searchParams.set('tickers', [...state.watchlist].sort().join(','));
    } else {
      url.searchParams.delete('tickers');
    }
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch {}
}

function watchlistFromUrl(known){
  try {
    const raw = new URL(location.href).searchParams.get('tickers');
    if (!raw) return null;
    const list = raw.split(',').map(t => t.trim().toUpperCase()).filter(t => known.includes(t));
    return list.length ? list : null;
  } catch { return null; }
}

async function addTicker(t){
  if (state.watchlist.includes(t)) return;
  state.watchlist.push(t);
  saveWatchlist();
  render();
  if (state.data.perTicker) { await ensureLoaded(); render(); }
}

function removeTicker(t){
  state.watchlist = state.watchlist.filter(x => x !== t);
  delete state.hidden[t];
  saveWatchlist();
  render();
}

function sidebar(){
  const d = state.data;
  const sb = el('div',{},[]);

  /* ---------------------------- watchlist ---------------------------- */
  sb.appendChild(el('div',{class:'panel'},[
    el('div',{class:'panel-head'},[
      'Watchlist',
      el('span',{class:'head-count'},[String(state.watchlist.length)]),
    ]),
    el('div',{class:'panel-body'},
      state.watchlist.length
        ? state.watchlist.map(t => {
            const meta = (d.tickers || {})[t] || {};
            const shown = !state.hidden[t];
            return el('div',{class:'wl-row' + (shown ? '' : ' off')},[
              el('span',{class:'swatch', style:'background:'+tickerColor(t)}),
              el('span',{class:'wl-ticker'},[t]),
              el('span',{class:'wl-name', title: meta.name || ''},[meta.name || '']),
              el('button',{
                class:'toggle' + (shown ? ' on' : ''), type:'button',
                'aria-pressed': String(shown),
                title: shown ? 'Hide ' + t + ' from the calendar' : 'Show ' + t,
                onclick:()=>{ if(shown) state.hidden[t] = true; else delete state.hidden[t]; render(); }
              }),
              el('button',{
                class:'btn-x', type:'button', title:'Remove ' + t + ' from watchlist',
                'aria-label':'Remove ' + t,
                onclick:()=>removeTicker(t)
              },['\u00d7']),
            ]);
          })
        : [el('div',{class:'empty-note'},['No tickers yet. Add some below.'])]
    )
  ]));

  /* ------------------------------ add -------------------------------- */
  const q = (state.tickerQuery || '').trim().toUpperCase();
  let candidates = rankedTickers(d).filter(([t]) => !state.watchlist.includes(t));
  if (q) {
    candidates = candidates.filter(([t, m]) =>
      t.includes(q) || (m.name || '').toUpperCase().includes(q));
  }
  const total = candidates.length;
  candidates = candidates.slice(0, 60);

  sb.appendChild(el('div',{class:'panel'},[
    el('div',{class:'panel-head'},[
      'Add ticker',
      el('span',{class:'head-count'},[String(total)]),
    ]),
    el('div',{class:'panel-body'},[
      el('input',{
        type:'search', class:'ticker-search', value: state.tickerQuery || '',
        placeholder:'Search, or browse the most active\u2026',
        oninput:(e)=>{
          state.tickerQuery = e.target.value;
          const pos = e.target.selectionStart;
          render();
          const box = document.querySelector('.ticker-search');
          if(box){ box.focus(); box.setSelectionRange(pos, pos); }
        }
      }),
      el('div',{class:'add-list'},
        candidates.length
          ? candidates.map(([t, meta]) =>
              el('button',{class:'add-row', type:'button',
                title:'Add ' + t + ' to watchlist',
                onclick:()=>addTicker(t)},[
                el('span',{class:'swatch', style:'background:'+tickerColor(t)}),
                el('span',{class:'wl-ticker'},[t]),
                el('span',{class:'wl-name'},[meta.name || '']),
                meta.activeTrials
                  ? el('span',{class:'add-meta'},[meta.activeTrials + ' trials'])
                  : null,
                el('span',{class:'btn-plus'},['+']),
              ])
            )
          : [el('div',{class:'empty-note'},[q ? 'No match for "' + q + '".' : 'Nothing left to add.'])]
      ),
      total > 60 ? el('div',{class:'empty-note'},['Showing the top 60 \u2014 search to narrow.']) : null,
    ])
  ]));

  /* ---------------------------- sources ------------------------------ */
  sb.appendChild(el('div',{class:'panel'},[
    el('div',{class:'panel-head'},['Sources']),
    el('div',{class:'panel-body'},[
      ['curated','Curated catalysts'],
      ['registry','ClinicalTrials.gov'],
      ['edgar','SEC EDGAR filings'],
    ].map(([k, label]) =>
      el('label',{class:'checkline'},[
        el('input',{type:'checkbox', checked: state.sources[k] ? 'checked' : null,
          onchange:(e)=>{ state.sources[k] = e.target.checked; render(); }}),
        label
      ])
    ))
  ]));

  /* ---------------------------- next up ------------------------------ */
  const upcoming = visibleEvents().filter(e => e.status === 'upcoming').slice(0, 5);
  if(state.tab !== 'data') sb.appendChild(el('div',{class:'panel'},[
    el('div',{class:'panel-head'},['Next Up']),
    el('div',{class:'panel-body'},
      upcoming.length
        ? upcoming.map(e => el('button',{class:'upcoming-item', type:'button', onclick:()=>goTo(e.date)},[
            el('span',{class:'upcoming-date'},[
              el('span',{class:'swatch', style:'width:7px;height:7px;background:'+tickerColor(e.ticker)}),
              longDate(e.date) + (e.estimated ? ' (est.)' : '')
            ]),
            el('span',{class:'upcoming-title'},[e.title]),
          ]))
        : [el('div',{class:'empty-note'},['Nothing upcoming with these filters.'])]
    )
  ]));

  return sb;
}

function goTo(dateStr){
  const d = new Date(dateStr + 'T00:00:00');
  state.viewMonth = startOfMonth(d);
  state.selectedDate = dateStr;
  render();
}

// Cell ticks need a short, uniform label. Full titles live in the popout.
function shortTitle(e){
  if(e.type === 'Earnings') return e.estimated ? 'Earnings (est.)' : 'Earnings';
  if(e.type === 'Regulatory') return 'FDA decision';
  if(e.type === 'Corporate') return 'Corporate';
  if(e.type === 'Filing') return '8-K filing';
  if(e.type === 'Conference') return 'Conference';
  if(e.phase && e.phase !== 'No phase') return e.phase + ' readout';
  return e.title.length > 22 ? e.title.slice(0,20) + '\u2026' : e.title;
}

function longDate(s){
  const d = new Date(s + 'T00:00:00');
  return MONTHS[d.getMonth()].slice(0,3) + ' ' + d.getDate() + ', ' + d.getFullYear();
}

const TABS = [
  {id:'calendar', label:'Calendar'},
  {id:'analysis', label:'Analysis'},
  {id:'data',     label:'Data'},
  {id:'macro',    label:'Macro'},
];

function tabBar(){
  return el('div',{class:'tabbar'}, TABS.map(t =>
    el('button',{
      class:'tab' + (state.tab === t.id ? ' active' : ''),
      type:'button',
      onclick:()=>{
        state.tab = t.id; location.hash = t.id;
        if(t.id === 'macro') loadMacro();
        render();
      }
    },[t.label])
  ));
}

function main(){
  const kids = [ tabBar() ];
  kids.push(state.tab === 'data' ? dataTab()
          : state.tab === 'analysis' ? analysisTab()
          : state.tab === 'macro' ? macroTab()
          : calendar());
  if(state.modalDate) kids.push(modal());
  return el('div',{}, kids);
}

/* ------------------------------------------------------------ Analysis tab */

const fmtUsd = (v, ccy) => {
  if (v === null || v === undefined) return null;
  const sym = (!ccy || ccy === 'USD') ? '$' : ccy + ' ';
  const a = Math.abs(v);
  if (a >= 1e9) return sym + (v/1e9).toFixed(2) + 'B';
  if (a >= 1e6) return sym + (v/1e6).toFixed(1) + 'M';
  if (a >= 1e3) return sym + (v/1e3).toFixed(0) + 'K';
  return sym + v.toFixed(0);
};
const fmtPct  = v => (v === null || v === undefined) ? null : v + '%';
const fmtNum  = v => (v === null || v === undefined) ? null : v.toLocaleString();
const fmtMo   = v => (v === null || v === undefined) ? null : v + ' mo';

/**
 * Metric rows. `better` drives the comparison highlight: 'high', 'low', or
 * null where there is no good direction (revenue is not "better" than cash).
 */
const METRIC_GROUPS = [
  { group:'Cash position', rows:[
    { key:'totalCashUsd',    label:'Cash & investments', fmt:'usd',  better:'high' },
    { key:'quarterlyBurnUsd',label:'Quarterly burn',     fmt:'usd',  better:'low'  },
    { key:'runwayMonths',    label:'Runway',             fmt:'mo',   better:'high' },
    { key:'netCashUsd',      label:'Net cash after debt',fmt:'usd',  better:'high' },
    { key:'cashPerShare',    label:'Cash per share',     fmt:'raw$', better:'high' },
  ]},
  { group:'Operations', rows:[
    { key:'revenueTtmUsd',        label:'Revenue (TTM)',     fmt:'usd', better:null },
    { key:'freeCashFlowTtmUsd',   label:'Free cash flow TTM',fmt:'usd', better:'high' },
    { key:'rndQuarterlyUsd',      label:'R&D per quarter',   fmt:'usd', better:null },
    { key:'rndIntensityPct',      label:'R&D share of opex', fmt:'pct', better:'high' },
    { key:'netIncomeQuarterlyUsd',label:'Net income (Q)',    fmt:'usd', better:'high' },
  ]},
  { group:'Dilution', rows:[
    { key:'sharesOutstanding', label:'Shares outstanding', fmt:'num', better:null },
    { key:'dilutionPctYoy',    label:'Dilution, 1 yr',     fmt:'pct', better:'low' },
  ]},
  { group:'Pipeline', rows:[
    { key:'activeTrials',      label:'Trials tracked',     fmt:'num', better:'high' },
    { key:'phase3Count',       label:'Phase 3 programs',   fmt:'num', better:'high' },
    { key:'upcomingCount',     label:'Upcoming catalysts', fmt:'num', better:'high' },
    { key:'daysToNextCatalyst',label:'Days to next',       fmt:'num', better:'low'  },
  ]},
];

function metricValue(meta, key){
  const m = (meta && meta.metrics) || {};
  return m[key] ?? null;
}

function formatMetric(v, fmt, ccy){
  if (v === null || v === undefined) return null;
  switch(fmt){
    case 'usd':  return fmtUsd(v, ccy);
    case 'pct':  return fmtPct(v);
    case 'num':  return fmtNum(v);
    case 'mo':   return fmtMo(v);
    case 'raw$': return '$' + v;
    default:     return String(v);
  }
}

function analyzeSelection(){
  // Primary ticker defaults to the first visible watchlist entry.
  const avail = state.watchlist.filter(t => !state.hidden[t]);
  if(!avail.length) return { primary:null, compare:[] };
  const primary = avail.includes(state.analyzeTicker) ? state.analyzeTicker : avail[0];
  const compare = (state.compareWith || []).filter(t => avail.includes(t) && t !== primary).slice(0,3);
  return { primary, compare };
}

/** The row of company chips plus the compare controls. */
function analyzeBar(primary, compare){
  const avail = state.watchlist.filter(t => !state.hidden[t]);
  const d = state.data;

  return el('div',{class:'az-bar'},[
    el('div',{class:'az-pick'},
      avail.map(t => el('button',{
        class:'az-chip' + (t === primary ? ' primary' : compare.includes(t) ? ' cmp' : ''),
        type:'button',
        title: t === primary ? 'Currently analysing ' + t : 'Analyse ' + t,
        onclick:()=>{
          state.analyzeTicker = t;
          state.compareWith = (state.compareWith || []).filter(x => x !== t);
          render();
        }},[
        el('span',{class:'swatch', style:'background:'+tickerColor(t)}),
        t,
      ]))
    ),
    el('div',{class:'az-cmp-controls'},[
      el('span',{class:'az-cmp-label'},['Compare with']),
      ...avail.filter(t => t !== primary).map(t =>
        el('button',{
          class:'az-add' + (compare.includes(t) ? ' on' : ''),
          type:'button',
          disabled: (!compare.includes(t) && compare.length >= 3) ? 'disabled' : null,
          onclick:()=>{
            const set = new Set(state.compareWith || []);
            set.has(t) ? set.delete(t) : set.add(t);
            state.compareWith = [...set];
            render();
          }},[ (compare.includes(t) ? '\u2713 ' : '+ ') + t ])
      ),
      compare.length
        ? el('button',{class:'az-clear', type:'button',
            onclick:()=>{ state.compareWith = []; render(); }},['Clear'])
        : null,
    ])
  ]);
}

/** Headline figures for the single-company view. */
function statCards(meta){
  const m = meta.metrics || {};
  const ccy = m.reportingCurrency;
  const cards = [
    { label:'Cash runway', value: m.runwayMonths !== null && m.runwayMonths !== undefined
        ? m.runwayMonths + ' mo' : (m.cashStatus === 'cash-generating' ? 'Profitable' : null),
      note: m.burnScaled ? 'scaled from a longer reporting period' :
            m.cashStatus === 'cash-generating' ? 'generates cash from operations' : null,
      tone: m.runwayMonths === null || m.runwayMonths === undefined ? 'neutral'
          : m.runwayMonths < 12 ? 'warn' : m.runwayMonths < 24 ? 'mid' : 'good' },
    { label:'Cash & investments', value: fmtUsd(m.totalCashUsd, ccy),
      note: m.cashAsOf ? 'as of ' + m.cashAsOf : null, tone:'neutral' },
    { label:'Quarterly burn', value: fmtUsd(m.quarterlyBurnUsd, ccy),
      note: m.burnPeriod, tone:'neutral' },
    { label:'Dilution, 1 yr', value: m.dilutionPctYoy === null || m.dilutionPctYoy === undefined
        ? null : (m.dilutionPctYoy > 0 ? '+' : '') + m.dilutionPctYoy + '%',
      note: m.dilutionFrom ? 'since ' + m.dilutionFrom : null,
      tone: m.dilutionPctYoy === null || m.dilutionPctYoy === undefined ? 'neutral'
          : m.dilutionPctYoy > 15 ? 'warn' : m.dilutionPctYoy > 5 ? 'mid' : 'good' },
  ];
  return el('div',{class:'az-stats'}, cards.map(c =>
    el('div',{class:'az-stat tone-' + c.tone},[
      el('div',{class:'az-stat-label'},[c.label]),
      el('div',{class:'az-stat-value'},[c.value === null ? '\u2014' : c.value]),
      c.note ? el('div',{class:'az-stat-note'},[c.note]) : null,
    ])
  ));
}

/** Single-company detail: grouped metric list plus trial outcomes. */
function singleView(ticker, meta){
  const m = meta.metrics || {};
  const ccy = m.reportingCurrency;
  const sections = [];

  for(const grp of METRIC_GROUPS){
    const rows = grp.rows
      .map(r => [r.label, formatMetric(metricValue(meta, r.key), r.fmt, ccy)])
      .filter(([,v]) => v !== null);
    if(!rows.length) continue;
    sections.push(el('div',{class:'az-section'},[
      el('h3',{class:'az-section-title'},[grp.group]),
      el('dl',{class:'az-dl'}, rows.flatMap(([k,v]) => [
        el('dt',{},[k]), el('dd',{},[v])
      ])),
    ]));
  }

  const ts = meta.trialStats;
  if(ts && ts.concluded){
    const total = ts.completed + ts.terminated + ts.withdrawn + ts.ongoing;
    const seg = (n, cls, title) => n > 0
      ? el('span',{class:'az-seg ' + cls, style:`flex:${n}`, title:`${title}: ${n}`}) : null;
    sections.push(el('div',{class:'az-section'},[
      el('h3',{class:'az-section-title'},['Trial outcomes']),
      el('div',{class:'az-bar-chart'},[
        seg(ts.completed,'s-done','Completed'),
        seg(ts.ongoing,'s-live','Ongoing'),
        seg(ts.terminated,'s-stop','Terminated'),
        seg(ts.withdrawn,'s-pull','Withdrawn'),
      ]),
      el('div',{class:'az-legend'},[
        el('span',{},[el('i',{class:'s-done'}), 'Completed ' + ts.completed]),
        el('span',{},[el('i',{class:'s-live'}), 'Ongoing ' + ts.ongoing]),
        el('span',{},[el('i',{class:'s-stop'}), 'Terminated ' + ts.terminated]),
        ts.withdrawn ? el('span',{},[el('i',{class:'s-pull'}), 'Withdrawn ' + ts.withdrawn]) : null,
      ]),
      el('dl',{class:'az-dl'},[
        el('dt',{},['Completion rate']),
        el('dd',{},[ts.completionRatePct === null ? 'Too few concluded trials' : ts.completionRatePct + '%']),
        el('dt',{},['Results posted']),
        el('dd',{},[ts.resultsPostedPct === null ? '\u2014' : ts.resultsPostedPct + '% of completed']),
        el('dt',{},['Trials counted']),
        el('dd',{},[String(total)]),
      ]),
    ]));
  }

  return el('div',{class:'az-single'}, sections);
}

/** Side-by-side grid, used once the user adds comparisons. */
function compareView(picks){
  const d = state.data;
  const metas = picks.map(t => [t, (d.tickers || {})[t] || {}]);
  const cols = `grid-template-columns:190px repeat(${picks.length},minmax(0,1fr))`;
  const body = [];

  const headCards = el('div',{class:'cmp-heads', style:cols},[
    el('div',{class:'cmp-corner'},['']),
    ...metas.map(([t, meta]) => {
      const m = meta.metrics || {};
      return el('div',{class:'cmp-head'},[
        el('div',{class:'cmp-head-top'},[
          el('span',{class:'swatch', style:'background:'+tickerColor(t)}),
          el('span',{class:'cmp-ticker'},[t]),
        ]),
        el('div',{class:'cmp-company'},[meta.name || '']),
        m.reportingCurrency && m.isUsd === false
          ? el('div',{class:'cmp-warn'},['Reports in ' + m.reportingCurrency]) : null,
      ]);
    })
  ]);

  const pushRows = (label, rows, getter) => {
    body.push(el('div',{class:'cmp-group', style:cols},[
      el('div',{class:'cmp-group-label'},[label]),
      ...picks.map(()=>el('div',{})),
    ]));
    for(const row of rows){
      const vals = metas.map(([,meta]) => getter(meta, row));
      const nums = vals.filter(v => typeof v === 'number');
      let best = null;
      if(row.better && nums.length > 1){
        best = row.better === 'high' ? Math.max(...nums) : Math.min(...nums);
        if(nums.every(v => v === best)) best = null;
      }
      body.push(el('div',{class:'cmp-row', style:cols},[
        el('div',{class:'cmp-label'},[row.label]),
        ...metas.map(([,meta], i) => {
          const v = vals[i];
          const txt = row.render
            ? row.render(v)
            : formatMetric(v, row.fmt, (meta.metrics||{}).reportingCurrency);
          return el('div',{class:'cmp-cell' + (best!==null && v===best ? ' best':'') + (txt===null?' na':'')},
            [txt === null ? '\u2014' : txt]);
        })
      ]));
    }
  };

  for(const grp of METRIC_GROUPS){
    pushRows(grp.group, grp.rows, (meta, row) => metricValue(meta, row.key));
  }

  if(metas.some(([,m]) => m.trialStats)){
    pushRows('Trial outcomes', [
      {key:'completionRatePct', label:'Completion rate', better:'high', render:v=>v===null?null:v+'%'},
      {key:'completed',         label:'Completed',       better:'high', render:v=>fmtNum(v)},
      {key:'terminated',        label:'Terminated',      better:'low',  render:v=>fmtNum(v)},
      {key:'ongoing',           label:'Ongoing',         better:null,   render:v=>fmtNum(v)},
    ], (meta, row) => (meta.trialStats || {})[row.key] ?? null);
  }

  return el('div',{class:'cmp-panel'},[ headCards, el('div',{class:'cmp-body'}, body) ]);
}

function analysisTab(){
  const d = state.data;
  const { primary, compare } = analyzeSelection();

  if(!primary){
    return el('div',{class:'panel'},[
      el('div',{class:'detail-empty'},['Add a ticker to your watchlist to analyse it.'])
    ]);
  }

  const meta = (d.tickers || {})[primary] || {};
  const comparing = compare.length > 0;

  const main = el('div',{class:'panel'},[
    analyzeBar(primary, compare),
    comparing
      ? compareView([primary, ...compare])
      : el('div',{class:'az-main'},[
          el('div',{class:'az-title-row'},[
            el('h2',{class:'az-title'},[meta.name || primary]),
            meta.tier ? el('span',{class:'cmp-tier'},[meta.tier.replace(/-/g,' ')]) : null,
          ]),
          meta.focus ? el('p',{class:'az-focus'},[meta.focus]) : null,
          statCards(meta),
          singleView(primary, meta),
        ])
  ]);

  return el('div',{},[
    main,
    el('div',{class:'panel'},[
      el('div',{class:'panel-head'},['How to read this']),
      el('div',{class:'panel-body cmp-notes'},[
        el('p',{},['Figures come from each company\u2019s most recent SEC XBRL filing. Runway is cash and short-term investments divided by the latest quarterly operating burn, and is blank for companies that generate cash.']),
        el('p',{},['Completion rate is completed trials as a share of those that reached an end state. It stays blank below five concluded trials. It measures whether programs finish, not whether they met their endpoint \u2014 no free source publishes that.']),
        el('p',{},['Companies reporting in a non-USD currency are flagged. Runway still compares fairly since it is a ratio, but cash and revenue do not.']),
      ])
    ])
  ]);
}

/* ---------------------------------------------------------------- Data tab */

const COLUMNS = [
  {key:'date',    label:'Date',    get: e => e.date},
  {key:'ticker',  label:'Ticker',  get: e => e.ticker},
  {key:'type',    label:'Type',    get: e => e.type},
  {key:'phase',   label:'Phase',   get: e => e.phase || ''},
  {key:'title',   label:'Event',   get: e => e.title},
  {key:'status',  label:'Status',  get: e => e.status},
];

/**
 * Structured filters compose: `phase:3 type:earnings before:2027-01-01`.
 * Anything not matching a key:value pair is treated as free text.
 * Metric filters (runway:<12) plug into the same parser later.
 */
function parseQuery(q){
  const terms = {free:[], filters:[]};
  for(const part of q.trim().split(/\s+/)){
    if(!part) continue;
    const m = part.match(/^([a-z]+):(.+)$/i);
    if(m) terms.filters.push({key:m[1].toLowerCase(), val:m[2].toLowerCase()});
    else terms.free.push(part.toLowerCase());
  }
  return terms;
}

function matches(e, terms, tickerMeta){
  for(const f of terms.filters){
    const v = f.val;
    switch(f.key){
      case 'ticker':  if(e.ticker.toLowerCase() !== v) return false; break;
      case 'phase':   if(!(e.phase||'').toLowerCase().includes(v)) return false; break;
      case 'type':    if(!e.type.toLowerCase().includes(v)) return false; break;
      case 'status':  if(e.status !== v) return false; break;
      case 'source':  if(e.origin !== v) return false; break;
      case 'before':  if(!(e.date < v)) return false; break;
      case 'after':   if(!(e.date > v)) return false; break;
      case 'tier':    if((tickerMeta[e.ticker]||{}).tier !== v) return false; break;
      case 'runway': {
        const m = (tickerMeta[e.ticker]||{}).metrics || {};
        if(m.runwayMonths === null || m.runwayMonths === undefined) return false;
        const num = parseFloat(v.replace(/[<>]/,''));
        if(v.startsWith('<') && !(m.runwayMonths < num)) return false;
        if(v.startsWith('>') && !(m.runwayMonths > num)) return false;
        break;
      }
      default: return false;
    }
  }
  if(terms.free.length){
    const hay = (e.ticker + ' ' + e.title + ' ' + e.type + ' ' + (e.phase||'') + ' ' + (e.summary||'')).toLowerCase();
    for(const w of terms.free) if(!hay.includes(w)) return false;
  }
  return true;
}

function dataTab(){
  const tickerMeta = state.data.tickers || {};
  const terms = parseQuery(state.q);
  let rows = visibleEvents().filter(e => matches(e, terms, tickerMeta));

  const col = COLUMNS.find(c => c.key === state.sortKey) || COLUMNS[0];
  rows.sort((a,b)=>{
    const r = String(col.get(a)).localeCompare(String(col.get(b)));
    return state.sortDir === 'asc' ? r : -r;
  });

  const shown = rows.slice(0, 250);

  return el('div',{class:'panel'},[
    el('div',{class:'data-head'},[
      el('input',{
        type:'search', class:'data-search', value: state.q,
        placeholder:'Search, or filter: phase:3 type:earnings runway:<12 after:2026-10-01',
        oninput:(e)=>{ state.q = e.target.value; const p=e.target.selectionStart; render();
          const b=document.querySelector('.data-search'); if(b){ b.focus(); b.setSelectionRange(p,p); } }
      }),
      el('div',{class:'data-count'},[
        rows.length.toLocaleString() + ' of ' + visibleEvents().length.toLocaleString() + ' events'
        + (rows.length > 250 ? ' — showing first 250' : '')
      ]),
    ]),
    el('div',{class:'data-hints'},[
      'Filters: ',
      ...['phase:3','type:earnings','status:upcoming','source:edgar','runway:<12','tier:oncology','after:2026-10-01']
        .map(h => el('button',{class:'hint', type:'button',
          onclick:()=>{ state.q = (state.q ? state.q.trim()+' ' : '') + h; render(); }},[h]))
    ]),
    el('div',{class:'table-wrap'},[
      el('table',{class:'data-table'},[
        el('thead',{},[ el('tr',{}, COLUMNS.map(c =>
          el('th',{ class: state.sortKey===c.key ? 'sorted' : '',
            onclick:()=>{
              if(state.sortKey===c.key) state.sortDir = state.sortDir==='asc'?'desc':'asc';
              else { state.sortKey=c.key; state.sortDir='asc'; }
              render();
            }},[ c.label + (state.sortKey===c.key ? (state.sortDir==='asc'?' \u2191':' \u2193') : '') ])
        ))]),
        el('tbody',{}, shown.map(e =>
          el('tr',{ onclick:()=>{ state.modalDate = e.date; render(); } },
            COLUMNS.map(c => {
              if(c.key==='ticker') return el('td',{},[
                el('span',{class:'badge', style:'background:'+tickerColor(e.ticker)},[e.ticker])]);
              if(c.key==='title') return el('td',{class:'cell-title', title:e.title},[e.title]);
              return el('td',{},[String(c.get(e))]);
            })
          )
        )),
      ])
    ]),
    shown.length === 0 ? el('div',{class:'detail-empty'},['No events match that query.']) : null,
  ]);
}

function modal(){
  const evs = visibleEvents().filter(e => e.date === state.modalDate);
  const d = new Date(state.modalDate + 'T00:00:00');
  const heading = MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  const close = ()=>{ state.modalDate = null; render(); };

  return el('div',{class:'modal-backdrop', onclick:(ev)=>{ if(ev.target.classList.contains('modal-backdrop')) close(); }},[
    el('div',{class:'modal', role:'dialog', 'aria-modal':'true', 'aria-label':'Events on ' + heading},[
      el('div',{class:'modal-head'},[
        el('div',{},[
          el('div',{class:'modal-title'},[heading]),
          el('div',{class:'modal-count'},[evs.length + (evs.length === 1 ? ' event' : ' events')]),
        ]),
        el('button',{class:'modal-close', type:'button', 'aria-label':'Close', onclick:close},['\u00d7']),
      ]),
      el('div',{class:'modal-body'}, evs.length ? evs.map(eventCard) : [
        el('div',{class:'detail-empty'},['No events on this date with the current filters.'])
      ]),
    ])
  ]);
}

function calendar(){
  const y = state.viewMonth.getFullYear();
  const m = state.viewMonth.getMonth();

  const byDate = {};
  for(const e of visibleEvents()) (byDate[e.date] = byDate[e.date] || []).push(e);

  const startOffset = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m+1, 0).getDate();
  const cells = [];

  for(let i = 0; i < 42; i++){
    const dayIndex = i - startOffset + 1;
    const cellDate = new Date(y, m, dayIndex);
    const inMonth = dayIndex >= 1 && dayIndex <= daysInMonth;
    const ds = iso(cellDate);
    const evs = byDate[ds] || [];

    let cls = 'cell';
    if(!inMonth) cls += ' out';
    if(ds === TODAY_ISO) cls += ' today';
    if(evs.length) cls += ' has-events';
    if(ds === state.selectedDate) cls += ' selected';

    const MAX = 3;
    const ticks = evs.slice(0, MAX).map(e =>
      el('span',{class:'tick', style:'background:'+tickerColor(e.ticker), title: e.ticker+' — '+e.title},
        [e.ticker + ' ' + shortTitle(e)])
    );
    if(evs.length > MAX) ticks.push(el('span',{class:'tick more'},['+' + (evs.length-MAX) + ' more']));

    cells.push(el(evs.length ? 'button' : 'div', {
      class: cls,
      type: evs.length ? 'button' : null,
      onclick: evs.length ? (()=>{ state.modalDate = ds; state.selectedDate = ds; render(); }) : null,
    },[
      el('span',{class:'daynum'},[String(cellDate.getDate())]),
      el('span',{class:'ticks'}, ticks),
    ]));
  }

  return el('div',{class:'panel'},[
    el('div',{class:'cal-head'},[
      el('div',{class:'cal-month'},[MONTHS[m] + ' ' + y]),
      el('div',{class:'cal-nav'},[
        el('button',{class:'today-btn', type:'button', onclick:()=>{ state.viewMonth = startOfMonth(new Date()); render(); }},['Today']),
        el('button',{class:'nav-btn', type:'button', 'aria-label':'Previous month', onclick:()=>{ state.viewMonth = new Date(y, m-1, 1); render(); }},['‹']),
        el('button',{class:'nav-btn', type:'button', 'aria-label':'Next month', onclick:()=>{ state.viewMonth = new Date(y, m+1, 1); render(); }},['›']),
      ])
    ]),
    el('div',{class:'weekday-row'}, WEEKDAYS.map(w => el('div',{class:'weekday'},[w]))),
    el('div',{class:'grid'}, cells),
  ]);
}

function eventCard(e){
  const d = new Date(e.date + 'T00:00:00');
  const heading = MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();

  const badges = [
    el('span',{class:'badge', style:'background:'+tickerColor(e.ticker)},[e.ticker]),
    el('span',{class:'badge type'},[e.type + (e.phase ? ' \u00b7 ' + e.phase : '')]),
    el('span',{class:'badge status-'+e.status},[e.status === 'past' ? 'Reported' : 'Upcoming']),
  ];
  if(e.estimated) badges.push(el('span',{class:'badge est'},['est.']));
  const originLabel = {curated:'curated', registry:'ClinicalTrials.gov', edgar:'SEC EDGAR'}[e.origin];
  if(originLabel) badges.push(el('span',{class:'badge type'},[originLabel]));

  const body = [
    el('div',{class:'event-top'}, badges),
    el('h3',{class:'event-title'},[e.title]),
    el('div',{class:'event-date'},[heading]),
    el('p',{class:'event-summary'},[e.summary]),
  ];
  if(e.result) body.push(el('div',{class:'event-result'},[el('b',{},['Result']), e.result]));
  body.push(el('div',{class:'event-source'},[
    'Source: ',
    e.sourceUrl ? el('a',{href:e.sourceUrl, target:'_blank', rel:'noopener noreferrer'},[e.source]) : e.source
  ]));
  return el('div',{class:'event-card'}, body);
}

/* ============================================================== Macro tab */

/**
 * Macro data is a separate payload on a separate build cadence, fetched the
 * first time the tab is opened. A visitor who only wants the biotech calendar
 * never downloads it.
 */
async function loadMacro(){
  if(state.macro || state.macroLoading) return;
  state.macroLoading = true;
  try{
    const res = await fetch('data/macro.json', {cache:'no-cache'});
    if(!res.ok) throw new Error('HTTP ' + res.status);
    state.macro = await res.json();
  }catch(err){
    state.macro = {
      available: false,
      reason: 'not-built',
      detail: 'macro.json could not be loaded (' + err.message + '). Run: node scripts/build-macro.js',
      releases: [], indicators: [], positioning: [], risk: null,
    };
  }
  state.macroLoading = false;
  render();
}

const MACRO_GROUP_TABS = [
  {id:'all',       label:'All'},
  {id:'inflation', label:'Inflation'},
  {id:'jobs',      label:'Jobs'},
  {id:'growth',    label:'Growth'},
  {id:'fed',       label:'Fed'},
];

/**
 * The second line of a release row. Normally the full release name, which
 * expands the short one usefully — "CPI" into "Consumer Price Index".
 *
 * But some releases are already known by their full name, and printing
 * "Existing home sales / Existing Home Sales" makes every such row look like
 * a duplicate of itself. When the full name adds no word the short one does
 * not already have, show the issuing agency instead: still informative, and
 * it keeps the row from reading as an accident.
 */
function relSecondary(r){
  const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(Boolean);
  const have = new Set(words(r.short));
  const extra = words(r.name).filter(w => !have.has(w));
  return extra.length ? r.name : (r.agency || '');
}

/** Importance 3 is a number that moves markets; 1 is context. */
function impDots(n){
  return el('span',{class:'imp imp-'+n, title: n===3 ? 'Market-moving' : n===2 ? 'Watched' : 'Context'},
    [0,1,2].map(i => el('span',{class:'imp-dot' + (i < n ? ' on' : '')})));
}

function fmtMacro(ind){
  if(ind.value === null || ind.value === undefined) return '—';
  const v = ind.value.toLocaleString(undefined, {
    minimumFractionDigits: ind.decimals, maximumFractionDigits: ind.decimals
  });
  if(ind.unit === '%') return v + '%';
  if(ind.unit === '$') return '$' + v;
  if(ind.unit === 'k') return v + 'k';
  return v;
}

/**
 * Signed change, with the sign kept — a fall of 0.2 must not read as 0.2.
 * Shown to the same precision as the value itself: the payload carries an
 * extra digit, but "+0.035pp" on a figure quoted to two places is noise.
 */
function fmtDelta(ind){
  if(ind.change === null || ind.change === undefined) return null;
  const suffix = ind.unit === '%' ? 'pp' : ind.unit === 'k' ? 'k' : '';
  const sign = ind.change > 0 ? '+' : ind.change < 0 ? '−' : '';
  const mag = Math.abs(ind.change);
  const tick = Math.pow(10, -ind.decimals);

  // A change too small to show at this precision renders as a bound, not as
  // "+0" — which would read as no change when there was one.
  if(mag > 0 && mag < tick / 2) return '<' + tick.toFixed(ind.decimals) + suffix;

  const abs = mag.toLocaleString(undefined, {
    minimumFractionDigits: 0, maximumFractionDigits: ind.decimals
  });
  return sign + abs + suffix;
}

/**
 * Colours the change only where there is a defensible direction. Cross-asset
 * moves get no colour: a rising VIX is information, not bad news, and painting
 * it red would be the page taking a position it has no business taking.
 */
function deltaClass(ind){
  if(!ind.goodDirection || !ind.direction || ind.direction === 'flat') return 'neutral';
  return ind.direction === ind.goodDirection ? 'good' : 'bad';
}

function arrow(dir){
  return dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→';
}

/** Inline sparkline. Flat series get a centred line rather than a divide-by-zero. */
function sparkline(history, w, h){
  w = w || 92; h = h || 26;
  const pts = (history || []).map(p => p[1]).filter(v => Number.isFinite(v));
  if(pts.length < 3) return el('span',{class:'spark-empty'},[]);
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = max - min;
  const pad = 2;
  const x = i => (i / (pts.length - 1)) * (w - pad*2) + pad;
  const y = v => span === 0 ? h/2 : h - pad - ((v - min) / span) * (h - pad*2);
  const d = pts.map((v,i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
  const rising = pts[pts.length-1] >= pts[0];

  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('class','spark');
  svg.setAttribute('viewBox','0 0 '+w+' '+h);
  svg.setAttribute('width', w); svg.setAttribute('height', h);
  svg.setAttribute('aria-hidden','true');
  const path = document.createElementNS('http://www.w3.org/2000/svg','path');
  path.setAttribute('d', d);
  path.setAttribute('fill','none');
  path.setAttribute('stroke-width','1.6');
  path.setAttribute('stroke-linecap','round');
  path.setAttribute('stroke', rising ? 'var(--teal)' : 'var(--ink-faint)');
  svg.appendChild(path);
  return svg;
}

function daysUntil(dateStr){
  const d = new Date(dateStr + 'T00:00:00');
  const t = new Date(TODAY_ISO + 'T00:00:00');
  return Math.round((d - t) / 86400000);
}

function whenLabel(dateStr){
  const n = daysUntil(dateStr);
  if(n === 0) return 'Today';
  if(n === 1) return 'Tomorrow';
  if(n < 0) return Math.abs(n) + (Math.abs(n) === 1 ? ' day ago' : ' days ago');
  if(n < 7) return 'in ' + n + ' days';
  if(n < 14) return 'next week';
  return 'in ' + Math.round(n / 7) + ' weeks';
}

function macroTab(){
  if(state.macroLoading && !state.macro){
    return el('div',{class:'loading'},['Loading economic data…']);
  }
  const m = state.macro;
  if(!m) return el('div',{class:'loading'},['Loading economic data…']);

  if(!m.available){
    return el('div',{class:'panel'},[
      el('div',{class:'panel-head'},['Economic data not built yet']),
      el('div',{class:'panel-body'},[
        el('p',{class:'about-text'},[
          m.reason === 'no-api-key'
            ? 'This page runs on FRED, the St. Louis Fed’s data service. It needs a free API key — about a minute to get, no payment details.'
            : 'The macro payload has not been generated.'
        ]),
        el('p',{class:'about-text'},[m.detail || '']),
        m.reason === 'no-api-key' ? el('p',{class:'about-text'},[
          el('a',{href:'https://fredaccount.stlouisfed.org/apikeys', target:'_blank', rel:'noopener noreferrer'},
            ['Get a FRED API key'])
        ]) : null,
      ])
    ]);
  }

  const kids = [];
  const g = state.macroGroup;
  const inGroup = (x) => g === 'all' || x.group === g;

  kids.push(macroHero(m));

  kids.push(el('div',{class:'macro-subnav'}, MACRO_GROUP_TABS.map(t =>
    el('button',{
      class:'chip-tab' + (g === t.id ? ' active' : ''),
      type:'button',
      onclick:()=>{ state.macroGroup = t.id; render(); }
    },[t.label])
  )));

  kids.push(macroCalendar(m, inGroup));

  const inds = (m.indicators || []).filter(inGroup);
  if(inds.length) kids.push(macroPrints(m, inds));

  // Cross-asset is always shown: it is the "what is happening right now" strip
  // and it does not belong to any one release group.
  const cross = (m.indicators || []).filter(i => i.group === 'cross');
  if(cross.length) kids.push(macroCross(cross));

  if((m.positioning || []).length) kids.push(macroPositioning(m));

  kids.push(macroNotes(m));
  return el('div',{}, kids);
}

/* ---------- hero: next release + risk gauge ---------- */

function macroHero(m){
  const next = (m.releases || []).find(r => r.status === 'upcoming' && r.importance === 3)
            || (m.releases || []).find(r => r.status === 'upcoming');

  const left = el('div',{class:'hero-next'},[
    el('p',{class:'hero-eyebrow'},['Next market-moving release']),
    next ? el('h2',{class:'hero-title'},[next.name]) : el('h2',{class:'hero-title'},['Nothing scheduled']),
    next ? el('div',{class:'hero-meta'},[
      el('span',{class:'hero-when'},[whenLabel(next.date)]),
      el('span',{class:'hero-sep'},['·']),
      el('span',{},[longDate(next.date) + ', ' + next.time + ' ET']),
      el('span',{class:'hero-sep'},['·']),
      el('span',{},[next.agency]),
    ]) : null,
    next && next.note ? el('p',{class:'hero-note'},[next.note]) : null,
    // The next few after it, so the card answers "what else is coming" without
    // the reader having to scan the full calendar below.
    (() => {
      const then = (m.releases || [])
        .filter(r => r.status === 'upcoming' && r.importance === 3 && (!next || r.key !== next.key))
        .slice(0, 3);
      if(!then.length) return null;
      return el('div',{class:'hero-then'},[
        el('span',{class:'hero-then-label'},['Then']),
        el('div',{class:'hero-then-list'}, then.map(r =>
          el('span',{class:'hero-then-item'},[
            el('b',{},[r.short]),
            ' ' + longDate(r.date).replace(', ' + r.date.slice(0,4), ''),
          ])
        )),
      ]);
    })(),
  ]);

  const r = m.risk;
  const right = (r && r.score !== null)
    ? el('div',{class:'hero-risk'},[
        el('p',{class:'hero-eyebrow'},['Risk appetite']),
        el('div',{class:'gauge'},[
          el('div',{class:'gauge-score'},[String(r.score)]),
          el('div',{class:'gauge-label'},[r.label]),
        ]),
        el('div',{class:'gauge-bar'},[
          el('div',{class:'gauge-fill', style:'width:'+r.score+'%'}),
        ]),
        el('div',{class:'gauge-ends'},[
          el('span',{},['Fear']), el('span',{},['Greed'])
        ]),
        el('details',{class:'gauge-details'},[
          el('summary',{},['How this is built']),
          el('div',{class:'gauge-comps'}, (r.components||[]).map(comp =>
            el('div',{class:'gauge-comp'},[
              el('div',{class:'gc-top'},[
                el('span',{class:'gc-label'},[comp.label]),
                el('span',{class:'gc-score'},[String(comp.score)]),
              ]),
              el('div',{class:'gc-track'},[el('div',{class:'gc-fill', style:'width:'+comp.score+'%'})]),
              el('div',{class:'gc-detail'},[comp.detail]),
            ])
          )),
          el('p',{class:'gauge-method'},[r.method || '']),
        ]),
      ])
    : el('div',{class:'hero-risk'},[
        el('p',{class:'hero-eyebrow'},['Risk appetite']),
        el('div',{class:'empty-note'},[(r && r.note) || 'Not available.']),
      ]);

  return el('div',{class:'macro-hero'},[left, right]);
}

/* ---------- release calendar ---------- */

function macroCalendar(m, inGroup){
  const rows = (m.releases || [])
    .filter(r => r.status === 'upcoming')
    .filter(inGroup)
    .slice(0, 40);

  const byDate = new Map();
  for(const r of rows){
    if(!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }

  const body = byDate.size
    ? [...byDate.entries()].map(([date, items]) =>
        el('div',{class:'rel-day'},[
          el('div',{class:'rel-date'},[
            el('span',{class:'rel-date-main'},[longDate(date)]),
            el('span',{class:'rel-date-when'},[whenLabel(date)]),
          ]),
          el('div',{class:'rel-items'}, items.map(r =>
            el('a',{
              class:'rel-item', href:r.sourceUrl, target:'_blank', rel:'noopener noreferrer'
            },[
              impDots(r.importance),
              el('span',{class:'rel-name'},[r.short]),
              // A marker for what separates otherwise identical rows — the
              // four FOMC meetings a year that carry the dot plot.
              r.tag ? el('span',{class:'rel-tag', title:r.note || ''},[r.tag]) : null,
              el('span',{class:'rel-full'},[relSecondary(r)]),
              r.valueAvailable === false
                ? el('span',{class:'badge est', title:r.note || ''},['date only'])
                : null,
              el('span',{class:'rel-time'},[r.time + ' ET']),
            ])
          )),
        ])
      )
    : [el('div',{class:'empty-note'},['Nothing scheduled in this group over the next six months.'])];

  return el('div',{class:'panel'},[
    el('div',{class:'panel-head'},[
      'Release calendar',
      el('span',{class:'head-count'},[String(rows.length)]),
    ]),
    el('div',{class:'panel-body rel-body'}, body),
  ]);
}

/* ---------- latest prints ---------- */

function macroPrints(m, inds){
  const groups = {};
  for(const i of inds){
    if(i.group === 'cross') continue;
    (groups[i.group] = groups[i.group] || []).push(i);
  }
  const order = ['inflation','jobs','growth'];
  const panels = order.filter(k => groups[k]).map(k => {
    const meta = (m.groups || {})[k] || {label:k, blurb:''};
    // macro-spec.js already lists these in reading order, and the payload keeps
    // it. Re-sorting by importance split each indicator from its own variant.
    const list = groups[k];
    return el('div',{class:'panel'},[
      el('div',{class:'panel-head'},[meta.label, el('span',{class:'head-blurb'},[meta.blurb || ''])]),
      el('div',{class:'panel-body print-grid'}, list.map(printCard)),
    ]);
  });
  return el('div',{}, panels);
}

function printCard(ind){
  const delta = fmtDelta(ind);
  return el('div',{class:'print-card'},[
    el('div',{class:'print-top'},[
      el('div',{},[
        el('div',{class:'print-label'},[ind.label]),
        ind.sub ? el('div',{class:'print-sub'},[ind.sub]) : null,
      ]),
      sparkline(ind.history),
    ]),
    el('div',{class:'print-mid'},[
      el('span',{class:'print-value'},[fmtMacro(ind)]),
      delta ? el('span',{class:'print-delta ' + deltaClass(ind)},[
        arrow(ind.direction) + ' ' + delta
      ]) : null,
    ]),
    el('div',{class:'print-foot'},[
      el('span',{},[refLabel(ind)]),
      el('a',{href:ind.sourceUrl, target:'_blank', rel:'noopener noreferrer', class:'print-src',
              title: ind.seriesTitle || ind.series},[ind.series]),
    ]),
  ]);
}

/**
 * The period the number describes, not the day it was published. Saying
 * "September" for a CPI print released in October is the honest framing —
 * it stops a reader treating a monthly figure as today's reading.
 */
function refLabel(ind){
  const d = new Date(ind.asOf + 'T00:00:00');
  if(ind.freq === 'quarterly') return 'Q' + (Math.floor(d.getMonth()/3)+1) + ' ' + d.getFullYear();
  if(ind.freq === 'monthly') return MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  if(ind.freq === 'weekly') return 'week to ' + longDate(ind.asOf);
  return longDate(ind.asOf);
}

/* ---------- cross-asset ---------- */

function macroCross(cross){
  const list = cross;   // spec order: volatility, equities, rates, curve, credit, FX, commodities

  // These are all daily series that almost always share one as-of date, so it
  // belongs in the header. Repeating it on twelve tiles is noise — but a tile
  // that is genuinely stale still has to say so, so it keeps its own date.
  const counts = {};
  for(const i of list) counts[i.asOf] = (counts[i.asOf] || 0) + 1;
  const common = Object.keys(counts).sort((a,b) => counts[b] - counts[a])[0];

  return el('div',{class:'panel'},[
    el('div',{class:'panel-head'},[
      'Cross-asset',
      el('span',{class:'head-blurb'},[
        'What markets are pricing right now' + (common ? ' · ' + longDate(common) : '')
      ]),
    ]),
    el('div',{class:'panel-body cross-grid'}, list.map(ind => {
      const delta = fmtDelta(ind);
      return el('div',{class:'cross-tile'},[
        el('div',{class:'cross-label', title:ind.label},[ind.label]),
        el('div',{class:'cross-value'},[fmtMacro(ind)]),
        el('div',{class:'cross-foot'},[
          delta ? el('span',{class:'cross-delta'},[arrow(ind.direction) + ' ' + delta]) : el('span',{},['']),
          sparkline(ind.history, 54, 18),
        ]),
        ind.asOf !== common
          ? el('div',{class:'cross-as-of stale'},[longDate(ind.asOf)])
          : null,
      ]);
    })),
  ]);
}

/* ---------- positioning ---------- */

function macroPositioning(m){
  return el('div',{class:'panel'},[
    el('div',{class:'panel-head'},[
      'Speculative positioning',
      el('span',{class:'head-blurb'},[
        'CFTC Commitments of Traders, non-commercial net' +
        (m.positioningAsOf ? ' · as of ' + longDate(m.positioningAsOf) : '')
      ]),
    ]),
    el('div',{class:'panel-body'},[
      el('div',{class:'pos-grid'}, m.positioning.map(p =>
        el('div',{class:'pos-row'},[
          el('span',{class:'pos-label', title:p.contract},[p.label]),
          el('span',{class:'pos-net ' + (p.net >= 0 ? 'long' : 'short')},[
            (p.net >= 0 ? '+' : '−') + Math.abs(p.net).toLocaleString() +
            (p.net >= 0 ? ' net long' : ' net short')
          ]),
          el('span',{class:'pos-change'},[
            p.netChange === null ? '' :
            (p.netChange > 0 ? '↑ ' : p.netChange < 0 ? '↓ ' : '→ ') +
            Math.abs(p.netChange).toLocaleString() + ' on week'
          ]),
        ])
      )),
      el('p',{class:'about-text pos-note'},[
        'Published each Friday for the preceding Tuesday, so this shows how speculators were ' +
        'positioned going into the week rather than where they stand now.'
      ]),
    ]),
  ]);
}

/* ---------- provenance and gaps ---------- */

/**
 * Attribution only. The build's own diagnostics and the list of licensed data
 * we leave out are developer concerns — a visitor reading "rejected
 * implausible parse for 2024" concludes the site is broken, which is the
 * opposite of what that line was for. Those live in the build log now.
 *
 * What is NOT dropped is disclosure a reader needs to judge a number: the
 * risk gauge still opens to show all four of its components and how they are
 * weighted, and ISM rows still carry their badge. That belongs next to the
 * number it qualifies, not in a footnote nobody scrolls to.
 */
function macroNotes(m){
  const n = m.notes || {};
  if(!(n.sources || []).length) return el('div',{});
  return el('div',{class:'panel'},[
    el('div',{class:'panel-head'},['Sources']),
    el('div',{class:'panel-body'},[
      el('div',{class:'src-list'}, n.sources.map(s =>
        el('div',{class:'src-row'},[
          el('a',{href:s.url, target:'_blank', rel:'noopener noreferrer', class:'src-name'},[s.name]),
          el('span',{class:'src-covers'},[s.covers]),
        ])
      )),
      el('p',{class:'about-text src-foot'},[
        'Updated ' + (m.generatedDate || '—') + '. This is an information tool, not investment advice.'
      ]),
    ]),
  ]);
}

document.addEventListener('keydown', (ev)=>{
  if(ev.key === 'Escape' && state.modalDate){ state.modalDate = null; render(); }
});

load();
// A visitor arriving on #macro should not have to click the tab to start the fetch.
if(state.tab === 'macro') loadMacro();
