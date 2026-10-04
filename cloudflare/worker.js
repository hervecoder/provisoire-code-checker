// Cloudflare Worker: serves a clean, organized page for the Irembo provisoire
// (provisional driving-licence computer test) slot checker.
//
// Source of truth for the data is the private GitHub repo
// hervecoder/provisoire-code-checker, updated by the provisoire-check.yml
// workflow. This Worker is a read-only proxy + renderer over that repo.
//
// Routes:
//   GET  /                 -> server-rendered HTML page
//   GET  /api/result       -> organized slot data (JSON)
//   GET  /api/health       -> { ok, checked_at, districts_with_slots, total_slots }
//   GET  /api/shot?d=NAME  -> PNG screenshot for a district (from shots/NAME.png)
//   POST /api/dispatch     -> trigger the GitHub Actions workflow

const OWNER = 'hervecoder';
const REPO = 'provisoire-code-checker';
const WF = 'provisoire-check.yml';
const DISTRICTS = ['nyamasheke', 'nyarugenge', 'kicukiro'];
const SHOT_CACHE_SECONDS = 300;

// ---------------------------------------------------------------------------
// Slot parsing / organizing
// ---------------------------------------------------------------------------

// Read exam slots out of the rendered page text. A slot block looks like:
//   05-10-2026
//   NYAMASHEKE EXAMINATION CENTER (NYK)
//   8:00 AM - 9:00 AM
//   Imyanya
//   7
// (the label may also be "Umwanya"). We require a date line, a time line and
// the slot label, but not a specific center name, so new centers still parse.
function parseSlots(text) {
  const rows = [];
  const re = /(\d{2}-\d{2}-\d{4})\s*\n([^\n]+)\n([^\n]*?\d{1,2}:\d{2}\s*(?:AM|PM)[^\n]*)\n(?:Imyanya|Umwanya)\s*\n(\d+)/gi;
  let m;
  while ((m = re.exec(text || '')) && rows.length < 20) {
    rows.push({
      date: m[1],
      center: m[2].trim(),
      time: m[3].trim(),
      slots: Number(m[4]),
    });
  }
  return rows;
}

function organize(raw) {
  const src = raw || {};
  const out = {
    checked_at: src.finished_at || null,
    steps: Array.isArray(src.steps) ? src.steps : [],
    error: src.error || null,
    verify_error: src.verify_error || null,
    districts: {},
  };
  let total = 0;
  let withSlots = 0;
  for (const key of DISTRICTS) {
    const D = (src.districts || {})[key] || {};
    const text = D.text || src.slot_text || '';
    const rows = parseSlots(text);
    const none = /nta myanya/i.test(text);
    const count = rows.reduce((a, r) => a + r.slots, 0);
    out.districts[key] = {
      slots: rows.length > 0,
      count,
      rows,
      error: D.error || null,
      note: none ? 'Nta myanya yabonetse' : rows.length ? rows.length + ' amasaha afite imyanya' : 'Nta makuru',
    };
    if (rows.length > 0) withSlots += 1;
    total += count;
  }
  out.districts_with_slots = withSlots;
  out.total_slots = total;
  return out;
}

