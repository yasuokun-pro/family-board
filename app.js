/* ===================================================================
   家族ボード / Family Board  — app.js
   データ元: Google カレンダー → Google Apps Script(JSON) → ここ
   iOS 15/16 Safari 互換のため ES2020 相当の書き方に留めています。
   =================================================================== */
'use strict';

/* ------------------------------------------------------------------
   1. メンバー定義（キーは GAS 側 Code.gs の MEMBERS と一致させること）
   ------------------------------------------------------------------ */
var MEMBERS = [
  { key: 'father',   label: '父',   color: '#8FA0B5' },  /* グレー */
  { key: 'mother',   label: '母',   color: '#FF7AA8' },  /* ピンク */
  { key: 'son1',     label: '長男', color: '#4FA3FF' },  /* 青 */
  { key: 'son2',     label: '次男', color: '#4ED9A4' },  /* 緑 */
  { key: 'daughter', label: '長女', color: '#FFD84D' }   /* 黄 */
];
var SHARED = { key: 'shared', label: 'みんな', color: '#B98BFF' };

/* ------------------------------------------------------------------
   2. 設定（localStorage）
   ------------------------------------------------------------------ */
var DEFAULTS = {
  endpoint: '',
  startHour: 6,
  endHour: 23,
  refreshMin: 5,
  burnin: true,
  labels: {},
  place: null      /* {query, name, lat, lon} — 端末にだけ保存される */
};

function loadCfg() {
  var cfg = {};
  for (var k in DEFAULTS) { if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) cfg[k] = DEFAULTS[k]; }
  try {
    var raw = localStorage.getItem('fb.cfg');
    if (raw) {
      var got = JSON.parse(raw);
      for (var j in got) { if (Object.prototype.hasOwnProperty.call(got, j)) cfg[j] = got[j]; }
    }
  } catch (e) {}
  return cfg;
}
function saveCfg(cfg) {
  try { localStorage.setItem('fb.cfg', JSON.stringify(cfg)); } catch (e) {}
}

var CFG = loadCfg();

/* URLに ?endpoint=... が付いていたら、その場で設定として取り込む。
   ホーム画面に追加した「アプリ版」とSafariで開いたタブは端末上では
   別々のlocalStorageを持つため、ウィジェットなど外部からURLを開いたときに
   ⚙で設定したはずの取得URLが無く、デモ表示になってしまう問題への対処。 */
(function () {
  try {
    var qp = new URLSearchParams(location.search).get('endpoint');
    if (qp) {
      CFG.endpoint = qp;
      saveCfg(CFG);
      if (window.history && history.replaceState) {
        history.replaceState(null, '', location.pathname);
      }
    }
  } catch (e) {}
})();

function memberList() {
  return MEMBERS.map(function (m) {
    return { key: m.key, color: m.color, label: (CFG.labels && CFG.labels[m.key]) || m.label };
  });
}
function memberByKey(key) {
  var all = memberList().concat([SHARED]);
  for (var i = 0; i < all.length; i++) { if (all[i].key === key) return all[i]; }
  return SHARED;
}

/* ------------------------------------------------------------------
   3. 日付ユーティリティ（すべて端末のローカル時刻＝日本時間で扱う）
   ------------------------------------------------------------------ */
var DOW = ['日', '月', '火', '水', '木', '金', '土'];

function pad2(n) { return (n < 10 ? '0' : '') + n; }
function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0); }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 0, 0, 0, 0); }
function minsOfDay(d) { return d.getHours() * 60 + d.getMinutes(); }
function hhmm(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }

/* ------------------------------------------------------------------
   4. 状態
   ------------------------------------------------------------------ */
var STATE = {
  events: [],        // {id, member, title, start:Date, end:Date, allDay, location}
  holidays: {},      // {"YYYY-MM-DD": "敬老の日"}
  viewDate: startOfDay(new Date()),
  monthMode: false,  // true: 月間一覧 / false: 1日タイムライン
  lastFetch: 0,
  lastTouch: Date.now(),
  fetching: false
};

var $ = function (id) { return document.getElementById(id); };

/* ------------------------------------------------------------------
   5. デモ用データ（取得URL未設定のとき）
   ------------------------------------------------------------------ */
function demoEvents() {
  var base = startOfDay(new Date());
  var defs = [
    [0, 'father',   '出勤',            8, 0, 18, 30, '本社'],
    [0, 'mother',   'パート',          9, 0, 14, 0,  ''],
    [0, 'mother',   '買い物',         16, 0, 17, 0,  'イオン'],
    [0, 'son1',     '学校',            8, 20, 15, 30, ''],
    [0, 'son1',     'サッカー練習',   17, 0, 19, 0,  '河川敷グラウンド'],
    [0, 'son2',     '学校',            8, 20, 15, 0,  ''],
    [0, 'son2',     'ピアノ',         16, 30, 17, 30, ''],
    [0, 'daughter', '保育園',          8, 45, 16, 30, ''],
    [0, 'shared',   '夕食 カレー',    19, 0, 20, 0,  ''],
    [1, 'father',   '在宅勤務',        9, 0, 18, 0,  ''],
    [1, 'son1',     '練習試合',        9, 0, 12, 0,  '市営グラウンド'],
    [1, 'mother',   '歯医者',         10, 30, 11, 30, ''],
    [1, 'daughter', '発表会リハ',     14, 0, 15, 30, ''],
    [2, 'shared',   '家族で映画',     13, 0, 16, 0,  ''],
    [3, 'father',   '出張',            0, 0, 0, 0,   '大阪'],
    [4, 'son2',     '遠足',            0, 0, 0, 0,   '']
  ];
  var out = [];
  for (var i = 0; i < defs.length; i++) {
    var d = defs[i];
    var day = addDays(base, d[0]);
    var allDay = (d[3] === 0 && d[4] === 0 && d[5] === 0 && d[6] === 0);
    out.push({
      id: 'demo' + i,
      member: d[1],
      title: d[2],
      allDay: allDay,
      start: allDay ? day : new Date(day.getFullYear(), day.getMonth(), day.getDate(), d[3], d[4]),
      end:   allDay ? addDays(day, 1) : new Date(day.getFullYear(), day.getMonth(), day.getDate(), d[5], d[6]),
      location: d[7]
    });
  }
  return out;
}

