/* Catalyst Calendar — reads the static events.json produced by scripts/build-data.js */

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
// Deterministic colour per ticker: same ticker always gets the same hue.
const FIXED_COLORS = { MRNA:'#C23B22', ILMN:'#146B77' };
function tickerColor(t){
  if (FIXED_COLORS[t]) return FIXED_COLORS[t];
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 360;
  // Avoid the yellow band (50-75) where white text goes unreadable.
  if (h > 50 && h < 75) h = (h + 40) % 360;
  return `hsl(${h}, 42%, 34%)`;
}
const COLORS = new Proxy({}, { get: (_, t) => tickerColor(String(t)) });

const state = {
  data: null,
  filters: {},
  showRegistry: true,
  viewMonth: startOfMonth(new Date()),
  selectedDate: null,
  tickerQuery: '',
  sources: { curated:true, registry:true, edgar:true },
  cache: {},
  loading: false,
  modalDate: null,
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
  const need = Object.keys(state.filters).filter(t => state.filters[t] && !state.cache[t]);
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
    const defaults = ['MRNA','ILMN'];
    for(const t of Object.keys(data.tickers || {})) state.filters[t] = defaults.includes(t);
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
  if(state.data.perTicker){
    pool = [];
    for(const t of Object.keys(state.filters)){
      if(state.filters[t] && state.cache[t]) pool = pool.concat(state.cache[t]);
    }
  } else {
    pool = state.data.events || [];
  }
  return pool
    .filter(e => state.filters[e.ticker] && state.sources[e.origin] !== false)
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
  const gen = d.generatedDate || '—';
  return el('div',{class:'masthead'},[
    el('div',{},[
      el('p',{class:'eyebrow'},['Trial & Regulatory Tracker']),
      el('h1',{},['Catalyst Calendar ', el('span',{class:'accent'},['MRNA · ILMN'])]),
    ]),
    el('div',{class:'masthead-right'},[
      el('div',{},[el('span',{class:'dot'}), 'Data built ' + gen]),
      el('div',{},[d.counts.total + ' events — ' + (d.counts.curated||0) + ' curated · ' + (d.counts.registry||0) + ' trials · ' + (d.counts.edgar||0) + ' filings']),
    ]),
  ]);
}

function sidebar(){
  const d = state.data;
  const sb = el('div',{},[]);

  // Tickers
  const q = (state.tickerQuery || '').trim().toUpperCase();
  const allTickers = Object.entries(d.tickers);
  const selectedCount = allTickers.filter(([t]) => state.filters[t]).length;
  let shown = allTickers;
  if (q) {
    shown = shown.filter(([t, m]) => t.includes(q) || (m.name||'').toUpperCase().includes(q));
  } else {
    // Without a search, show only what's selected so the list stays usable.
    shown = shown.filter(([t]) => state.filters[t]);
  }
  shown = shown.slice(0, 40);

  sb.appendChild(el('div',{class:'panel'},[
    el('div',{class:'panel-head'},[
      'Tickers',
      el('span',{style:'text-transform:none;letter-spacing:0'},[selectedCount + ' of ' + allTickers.length])
    ]),
    el('div',{class:'panel-body'},[
      el('input',{
        type:'search', placeholder:'Search ticker or company\u2026', value: state.tickerQuery || '',
        style:'width:100%;padding:6px 8px;margin-bottom:8px;border:1px solid var(--line);border-radius:2px;background:var(--paper);font:inherit;font-size:12px;color:var(--ink);',
        oninput:(e)=>{ state.tickerQuery = e.target.value; const pos=e.target.selectionStart; render();
          const box=document.querySelector('.panel-body input[type=search]');
          if(box){ box.focus(); box.setSelectionRange(pos,pos); } }
      }),
      !q && selectedCount === 0
        ? el('div',{class:'empty-note'},['Search above to add tickers.'])
        : null,
    ].concat(
      shown.map(([t, meta]) =>
        el('button',{class:'ticker-row', type:'button',
          'aria-pressed': String(!!state.filters[t]),
          onclick:async ()=>{ state.filters[t] = !state.filters[t]; render(); if(state.data.perTicker){ await ensureLoaded(); render(); } }},[
          el('span',{class:'ticker-label'},[
            el('span',{class:'swatch', style:'background:'+COLORS[t]}),
            t,
            el('span',{class:'ticker-name'},[meta.name]),
          ]),
          el('span',{class:'toggle' + (state.filters[t] ? ' on' : '')}),
        ])
      )
    ).concat([
      shown.length === 40 ? el('div',{class:'empty-note'},['Showing first 40 matches\u2026']) : null,
      el('div',{style:'margin-top:8px;padding-top:8px;border-top:1px solid var(--line-soft);'},[
        el('div',{style:'font-family:IBM Plex Mono,monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-soft);margin-bottom:4px;'},['Sources']),
        el('label',{class:'checkline'},[
          el('input',{type:'checkbox', checked: state.sources.curated ? 'checked' : null,
            onchange:(e)=>{ state.sources.curated = e.target.checked; render(); }}),
          'Curated catalysts'
        ]),
        el('label',{class:'checkline'},[
          el('input',{type:'checkbox', checked: state.sources.registry ? 'checked' : null,
            onchange:(e)=>{ state.sources.registry = e.target.checked; render(); }}),
          'ClinicalTrials.gov'
        ]),
        el('label',{class:'checkline'},[
          el('input',{type:'checkbox', checked: state.sources.edgar ? 'checked' : null,
            onchange:(e)=>{ state.sources.edgar = e.target.checked; render(); }}),
          'SEC EDGAR filings'
        ]),
      ])
    ]))
  ]));

  // Upcoming
  const upcoming = visibleEvents().filter(e => e.status === 'upcoming').slice(0, 8);
  sb.appendChild(el('div',{class:'panel'},[
    el('div',{class:'panel-head'},['Next Up']),
    el('div',{class:'panel-body'},
      upcoming.length
        ? upcoming.map(e => el('button',{class:'upcoming-item', type:'button', onclick:()=>goTo(e.date)},[
            el('span',{class:'upcoming-date'},[
              el('span',{class:'swatch', style:'width:7px;height:7px;background:'+COLORS[e.ticker]}),
              longDate(e.date) + (e.estimated ? ' (est.)' : '')
            ]),
            el('span',{class:'upcoming-title'},[e.title]),
          ]))
        : [el('div',{class:'empty-note'},['Nothing upcoming with these filters.'])]
    )
  ]));

  // About
  const notes = Object.entries(d.tickers).map(([t, meta]) =>
    el('p',{class:'about-text'},[el('b',{},[t + ' — ']), meta.note])
  );
  notes.push(el('p',{class:'about-text'},[
    'Dashed ', el('b',{},['est.']), ' badges are projected dates, not confirmed ones. Registry milestones come from ClinicalTrials.gov primary completion dates, which shift often.'
  ]));
  if((d.warnings||[]).length){
    notes.push(el('p',{class:'status-line err'},['Last build had ' + d.warnings.length + ' fetch warning(s); registry data may be stale.']));
  }
  sb.appendChild(el('div',{class:'panel'},[
    el('div',{class:'panel-head'},['About This Data']),
    el('div',{class:'panel-body'}, notes)
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

function main(){
  const kids = [ calendar() ];
  if(state.modalDate) kids.push(modal());
  return el('div',{}, kids);
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