// ---------------------------------------------------------------------------
// HTTP entry
// ---------------------------------------------------------------------------

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const gh = (path, init) =>
      fetch('https://api.github.com' + path, {
        ...(init || {}),
        headers: {
          Authorization: 'Bearer ' + env.GITHUB_TOKEN,
          'User-Agent': 'provisoire-slots',
          Accept: 'application/vnd.github+json',
          ...(init && init.headers ? init.headers : {}),
        },
      });

    const readResult = async () => {
      const r = await gh(`/repos/${OWNER}/${REPO}/contents/result.json?ref=main`);
      if (!r.ok) throw new Error('github ' + r.status);
      const j = await r.json();
      return organize(JSON.parse(atob(j.content.replace(/\n/g, ''))));
    };

    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        let data = null;
        let err = null;
        try {
          data = await readResult();
        } catch (e) {
          err = String((e && e.message) || e);
        }
        return new Response(pageHtml(data, err), {
          headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'public, max-age=60' },
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/result') {
        try {
          return Response.json(await readResult(), {
            headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
          });
        } catch (e) {
          return Response.json({ error: String((e && e.message) || e) }, { status: 502 });
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/health') {
        try {
          const d = await readResult();
          return Response.json({
            ok: true,
            checked_at: d.checked_at,
            districts_with_slots: d.districts_with_slots,
            total_slots: d.total_slots,
          });
        } catch (e) {
          return Response.json({ ok: false, error: String((e && e.message) || e) }, { status: 502 });
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/shot') {
        const d = (url.searchParams.get('d') || '').toLowerCase();
        if (!DISTRICTS.includes(d)) return new Response('bad district', { status: 400 });
        const r = await gh(`/repos/${OWNER}/${REPO}/contents/shots/${d}.png?ref=main`);
        if (!r.ok) return new Response('no shot yet', { status: 404 });
        const j = await r.json();
        const bin = Uint8Array.from(atob(j.content.replace(/\n/g, '')), (c) => c.charCodeAt(0));
        return new Response(bin, {
          headers: {
            'content-type': 'image/png',
            // version comes from ?v=<checked_at>, so caching is safe and current.
            'cache-control': `public, max-age=${SHOT_CACHE_SECONDS}`,
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/dispatch') {
        const r = await gh(`/repos/${OWNER}/${REPO}/actions/workflows/${WF}/dispatches`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: 'main' }),
        });
        return Response.json({ ok: r.ok, status: r.status });
      }
    } catch (e) {
      return new Response('error: ' + String((e && e.message) || e), { status: 500 });
    }

    return new Response('Not found', { status: 404 });
  },
};