/* ------------------------------------------------------------------
   6. データ取得
   ------------------------------------------------------------------ */
function setStatus(text, isErr) {
  var el = $('status');
  el.textContent = text;
  el.className = 'status' + (isErr ? ' err' : '');
}

/* "2026-09-06" のような日付だけの文字列は、ローカルの0時として解釈する。
   new Date("2026-09-06") はUTCの0時＝日本時間の朝9時になってしまうため、
   終日予定が翌日にはみ出す。時刻付きのISO文字列はそのまま解釈する。 */
function parseWhen(v, allDay) {
  if (allDay && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    var p = v.split('-');
    return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10), 0, 0, 0, 0);
  }
  return new Date(v);
}

function parseEvents(list) {
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    var s = parseWhen(e.start, e.allDay);
    var en = parseWhen(e.end, e.allDay);
    if (isNaN(s.getTime()) || isNaN(en.getTime())) continue;
    out.push({
      id: e.id || ('e' + i),
      member: e.member || 'shared',
      title: e.title || '(無題)',
      allDay: !!e.allDay,
      start: s,
      end: en,
      location: e.location || ''
    });
  }
  return out;
}

function cacheSave(payload) {
  try { localStorage.setItem('fb.cache', JSON.stringify(payload)); } catch (e) {}
}
function cacheLoad() {
  try {
    var raw = localStorage.getItem('fb.cache');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

function fetchData(silent) {
  if (STATE.fetching) return;

  if (!CFG.endpoint) {
    STATE.events = demoEvents();
    STATE.holidays = {};
    STATE.lastFetch = Date.now();
    setStatus('デモ表示');
    renderAll();
    return;
  }

  STATE.fetching = true;
  if (!silent) setStatus('更新中…');

  var url = CFG.endpoint + (CFG.endpoint.indexOf('?') >= 0 ? '&' : '?') + 'days=90&_=' + Date.now();

  fetch(url, { method: 'GET', redirect: 'follow', cache: 'no-store' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (data) {
      if (!data || data.ok === false) throw new Error(data && data.error ? data.error : '不正な応答');
      STATE.events = parseEvents(data.events || []);
      STATE.holidays = data.holidays || {};
      STATE.lastFetch = Date.now();
      cacheSave({ events: data.events || [], holidays: data.holidays || {}, at: Date.now() });
      setStatus('更新 ' + hhmm(new Date()));
      renderAll();
    })
    .catch(function (err) {
      var cached = cacheLoad();
      if (cached && STATE.events.length === 0) {
        STATE.events = parseEvents(cached.events || []);
        STATE.holidays = cached.holidays || {};
        renderAll();
      }
      setStatus('取得できません（' + String(err.message || err).slice(0, 24) + '）', true);
    })
    .then(function () { STATE.fetching = false; });
}

/* ------------------------------------------------------------------
   7. 時計
   ------------------------------------------------------------------ */
var lastDayKey = '';

function tickClock() {
  var now = new Date();
  $('ck-h').textContent = pad2(now.getHours());
  $('ck-m').textContent = pad2(now.getMinutes());
  $('ck-colon').className = 'colon' + (now.getSeconds() % 2 ? ' off' : '');

  $('ck-date').textContent = (now.getMonth() + 1) + '月' + now.getDate() + '日';
  var dow = $('ck-dow');
  dow.textContent = DOW[now.getDay()];
  dow.className = 'dow' + (now.getDay() === 0 ? ' sun' : now.getDay() === 6 ? ' sat' : '');

  var hol = STATE.holidays[ymd(now)] || '';
  $('ck-holiday').textContent = hol;

  // 日付が変わったら今日へ戻して全再描画
  var key = ymd(now);
  if (key !== lastDayKey) {
    lastDayKey = key;
    STATE.viewDate = startOfDay(now);
    renderAll();
    fetchData(true);
  }

  updateNowLine();
}

/* ------------------------------------------------------------------
   8. 月カレンダー
   ------------------------------------------------------------------ */
/* 予定を開始日ごとにグループ化（複数日にまたがる予定は開始日にのみ出す） */
function groupEventsByDay() {
  var byDay = {};
  for (var i = 0; i < STATE.events.length; i++) {
    var e = STATE.events[i];
    var k = ymd(e.start);
    if (!byDay[k]) byDay[k] = [];
    byDay[k].push(e);
  }
  for (var key in byDay) {
    if (Object.prototype.hasOwnProperty.call(byDay, key)) {
      byDay[key].sort(function (a, b) {
        if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
        return a.start - b.start;
      });
    }
  }
  return byDay;
}

function renderCalendar() {
  var view = STATE.viewDate;
  var today = startOfDay(new Date());
  var y = view.getFullYear(), m = view.getMonth();

  $('cal-title').textContent = y + '年 ' + (m + 1) + '月';

  var first = new Date(y, m, 1);
  var gridStart = addDays(first, -first.getDay());
  var byDay = groupEventsByDay();

  var order = memberList().concat([SHARED]);
  var html = '';
  for (var c = 0; c < 42; c++) {
    var d = addDays(gridStart, c);
    var key = ymd(d);
    var cls = 'cal-cell';
    if (d.getMonth() !== m) cls += ' out';
    else if (STATE.holidays[key]) cls += ' hol';
    else if (d.getDay() === 0) cls += ' sun';
    else if (d.getDay() === 6) cls += ' sat';
    if (key === ymd(today)) cls += ' today';
    else if (key === ymd(view)) cls += ' viewed';

    var present = {};
    if (byDay[key]) {
      for (var j = 0; j < byDay[key].length; j++) present[byDay[key][j].member] = true;
    }
    var dots = '';
    for (var q = 0; q < order.length; q++) {
      if (present[order[q].key]) dots += '<i style="color:' + order[q].color + '"></i>';
    }
    html += '<div class="' + cls + '">' + d.getDate() +
            (dots ? '<span class="cal-dots">' + dots + '</span>' : '') + '</div>';
  }
  $('cal-grid').innerHTML = html;
}

/* ------------------------------------------------------------------
   9. 「このあと」リスト
   ------------------------------------------------------------------ */
function renderNextUp() {
  var now = new Date();
  var today = startOfDay(now);
  var limit = addDays(today, 8);
  var up = STATE.events.filter(function (e) {
    return e.allDay ? (e.end > now && e.start < limit) : (e.end > now && e.start < limit);
  }).sort(function (a, b) { return a.start - b.start; }).slice(0, 7);

  var html = '<div class="nu-title">このあと</div>';
  if (up.length === 0) {
    html += '<div class="nu-item" style="color:#33414F">しばらく予定なし</div>';
  }
  for (var i = 0; i < up.length; i++) {
    var e = up[i];
    var mem = memberByKey(e.member);
    var diff = Math.round((startOfDay(e.start) - today) / 86400000);
    var when;
    if (e.allDay) {
      when = diff <= 0 ? '終日' : diff === 1 ? '明日' : (e.start.getMonth() + 1) + '/' + e.start.getDate();
    } else if (diff === 0) {
      when = hhmm(e.start);
    } else if (diff === 1) {
      when = '明日 ' + hhmm(e.start);
    } else {
      when = (e.start.getMonth() + 1) + '/' + e.start.getDate() + ' ' + hhmm(e.start);
    }
    html += '<div class="nu-item" style="color:' + mem.color + '">' +
              '<span class="nu-chip"></span>' +
              '<span class="nu-time">' + when + '</span>' +
              '<b>' + esc(e.title) + '</b>' +
            '</div>';
  }
  var box = $('next-up');
  box.innerHTML = html;

  // 天気の有無で高さが変わるので、下端で半端に切れる行を消す。
  // offsetTop は位置指定された祖先からの距離になるため使わず、実座標で比べる。
  var boxRect = box.getBoundingClientRect();
  var items = box.querySelectorAll('.nu-item');
  for (var k = items.length - 1; k >= 0; k--) {
    if (items[k].getBoundingClientRect().bottom > boxRect.bottom + 1) {
      items[k].parentNode.removeChild(items[k]);
    } else {
      break;
    }
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
  });
}

/* ------------------------------------------------------------------
   9.5 天気（Open-Meteo / APIキー不要・CORS対応）
   地点はリポジトリに持たず、⚙で入れた市区町村名を座標に変換して
   その端末の localStorage にだけ保存する。
   ------------------------------------------------------------------ */
var WX = { daily: null, current: null, lastFetch: 0 };

/* WMO天気コード → 絵文字と日本語 */
function wxMark(code, isDay) {
  var day = (isDay === undefined) ? 1 : isDay;
  var t = {
    0:  [day ? '☀️' : '🌙', '快晴'],
    1:  [day ? '🌤' : '🌙', '晴れ'],
    2:  ['⛅️', 'くもり時々晴れ'],
    3:  ['☁️', 'くもり'],
    45: ['🌫', '霧'],      48: ['🌫', '霧'],
    51: ['🌦', '霧雨'],    53: ['🌦', '霧雨'],    55: ['🌦', '霧雨'],
    56: ['🌧', '着氷性の霧雨'], 57: ['🌧', '着氷性の霧雨'],
    61: ['🌧', '雨'],      63: ['🌧', '雨'],      65: ['🌧', '強い雨'],
    66: ['🌧', '着氷性の雨'],   67: ['🌧', '着氷性の雨'],
    71: ['❄️', '雪'],      73: ['❄️', '雪'],      75: ['❄️', '大雪'],
    77: ['❄️', '霧雪'],
    80: ['🌦', 'にわか雨'], 81: ['🌦', 'にわか雨'], 82: ['🌧', '激しいにわか雨'],
    85: ['🌨', 'にわか雪'], 86: ['🌨', 'にわか雪'],
    95: ['⛈', '雷雨'],     96: ['⛈', '雷雨'],     99: ['⛈', 'ひょうを伴う雷雨']
  };
  return t[code] || ['—', ''];
}

function fetchWeather() {
  var p = CFG.place;
  if (!p || typeof p.lat !== 'number') { renderWeather(); return; }

  var url = 'https://api.open-meteo.com/v1/forecast' +
            '?latitude=' + p.lat + '&longitude=' + p.lon +
            '&current=temperature_2m,weather_code,is_day' +
            '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
            '&timezone=Asia%2FTokyo&forecast_days=8';

  fetch(url, { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (d) {
      WX.current = d.current || null;
      WX.daily = d.daily || null;
      WX.lastFetch = Date.now();
      try { localStorage.setItem('fb.wx', JSON.stringify({ current: WX.current, daily: WX.daily, at: Date.now() })); } catch (e) {}
      renderWeather();
    })
    .catch(function () { renderWeather(); });
}

function renderWeather() {
  var box = $('wx');
  if (!CFG.place || typeof CFG.place.lat !== 'number') { box.hidden = true; return; }
  box.hidden = false;

  $('wx-place').textContent = CFG.place.admin1 || CFG.place.name || '';

  if (!WX.daily || !WX.daily.time) {
    $('wx-icon').textContent = '…';
    $('wx-t').textContent = '--';
    $('wx-hl').textContent = '';
    $('wx-pop').textContent = '';
    return;
  }

  var key = ymd(STATE.viewDate);
  var idx = WX.daily.time.indexOf(key);
  if (idx < 0) {   // 予報の範囲外（8日より先など）
    $('wx-icon').textContent = '—';
    $('wx-t').textContent = '--';
    $('wx-hl').textContent = '予報なし';
    $('wx-pop').textContent = '';
    return;
  }

  var isToday = (key === ymd(new Date()));
  var hi = Math.round(WX.daily.temperature_2m_max[idx]);
  var lo = Math.round(WX.daily.temperature_2m_min[idx]);
  var pop = WX.daily.precipitation_probability_max[idx];

  var code, isDay, big;
  if (isToday && WX.current) {
    code = WX.current.weather_code;
    isDay = WX.current.is_day;
    big = Math.round(WX.current.temperature_2m);
  } else {
    code = WX.daily.weather_code[idx];
    isDay = 1;
    big = hi;
  }

  var mk = wxMark(code, isDay);
  $('wx-icon').textContent = mk[0];
  $('wx-icon').setAttribute('title', mk[1]);
  $('wx-t').textContent = big;
  $('wx-hl').textContent = hi + '° / ' + lo + '°';
  $('wx-pop').textContent = (pop === null || pop === undefined) ? '' : '☂ ' + pop + '%';
}

/* 市区町村名 → 候補リスト（Open-Meteo のジオコーディング）
   同名地名が多いので、先頭を勝手に採用せず候補を返してユーザーに選ばせる。
   （例:「松本」は長野県松本市のほかに沖縄県の松本もヒットする） */
function geocode(name) {
  var url = 'https://geocoding-api.open-meteo.com/v1/search?name=' +
            encodeURIComponent(name) + '&count=8&language=ja&format=json';
  return fetch(url, { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var list = (j && j.results) ? j.results : [];
      // 日本国内を先に並べる
      list.sort(function (a, b) {
        var aj = (a.country_code === 'JP') ? 0 : 1;
        var bj = (b.country_code === 'JP') ? 0 : 1;
        return aj - bj;
      });
      return list.map(function (g) {
        return {
          query: name,
          name: g.name,
          admin1: g.admin1 || '',
          country: g.country || '',
          countryCode: g.country_code || '',
          lat: g.latitude,
          lon: g.longitude
        };
      });
    });
}

/* 候補を設定画面に並べる */
function renderPlaceCandidates(list) {
  var box = $('s-place-results');
  if (!list || !list.length) { box.innerHTML = ''; return; }

  var html = '';
  for (var i = 0; i < list.length; i++) {
    var g = list[i];
    var where = [g.admin1, (g.countryCode === 'JP' ? '' : g.country)]
                  .filter(function (x) { return !!x; }).join(' / ');
    html += '<button type="button" class="place-opt" data-i="' + i + '">' +
              '<b>' + esc(g.name) + '</b>' +
              (where ? '<span>' + esc(where) + '</span>' : '') +
              '<em>' + g.lat.toFixed(2) + ', ' + g.lon.toFixed(2) + '</em>' +
            '</button>';
  }
  box.innerHTML = html;

  var btns = box.querySelectorAll('.place-opt');
  for (var b = 0; b < btns.length; b++) {
    btns[b].addEventListener('click', function (ev) {
      var idx = parseInt(ev.currentTarget.getAttribute('data-i'), 10);
      CFG.place = list[idx];
      WX.daily = null; WX.current = null;
      box.innerHTML = '';
      finishSave();
    });
  }
}

/* ------------------------------------------------------------------
   10. タイムライン本体
   ------------------------------------------------------------------ */
function eventsOn(day) {
  var s = startOfDay(day), e = addDays(s, 1);
  return STATE.events.filter(function (ev) { return ev.start < e && ev.end > s; });
}

/* 同じレーン内で時間が重なる予定を横に並べるための列割り当て */
function packLane(list) {
  var sorted = list.slice().sort(function (a, b) {
    return (a.start - b.start) || (b.end - a.end);
  });
  var cols = [];   // 各列の「最後の終了時刻」
  for (var i = 0; i < sorted.length; i++) {
    var ev = sorted[i];
    var placed = false;
    for (var c = 0; c < cols.length; c++) {
      if (cols[c] <= ev.start.getTime()) {
        ev._col = c; cols[c] = ev.end.getTime(); placed = true; break;
      }
    }
    if (!placed) { ev._col = cols.length; cols.push(ev.end.getTime()); }
  }
  var total = Math.max(1, cols.length);
  for (var j = 0; j < sorted.length; j++) sorted[j]._cols = total;
  return sorted;
}

function renderBoard() {
  var day = STATE.viewDate;
  var today = startOfDay(new Date());
  var dayEvents = eventsOn(day);

  // 未割り当て/共有の予定がある日だけ「みんな」レーンを足す
  var members = memberList();
  var hasShared = dayEvents.some(function (e) { return e.member === SHARED.key; });
  var lanes = hasShared ? members.concat([SHARED]) : members;

  document.documentElement.style.setProperty('--lane-count', lanes.length);

  /* --- 見出し --- */
  var diff = Math.round((day - today) / 86400000);
  var label = diff === 0 ? '今日' : diff === 1 ? '明日' : diff === -1 ? '昨日' : '';
  $('board-date').textContent = (day.getMonth() + 1) + '/' + day.getDate() + '（' + DOW[day.getDay()] + '）' + (label ? ' ' + label : '');
  var hol = STATE.holidays[ymd(day)];
  $('board-sub').textContent = hol ? hol : (dayEvents.length + ' 件');

  var headHtml = '<div></div>';
  for (var i = 0; i < lanes.length; i++) {
    var mem = lanes[i];
    var cnt = dayEvents.filter(function (e) { return e.member === mem.key; }).length;
    headHtml += '<div class="lh" style="--c:' + mem.color + '">' + esc(mem.label) +
                '<span class="lh-n">' + (cnt ? cnt + ' 件' : '—') + '</span></div>';
  }
  $('lanes-head').innerHTML = headHtml;

  /* --- 終日予定バンド --- */
  var adAny = dayEvents.some(function (e) { return e.allDay; });
  var adHtml = '<div class="ad-cell">' + (adAny ? '<span class="ad-lbl">終日</span>' : '') + '</div>';
  for (var a = 0; a < lanes.length; a++) {
    var mm = lanes[a];
    var ads = dayEvents.filter(function (e) { return e.allDay && e.member === mm.key; });
    var inner = '';
    for (var b = 0; b < ads.length; b++) {
      inner += '<div class="ad-ev" style="--c:' + mm.color + '">' + esc(ads[b].title) + '</div>';
    }
    adHtml += '<div class="ad-cell">' + inner + '</div>';
  }
  $('allday').innerHTML = adHtml;

  /* --- 時間軸 --- */
  var sh = CFG.startHour, eh = CFG.endHour;
  var axisHtml = '';
  for (var h = sh; h <= eh; h++) {
    var pct = ((h - sh) / (eh - sh)) * 100;
    var hcls = 'hr' + (h === sh ? ' first' : h === eh ? ' last' : '');
    axisHtml += '<div class="' + hcls + '" style="top:' + pct + '%">' + h + '</div>';
  }
  $('axis').innerHTML = axisHtml;

  /* --- 各レーン --- */
  var spanMin = (eh - sh) * 60;
  var now = new Date();
  var lanesHtml = '';

  for (var L = 0; L < lanes.length; L++) {
    var mem2 = lanes[L];
    var mine = packLane(dayEvents.filter(function (e) { return !e.allDay && e.member === mem2.key; }));
    var body = '';

    for (var k = 0; k < mine.length; k++) {
      var ev = mine[k];
      var s = ev.start < startOfDay(day) ? startOfDay(day) : ev.start;
      var en = ev.end > addDays(startOfDay(day), 1) ? addDays(startOfDay(day), 1) : ev.end;
      var sMin = Math.max(0, minsOfDay(s) - sh * 60);
      var eMin = (en.getDate() !== day.getDate() ? 24 * 60 : minsOfDay(en)) - sh * 60;
      if (eMin <= 0 || sMin >= spanMin) continue;   // 表示時間帯の外
      eMin = Math.min(eMin, spanMin);

      var top = (sMin / spanMin) * 100;
      var hgt = Math.max(((eMin - sMin) / spanMin) * 100, 2.2);
      var w = 100 / ev._cols;
      var left = w * ev._col;

      var isPast = en < now && ymd(day) === ymd(now);
      var isLive = s <= now && en > now && ymd(day) === ymd(now);
      var isShort = (eMin - sMin) < 50;

      body += '<div class="ev' + (isPast ? ' past' : '') + (isLive ? ' live' : '') + (isShort ? ' short' : '') + '"' +
              ' style="--c:' + mem2.color + ';--c-bg:' + mix(mem2.color, 0.22) + ';--c-bg2:' + mix(mem2.color, 0.34) + ';' +
              'top:' + top + '%;height:' + hgt + '%;' +
              'left:calc(' + left + '% + 0.4vh);width:calc(' + w + '% - 0.8vh);">' +
                '<div class="ev-t">' + hhmm(ev.start) + '–' + hhmm(ev.end) + '</div>' +
                '<div class="ev-n">' + esc(ev.title) + '</div>' +
                (ev.location ? '<div class="ev-loc">' + esc(ev.location) + '</div>' : '') +
              '</div>';
    }

    if (body === '') body = '<div class="empty-lane">—</div>';
    lanesHtml += '<div class="lane">' + body + '</div>';
  }
  $('lanes').innerHTML = lanesHtml;

  sizeHours();
  updateNowLine();
}

/* 色を暗い背景に混ぜた値を返す（color-mix 非対応の Safari 用） */
function mix(hex, ratio) {
  var r = parseInt(hex.slice(1, 3), 16);
  var g = parseInt(hex.slice(3, 5), 16);
  var b = parseInt(hex.slice(5, 7), 16);
  var br = 0x0B, bg = 0x0F, bb = 0x14;
  return 'rgb(' + Math.round(r * ratio + br * (1 - ratio)) + ',' +
                  Math.round(g * ratio + bg * (1 - ratio)) + ',' +
                  Math.round(b * ratio + bb * (1 - ratio)) + ')';
}

/* 1時間あたりの高さを実測して罫線の間隔に反映 */
function sizeHours() {
  var tl = $('tl');
  var h = tl.clientHeight;
  var hours = CFG.endHour - CFG.startHour;
  if (h > 0 && hours > 0) {
    document.documentElement.style.setProperty('--hour-h', (h / hours) + 'px');
  }
}

/* 現在時刻ライン */
function updateNowLine() {
  var el = $('nowline');
  var now = new Date();
  if (ymd(now) !== ymd(STATE.viewDate)) { el.style.display = 'none'; return; }
  var spanMin = (CFG.endHour - CFG.startHour) * 60;
  var pos = minsOfDay(now) - CFG.startHour * 60;
  if (pos < 0 || pos > spanMin) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.style.top = ((pos / spanMin) * 100) + '%';
}

/* ------------------------------------------------------------------
   10.5 月間ビュー
   ------------------------------------------------------------------ */
var MC_MAX = 3;   // 1マスに並べる予定の最大数(超えた分は「+N」)
var MC_NARROW_PX = 820;  // 7列÷この幅を下回ったら、文字が入らないのでドット表示にする

/* 画面(ウィンドウ)の横幅で判定。iPhoneを直接持って使うときは横向きでも幅が狭く、
   壁掛けモニターにミラーリングしたときは(同じiPhoneでも見かけ上)十分広いままなので、
   向き(orientation)ではなく実際の幅で判定する。 */
function isNarrowScreen() {
  return window.innerWidth < MC_NARROW_PX;
}

function renderMonthView() {
  var view = STATE.viewDate;
  var today = startOfDay(new Date());
  var y = view.getFullYear(), m = view.getMonth();
  var narrow = isNarrowScreen();

  $('board-date').textContent = y + '年' + (m + 1) + '月';
  $('board-sub').textContent = narrow ? 'タップで詳細' : '';

  var first = new Date(y, m, 1);
  var gridStart = addDays(first, -first.getDay());
  var byDay = groupEventsByDay();

  var html = '';
  for (var c = 0; c < 42; c++) {
    var d = addDays(gridStart, c);
    var key = ymd(d);
    var cls = 'mc';
    if (d.getMonth() !== m) cls += ' out';
    if (STATE.holidays[key]) cls += ' hol';
    else if (d.getDay() === 0) cls += ' sun';
    else if (d.getDay() === 6) cls += ' sat';
    if (key === ymd(today)) cls += ' today';

    var evs = byDay[key] || [];
    var body = '';

    // 幅が狭いとき(手元のiPhoneなど)は時刻を省いてタイトルだけにし、
    // 文字サイズを小さくして5文字程度は読めるようにする(狭い画面向けCSSは
    // .mc.narrow .mc-ev 側で調整)。時刻を入れると2文字しか入らず判読できないため。
    for (var i = 0; i < Math.min(evs.length, MC_MAX); i++) {
      var ev = evs[i];
      var mem = memberByKey(ev.member);
      var label = (ev.allDay || narrow) ? ev.title : (hhmm(ev.start) + ' ' + ev.title);
      body += '<div class="mc-ev" style="--c:' + mem.color + ';--c-bg:' + mix(mem.color, 0.22) + '">' + esc(label) + '</div>';
    }
    if (evs.length > MC_MAX) {
      body += '<div class="mc-more">+' + (evs.length - MC_MAX) + '</div>';
    }

    html += '<div class="' + cls + (narrow ? ' narrow' : '') + '" data-date="' + key + '">' +
              '<div class="mc-num">' + d.getDate() + '</div>' +
              '<div class="mc-evs">' + body + '</div>' +
            '</div>';
  }
  $('month-grid').innerHTML = html;

  var cells = $('month-grid').querySelectorAll('.mc');
  for (var k = 0; k < cells.length; k++) {
    cells[k].addEventListener('click', function (ev) {
      var p = ev.currentTarget.getAttribute('data-date').split('-');
      STATE.viewDate = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
      setMonthMode(false);
    });
  }
}

function setMonthMode(on) {
  STATE.monthMode = on;
  $('day-view').hidden = on;
  $('month-view').hidden = !on;
  $('btn-month').classList.toggle('active', on);
  renderAll();
}

/* 縦向き(自分のiPhone)専用：横並びレーンの代わりに1件ずつ読みやすく並べる */
function isPortrait() {
  return window.matchMedia && window.matchMedia('(orientation: portrait)').matches;
}

function renderAgenda() {
  var day = STATE.viewDate;
  var today = startOfDay(new Date());
  var now = new Date();
  var dayEvents = eventsOn(day).slice().sort(function (a, b) {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return a.start - b.start;
  });

  var diff = Math.round((day - today) / 86400000);
  var label = diff === 0 ? '今日' : diff === 1 ? '明日' : diff === -1 ? '昨日' : '';
  $('board-date').textContent = (day.getMonth() + 1) + '/' + day.getDate() + '（' + DOW[day.getDay()] + '）' + (label ? ' ' + label : '');
  var hol = STATE.holidays[ymd(day)];
  $('board-sub').textContent = hol ? hol : (dayEvents.length + ' 件');

  if (dayEvents.length === 0) {
    $('agenda').innerHTML = '<div class="ag-empty">予定はありません</div>';
    return;
  }

  var order = memberList().concat([SHARED]);
  var html = '';
  for (var m = 0; m < order.length; m++) {
    var mem = order[m];
    var mine = dayEvents.filter(function (e) { return e.member === mem.key; });
    if (mine.length === 0) continue;

    html += '<div class="ag-group" style="--c:' + mem.color + '">' +
              '<div class="ag-head"><b>' + esc(mem.label) + '</b><span>' + mine.length + '件</span></div>';

    for (var i = 0; i < mine.length; i++) {
      var ev = mine[i];
      var isPast = !ev.allDay && ev.end < now && ymd(day) === ymd(now);
      var time = ev.allDay ? '終日' : (hhmm(ev.start) + '<small>' + hhmm(ev.end) + '</small>');
      html += '<div class="ag-ev' + (isPast ? ' past' : '') + '">' +
                '<div class="ag-time">' + time + '</div>' +
                '<div class="ag-body">' +
                  '<div class="ag-title">' + esc(ev.title) + '</div>' +
                  (ev.location ? '<div class="ag-loc">' + esc(ev.location) + '</div>' : '') +
                '</div>' +
              '</div>';
    }
    html += '</div>';
  }
  $('agenda').innerHTML = html;
}

function renderAll() {
  if (STATE.monthMode) {
    renderMonthView();
  } else if (isPortrait()) {
    renderAgenda();
  } else {
    renderBoard();
  }
  renderCalendar();
  renderNextUp();
  renderWeather();
}

/* ------------------------------------------------------------------
   11. 設定パネル
   ------------------------------------------------------------------ */
function openSettings() {
  var sel = ['s-start', 's-end'];
  for (var i = 0; i < sel.length; i++) {
    var el = $(sel[i]);
    if (el.options.length === 0) {
      var h = '';
      for (var x = 0; x <= 24; x++) h += '<option value="' + x + '">' + x + ':00</option>';
      el.innerHTML = h;
    }
  }
  $('s-endpoint').value = CFG.endpoint;
  $('s-place').value = (CFG.place && CFG.place.query) ? CFG.place.query : '';
  $('s-place-results').innerHTML = '';
  $('s-msg').textContent = CFG.place
    ? '現在の地点: ' + CFG.place.name + (CFG.place.admin1 ? '（' + CFG.place.admin1 + '）' : '')
    : '';
  $('s-start').value = String(CFG.startHour);
  $('s-end').value = String(CFG.endHour);
  $('s-refresh').value = String(CFG.refreshMin);
  $('s-burnin').checked = !!CFG.burnin;

  var mh = '';
  var ms = memberList();
  for (var j = 0; j < ms.length; j++) {
    mh += '<div class="member-in" style="--c:' + ms[j].color + '"><i></i>' +
          '<input type="text" data-key="' + ms[j].key + '" value="' + esc(ms[j].label) + '"></div>';
  }
  $('s-members').innerHTML = mh;

  $('modal').hidden = false;
}

/* 設定画面を閉じるときの後始末。
   入力欄にフォーカスが残ったままだと、iOSでキーボードが完全に閉じず
   画面の表示位置がずれたままになることがあるため、確実に解除する。 */
function closeSettings() {
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  $('modal').hidden = true;
  $('modal').scrollTop = 0;
  window.scrollTo(0, 0);
}

function saveSettings() {
  CFG.endpoint   = $('s-endpoint').value.trim();
  CFG.startHour  = parseInt($('s-start').value, 10);
  CFG.endHour    = parseInt($('s-end').value, 10);
  CFG.refreshMin = parseInt($('s-refresh').value, 10);
  CFG.burnin     = $('s-burnin').checked;
  if (CFG.endHour <= CFG.startHour) CFG.endHour = CFG.startHour + 1;

  var labels = {};
  var ins = $('s-members').querySelectorAll('input[data-key]');
  for (var i = 0; i < ins.length; i++) {
    var v = ins[i].value.trim();
    if (v) labels[ins[i].getAttribute('data-key')] = v;
  }
  CFG.labels = labels;

  var placeQuery = $('s-place').value.trim();
  var already = CFG.place && CFG.place.query === placeQuery;

  if (!placeQuery) {                    // 空 → 天気を消す
    CFG.place = null;
    $('s-place-results').innerHTML = '';
    finishSave();
  } else if (already) {                 // 変更なし → そのまま保存
    finishSave();
  } else {                              // 地名を検索して候補を出す（選ぶまで保存しない）
    $('s-msg').textContent = '「' + placeQuery + '」を検索中…';
    geocode(placeQuery)
      .then(function (list) {
        if (!list.length) {
          $('s-msg').textContent = '「' + placeQuery + '」が見つかりませんでした。市区町村名で入れてみてください。';
          $('s-place-results').innerHTML = '';
          return;
        }
        if (list.length === 1) {        // 一意なら選ばせずに確定
          CFG.place = list[0];
          WX.daily = null; WX.current = null;
          finishSave();
          return;
        }
        $('s-msg').textContent = '同じ名前の場所が複数あります。正しいものを選んでください。';
        renderPlaceCandidates(list);
      })
      .catch(function () {
        $('s-msg').textContent = '地域を検索できませんでした（通信を確認してください）';
      });
  }
}

function finishSave() {
  saveCfg(CFG);
  closeSettings();
  STATE.events = [];
  fetchData(false);
  fetchWeather();
}

/* ------------------------------------------------------------------
   12. 焼き付き防止 / 画面スリープ抑止
   ------------------------------------------------------------------ */
var shiftStep = 0;
function burnInShift() {
  if (!CFG.burnin) { $('shift').style.transform = ''; return; }
  shiftStep = (shiftStep + 1) % 8;
  var dx = [0, 1, 2, 2, 1, 0, -1, -1][shiftStep];
  var dy = [0, 1, 1, 2, 2, 1, 1, 0][shiftStep];
  $('shift').style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
}

function keepAwake() {
  if (navigator.wakeLock && navigator.wakeLock.request) {
    navigator.wakeLock.request('screen').catch(function () {});
  }
}

/* ------------------------------------------------------------------
   13. 起動
   ------------------------------------------------------------------ */
function init() {
  // キャッシュがあれば即表示（起動直後の空白を避ける）
  var cached = cacheLoad();
  if (cached && CFG.endpoint) {
    STATE.events = parseEvents(cached.events || []);
    STATE.holidays = cached.holidays || {};
  }

  try {
    var wxc = JSON.parse(localStorage.getItem('fb.wx') || 'null');
    if (wxc) { WX.current = wxc.current; WX.daily = wxc.daily; }
  } catch (e) {}

  renderAll();
  tickClock();
  fetchData(false);
  fetchWeather();

  setInterval(tickClock, 1000);
  setInterval(function () { fetchData(true); }, Math.max(1, CFG.refreshMin) * 60000);
  setInterval(fetchWeather, 20 * 60000);
  setInterval(burnInShift, 3 * 60000);
  setInterval(renderNextUp, 60000);

  // 操作が5分止まったら自動的に今日(1日表示)へ戻す
  setInterval(function () {
    var idle = Date.now() - STATE.lastTouch > 5 * 60000;
    var notToday = ymd(STATE.viewDate) !== ymd(new Date());
    if (idle && (STATE.monthMode || notToday)) {
      STATE.viewDate = startOfDay(new Date());
      if (STATE.monthMode) { setMonthMode(false); } else { renderAll(); }
    }
  }, 30000);

  window.addEventListener('resize', function () { sizeHours(); updateNowLine(); });
  window.addEventListener('orientationchange', function () { setTimeout(renderAll, 300); });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { tickClock(); fetchData(true); fetchWeather(); keepAwake(); }
  });

  function touched() { STATE.lastTouch = Date.now(); }
  document.addEventListener('touchstart', touched, { passive: true });
  document.addEventListener('click', touched);

  $('btn-prev').addEventListener('click', function () {
    if (STATE.monthMode) {
      var d = STATE.viewDate;
      STATE.viewDate = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    } else {
      STATE.viewDate = addDays(STATE.viewDate, -1);
    }
    renderAll();
  });
  $('btn-next').addEventListener('click', function () {
    if (STATE.monthMode) {
      var d2 = STATE.viewDate;
      STATE.viewDate = new Date(d2.getFullYear(), d2.getMonth() + 1, 1);
    } else {
      STATE.viewDate = addDays(STATE.viewDate, 1);
    }
    renderAll();
  });
  $('btn-today').addEventListener('click', function () {
    STATE.viewDate = startOfDay(new Date());
    if (STATE.monthMode) { setMonthMode(false); } else { renderAll(); }
    fetchData(false);
  });
  $('btn-month').addEventListener('click', function () {
    setMonthMode(!STATE.monthMode);
  });
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-close').addEventListener('click', closeSettings);
  $('btn-save').addEventListener('click', saveSettings);
  $('modal').addEventListener('click', function (ev) {
    if (ev.target === $('modal')) closeSettings();
  });

  // 左右スワイプで日付移動
  var sx = 0, sy = 0;
  document.addEventListener('touchstart', function (e) {
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (!$('modal').hidden) return;
    var dx = e.changedTouches[0].clientX - sx;
    var dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2) {
      if (STATE.monthMode) {
        var dm = STATE.viewDate;
        STATE.viewDate = new Date(dm.getFullYear(), dm.getMonth() + (dx < 0 ? 1 : -1), 1);
      } else {
        STATE.viewDate = addDays(STATE.viewDate, dx < 0 ? 1 : -1);
      }
      renderAll();
    }
  }, { passive: true });

  keepAwake();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
