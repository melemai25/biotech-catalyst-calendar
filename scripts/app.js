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
    // Restore a saved watchlist, else seed with the most active tickers.
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('watchlist') || 'null'); } catch {}
    const known = Object.keys(data.tickers || {});
    if (Array.isArray(saved) && saved.length) {
      state.watchlist = saved.filter(t => known.includes(t));
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
  root.appendChild(el('div',{class:'app'},[
    masthead(),
    el('div',{class:'layout'},[ sidebar(), main() ])
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
];

function tabBar(){
  return el('div',{class:'tabbar'}, TABS.map(t =>
    el('button',{
      class:'tab' + (state.tab === t.id ? ' active' : ''),
      type:'button',
      onclick:()=>{ state.tab = t.id; location.hash = t.id; render(); }
    },[t.label])
  ));
}

function main(){
  const kids = [ tabBar() ];
  kids.push(state.tab === 'data' ? dataTab()
          : state.tab === 'analysis' ? analysisTab()
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

document.addEventListener('keydown', (ev)=>{
  if(ev.key === 'Escape' && state.modalDate){ state.modalDate = null; render(); }
});

load();