// Renders the dynamic body (#app). Self-contained on purpose: the same source
// is inlined into the page for client-side re-rendering after a refresh.
function renderBody(data) {
  var LIST = [['nyamasheke', 'Nyamasheke'], ['nyarugenge', 'Nyarugenge'], ['kicukiro', 'Kicukiro']];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtAbs(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    try {
      return d.toLocaleString('en-GB', { timeZone: 'Africa/Kigali', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return d.toISOString().slice(0, 16).replace('T', ' ');
    }
  }
  function rel(iso) {
    if (!iso) return '';
    var t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    var s = Math.floor((Date.now() - t) / 1000);
    if (s < 0) return 'right now';
    if (s < 90) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }

  if (!data || !data.districts) {
    return '<div class="empty">Nta makuru abonetse. Kanda <b>Reba</b> hejuru kugenzura imyanya.</div>';
  }

  var ver = encodeURIComponent(data.checked_at || '');
  var totalH = '';
  totalH += '<div class="stat"><b>' + data.districts_with_slots + '<span class="of">/' + LIST.length + '</span></b><small>Akarere gafite imyanya</small></div>';
  totalH += '<div class="stat"><b>' + data.total_slots + '</b><small>Imyanya yose ihari</small></div>';
  totalH += '<div class="stat"><b>' + esc(fmtAbs(data.checked_at)) + '</b><small>Byagenzuwe ' + esc(rel(data.checked_at)) + '</small></div>';

  var stepH = '';
  if (data.error) {
    stepH = '<div class="banner err">Ikosa: ' + esc(data.error) + '</div>';
  } else if (data.steps && data.steps.length) {
    stepH = '<div class="banner info">Intambwe yagezweho: ' + esc(data.steps.join(' → ')) + '</div>';
  }

  function rowsHtml(D) {
    if (!D.rows || !D.rows.length) {
      return '<div class="noRows">' + esc(D.error || D.note || 'Nta myanya') + '</div>';
    }
    var h = '<table><thead><tr><th>Itariki</th><th>Aho</th><th>Igihe</th><th class="num">Imyanya</th></tr></thead><tbody>';
    D.rows.forEach(function (r) {
      h += '<tr><td>' + esc(r.date) + '</td><td>' + esc(r.center) + '</td><td>' + esc(r.time) + '</td><td class="num"><b>' + esc(r.slots) + '</b></td></tr>';
    });
    return h + '</tbody></table>';
  }

  function shotHtml(key, D) {
    var src = '/api/shot?d=' + key + '&v=' + ver;
    return (
      '<figure class="shot"><a href="' + src + '" target="_blank" rel="noopener">' +
      '<img loading="lazy" src="' + src + '" alt="Akarere ' + key + '" ' +
      'onerror="this.parentNode.classList.add(&quot;miss&quot;)">' +
      '</a><figcaption class="fallback">Nta ifoto yafashwe</figcaption></figure>'
    );
  }

  var cards = LIST.map(function (pair) {
    var key = pair[0], name = pair[1];
    var D = data.districts[key] || {};
    var state = D.error ? 'err' : D.slots ? 'yes' : 'no';
    var label = D.error ? 'Ikosa' : D.slots ? 'Imyanya ihari' : 'Nta myanya';
    return (
      '<article class="card">' +
        '<div class="cardHead">' +
          '<div><h3>' + esc(name) + '</h3>' +
          '<div class="sub">' + esc(D.note || '') + '</div></div>' +
          '<div class="badge ' + state + '">' + esc(label) + (D.count ? ' · ' + D.count : '') + '</div>' +
        '</div>' +
        '<div class="cardBody">' + rowsHtml(D) + '</div>' +
        '<div class="cardFoot"><div class="shotLabel">Ifoto ya ' + esc(name) + ' (intambwe yagezweho)</div>' + shotHtml(key, D) + '</div>' +
      '</article>'
    );
  }).join('');

  return '<section class="stats">' + totalH + '</section>' + stepH + '<section class="grid">' + cards + '</section>';
}

function pageHtml(data, err) {
  const body = renderBody(data);
  const boot = JSON.stringify(data || null).replace(/</g, '\\u003c');
  const errBanner = err
    ? '<div class="banner err">Ntibyashoboye kubona amakuru: ' +
      String(err).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) +
      '</div>'
    : '';

  return `<!doctype html>
<html lang="rw">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Provisoire Slots — imyanya y'ikizamini</title>
<meta name="description" content="Reba imyanya bihari mu kizamini cy'uruhushya rw'agateganyo (provisoire) ku karere, bivugururwa na GitHub Actions.">
<meta property="og:title" content="Provisoire Slots">
<meta property="og:description" content="Imyanya y'ikizamini cy'uruhushya rw'agateganyo ku karere.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚗</text></svg>">
<style>
  :root{
    --bg:#0b1220; --panel:#121a2b; --panel2:#0f1726; --text:#e6edf7; --muted:#94a3b8;
    --line:#22304a; --accent:#3b82f6; --ok:#22c55e; --bad:#ef4444; --warn:#f59e0b; --radius:14px;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
    font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
  a{color:inherit}
  .wrap{max-width:1120px;margin:0 auto;padding:0 18px}
  header{position:sticky;top:0;z-index:10;background:rgba(11,18,32,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
  .head{display:flex;align-items:center;gap:14px;padding:14px 0;flex-wrap:wrap}
  .logo{font-size:26px;line-height:1}
  .title{font-weight:700;font-size:17px;letter-spacing:-.01em}
  .title span{display:block;color:var(--muted);font-weight:500;font-size:12.5px}
  .spacer{flex:1}
  .btn{background:var(--accent);color:#fff;border:0;border-radius:10px;padding:10px 16px;font-size:14.5px;
    font-weight:600;cursor:pointer;font-family:inherit}
  .btn:hover{filter:brightness(1.08)}
  .btn:disabled{opacity:.55;cursor:progress}
  #status{color:var(--muted);font-size:13px;min-width:60px}
  main{padding:22px 0 56px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px}
  .stat{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px}
  .stat b{display:block;font-size:22px;font-weight:700;letter-spacing:-.02em}
  .stat b .of{color:var(--muted);font-size:15px;font-weight:500}
  .stat small{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.05em}
  .banner{border-radius:var(--radius);padding:11px 15px;margin-bottom:16px;font-size:13.5px;border:1px solid var(--line);word-break:break-word}
  .banner.info{background:var(--panel2);color:var(--muted)}
  .banner.err{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.4);color:#fca5a5}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;display:flex;flex-direction:column}
  .cardHead{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line)}
  .cardHead h3{margin:0;font-size:16px;letter-spacing:-.01em}
  .cardHead .sub{color:var(--muted);font-size:12.5px;margin-top:2px}
  .badge{font-size:12px;font-weight:700;padding:4px 11px;border-radius:999px;white-space:nowrap}
  .badge.yes{background:rgba(34,197,94,.15);color:var(--ok);border:1px solid rgba(34,197,94,.4)}
  .badge.no{background:rgba(148,163,184,.12);color:var(--muted);border:1px solid var(--line)}
  .badge.err{background:rgba(239,68,68,.15);color:#fca5a5;border:1px solid rgba(239,68,68,.4)}
  .cardBody{padding:6px 6px 10px;flex:1}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line)}
  thead th{color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--line)}
  tbody tr:last-child td{border-bottom:0}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
  td.num b{color:var(--ok)}
  .noRows{padding:18px 14px;color:var(--muted);font-size:13.5px;text-align:center}
  .cardFoot{padding:12px 16px 16px;border-top:1px solid var(--line)}
  .shotLabel{color:var(--muted);font-size:12px;margin-bottom:8px}
  .shot{margin:0;position:relative}
  .shot a{display:block;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--panel2)}
  .shot img{display:block;width:100%;height:auto}
  .shot .fallback{display:none;padding:26px 12px;text-align:center;color:var(--muted);font-size:13px}
  .shot.miss a{display:none}
  .shot.miss .fallback{display:block;border:1px dashed var(--line);border-radius:10px}
  .empty{background:var(--panel);border:1px dashed var(--line);border-radius:var(--radius);padding:44px 22px;text-align:center;color:var(--muted)}
  footer{border-top:1px solid var(--line);padding:20px 0;color:var(--muted);font-size:13px}
  footer a{color:var(--accent);text-decoration:none}
  @media(max-width:520px){.head{gap:10px}.title{font-size:15px}}
</style>
</head>
<body>
<header>
  <div class="wrap head">
    <div class="logo">🚗</div>
    <div class="title">Provisoire Slots
      <span>Imyanya y'ikizamini cy'uruhushya rw'agateganyo</span>
    </div>
    <div class="spacer"></div>
    <span id="status"></span>
    <button class="btn" id="refresh">Reba imyanya</button>
  </div>
</header>

<main class="wrap">
  ${errBanner}
  <div id="app">${body}</div>
</main>

<footer>
  <div class="wrap">
    Amakuru: <a href="https://irembo.gov.rw/" target="_blank" rel="noopener">irembo.gov.rw</a>
    · agenzurwa na
    <a href="https://github.com/${OWNER}/${REPO}" target="_blank" rel="noopener">provisoire-code-checker</a>
    · ikorera kuri Cloudflare Workers
  </div>
</footer>

<script id="boot" type="application/json">${boot}</script>
<script>
${renderBody.toString()}
(function(){
  var app = document.getElementById('app');
  var btn = document.getElementById('refresh');
  var statusEl = document.getElementById('status');
  function status(t){ if (statusEl) statusEl.textContent = t || ''; }
  function paint(d){ if (app) app.innerHTML = renderBody(d); }
  function run(){
    if (btn) btn.disabled = true;
    status('Turagenzura... (hafi iminota 2)');
    fetch('/api/dispatch', { method: 'POST' }).catch(function(){}).then(function(){
      var i = 0;
      (function tick(){
        fetch('/api/result', { cache: 'no-store' }).then(function(r){ return r.json(); }).then(function(d){
          if (d && d.districts) paint(d);
          if (d && d.checked_at && (Date.now() - new Date(d.checked_at).getTime()) < 240000) {
            status('Byavuguruwe: ' + d.checked_at);
            if (btn) btn.disabled = false;
            return;
          }
          i++;
          if (i < 20) { status('Kugenzura... ' + i + '/20'); setTimeout(tick, 15000); }
          else { status('Biracyakorwa — ongera ugerageze.'); if (btn) btn.disabled = false; }
        }).catch(function(){
          i++;
          if (i < 20) { status('Kugenzura... ' + i + '/20'); setTimeout(tick, 15000); }
          else { status('Habaye ikibazo.'); if (btn) btn.disabled = false; }
        });
      })();
    });
  }
  if (btn) btn.addEventListener('click', run);
})();
</script>
</body>
</html>`;
}
