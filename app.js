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
   1.5 学校の時程（村山学園 小学部 1～6年）
   長男(son1)が2年生なのでこの時程を使う。出典:
   村山学園「生活時程」https://www.city.musashimurayama.lg.jp/school/mmmurayama4sc/2000393.html
   （中学部は分単位が違うので、このアプリでは対象外＝小学部のみ実装）。
   夏休み・冬休み・学級閉鎖などの臨時休業は判定できないので、
   「平日かつ祝日でない日は授業がある」という前提で計算する。 */
var SCHOOL_MEMBER_KEY = 'son1';

/* 時限表ポップアップ（タップで表示）で使う、正確な区分の一覧。 */
var SCHOOL_SCHEDULE_FULL = [
  { name: '朝学習', start: '08:15', end: '08:30' },
  { name: '学活',   start: '08:30', end: '08:40' },
  { name: '1校時', start: '08:45', end: '09:30' },
  { name: '2校時', start: '09:35', end: '10:20' },
  { name: '中休み', start: '10:20', end: '10:40' },
  { name: '3校時', start: '10:40', end: '11:25' },
  { name: '4校時', start: '11:30', end: '12:15' },
  { name: '給食',   start: '12:15', end: '12:55' },
  { name: '清掃',   start: '12:55', end: '13:10' },
  { name: '昼休み', start: '13:10', end: '13:20' },
  { name: '5校時', start: '13:25', end: '14:10' },
  { name: '6校時', start: '14:15', end: '15:00' },
  { name: '終学活', start: '15:00', end: '15:15' }
];

/* ボードの帯は幅が狭く文字が潰れるため、連続する短い区分（朝学習＋学活、
   給食＋清掃＋昼休み）はまとめて1つの帯にしている。区分名が複数文字で
   1行に収まらない場合は`lines`で行を分けて表示する（点線の注釈枠は
   分かりにくかったのでやめ、行を分けるだけにした）。 */
var SCHOOL_SCHEDULE = [
  { name: '朝の会',   start: '08:15', end: '08:40' },
  { name: '1校時', start: '08:45', end: '09:30' },
  { name: '2校時', start: '09:35', end: '10:20' },
  { name: '中休み', start: '10:20', end: '10:40' },
  { name: '3校時', start: '10:40', end: '11:25' },
  { name: '4校時', start: '11:30', end: '12:15' },
  { name: '給食清掃', lines: ['給食', '清掃', '昼休み'], start: '12:15', end: '13:20',
    note: { name: '昼休み', start: '13:10', end: '13:20' } },
  { name: '5校時', start: '13:25', end: '14:10' },
  { name: '6校時', start: '14:15', end: '15:00' },
  { name: '終学活', start: '15:00', end: '15:15' }
];

function schoolMin(hhmm) {
  var p = hhmm.split(':');
  return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
}

/* 指定した日が授業日か（平日かつ祝日ではない、という簡易判定） */
function isSchoolDay(day) {
  var w = day.getDay();
  if (w === 0 || w === 6) return false;
  if (STATE.holidays[ymd(day)]) return false;
  return true;
}

/* 学校の予定のタイトルは「学校」だけでなく「未来塾」「児童集会」
   「◯◯締切」等その日の行事名になっていることが多く、タイトルでは
   判定できない。ただしメモ欄には毎回「下校：14:25」のように実際の
   下校時刻が書かれているので、そこから読み取る。
   下校時刻がわかれば、それより後に終わる時限はその日は無かったことにできる
   （早く下校した日に、まだ授業中であるかのように出てしまうのを防ぐ）。
   見つからなければnull（＝下校時刻不明・通常の時程のまま表示）。 */
var DISMISSAL_RE = /下校[:：]\s*(\d{1,2}):(\d{2})/;
function schoolDismissal(day) {
  var end = null;
  for (var i = 0; i < STATE.events.length; i++) {
    var e = STATE.events[i];
    if (e.allDay || e.member !== SCHOOL_MEMBER_KEY) continue;
    if (ymd(e.start) !== ymd(day)) continue;
    var m = DISMISSAL_RE.exec(e.description || '');
    if (!m) continue;
    var d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), parseInt(m[1], 10), parseInt(m[2], 10));
    if (!end || d > end) end = d;
  }
  return end;
}

/* その日に実際に表示すべき時限の一覧（下校時刻より後に終わるものは除外） */
function schoolPeriodsFor(day) {
  var dismiss = schoolDismissal(day);
  if (!dismiss) return SCHOOL_SCHEDULE;
  var limit = dismiss.getHours() * 60 + dismiss.getMinutes();
  return SCHOOL_SCHEDULE.filter(function (p) { return schoolMin(p.end) <= limit; });
}

/* 「いま」が村山学園の時程のどこに当たるかを返す（授業日でない・下校済みならnull）。
   給食清掃の帯のうち昼休みの時間帯にいるときは、帯自体は1つでも
   バッジには「給食清掃中」ではなく「昼休み中」を返す。 */
function currentSchoolPeriod() {
  var now = new Date();
  if (!isSchoolDay(now)) return null;
  var periods = schoolPeriodsFor(now);
  var mins = now.getHours() * 60 + now.getMinutes();
  for (var i = 0; i < periods.length; i++) {
    var p = periods[i];
    if (mins >= schoolMin(p.start) && mins < schoolMin(p.end)) {
      if (p.note && mins >= schoolMin(p.note.start) && mins < schoolMin(p.note.end)) return p.note;
      return p;
    }
  }
  return null;
}

/* 長男のレーン見出し（ボード／アジェンダ両方）に「いま何時限目か」を反映する。
   見出し自体はrenderBoard/renderAgendaが再構築するたび作り直されるが、
   このバッジだけは同じidを使い回し、tickClock()から毎秒直接書き換える。
   withTimeがtrueのときだけ「（開始〜終了）」を末尾に付ける（縦向きiPhone用）。 */
function paintSchoolBadge(id, withTime) {
  var el = document.getElementById(id);
  if (!el) return;
  var p = currentSchoolPeriod();
  if (p) {
    el.hidden = false;
    el.textContent = '🏫 ' + p.name + '中' + (withTime ? '（' + p.start + '〜' + p.end + '）' : '');
  } else {
    el.hidden = true;
    el.textContent = '';
  }
}
function updateSchoolBadges() {
  paintSchoolBadge('lh-school', false);
  paintSchoolBadge('ag-school', true);
  repaintSchoolTableNow();
}

/* 「いま」がSCHOOL_SCHEDULE_FULLの何行目に当たるかを返す（無ければ-1）。
   時限表は朝学習/学活や給食/清掃/昼休みも別行にしてあるので、バッジ用の
   currentSchoolPeriod()（まとめた区分ベース）とは別に、行単位で判定する。
   下校時刻より後に終わる行は、その日は無かったことにして対象から外す。 */
function currentFullPeriodIndex() {
  var now = new Date();
  if (!isSchoolDay(now)) return -1;
  var dismiss = schoolDismissal(now);
  var limit = dismiss ? (dismiss.getHours() * 60 + dismiss.getMinutes()) : Infinity;
  var mins = now.getHours() * 60 + now.getMinutes();
  for (var i = 0; i < SCHOOL_SCHEDULE_FULL.length; i++) {
    var p = SCHOOL_SCHEDULE_FULL[i];
    if (schoolMin(p.end) > limit) continue;
    if (mins >= schoolMin(p.start) && mins < schoolMin(p.end)) return i;
  }
  return -1;
}

/* 時限表パネル（ボードの🏫バッジ・時限の帯、アジェンダの🏫バッジから開く）。
   ボードの帯は分かりやすさのため区分をまとめたり行を分けたりしているので、
   正確な時刻はこちらでSCHOOL_SCHEDULE_FULLをそのまま表にして見せる。
   設定パネル等の.modalと違って全画面の背景を敷かない浮かせ表示なので、
   長男の予定を隠さないよう、タップした場所（anchorRect）のすぐ横に出す。 */
function openSchoolTable(anchorRect) {
  var nowIdx = currentFullPeriodIndex();
  var rows = '';
  for (var i = 0; i < SCHOOL_SCHEDULE_FULL.length; i++) {
    var p = SCHOOL_SCHEDULE_FULL[i];
    rows += '<tr' + (i === nowIdx ? ' class="now"' : '') + '><th>' + esc(p.name) + '</th><td>' + p.start + '〜' + p.end + '</td></tr>';
  }
  $('school-table').innerHTML = rows;
  closeMemberSchedule();
  closeEventDetail();
  var flyout = $('school-flyout');
  flyout.hidden = false;
  if (anchorRect) positionSchoolFlyout(anchorRect);
  var nowRow = $('school-table').querySelector('tr.now');
  if (nowRow && nowRow.scrollIntoView) nowRow.scrollIntoView({ block: 'center' });
}
function closeSchoolTable() {
  $('school-flyout').hidden = true;
}

/* 時限表を開いたまま時限が切り替わっても強調表示が追従するよう、
   毎秒(tickClock経由)呼ぶ。行を作り直さず、クラスの付け替えだけで済ませる。 */
function repaintSchoolTableNow() {
  var flyout = $('school-flyout');
  if (flyout.hidden) return;
  var nowIdx = currentFullPeriodIndex();
  var rows = $('school-table').querySelectorAll('tr');
  for (var i = 0; i < rows.length; i++) {
    rows[i].classList.toggle('now', i === nowIdx);
  }
}

/* anchorRect(タップした要素のgetBoundingClientRect())の右隣にflyout要素を置く。
   右にはみ出す場合は左隣に、下にはみ出す場合は画面内に収まる位置まで引き上げる。
   時限表(#school-flyout)・その人の予定一覧(#member-flyout)の両方で使う共通処理。 */
function positionFlyout(flyout, anchorRect) {
  var margin = 8;
  var fw = flyout.offsetWidth;
  var fh = flyout.offsetHeight;
  var vw = window.innerWidth;
  var vh = window.innerHeight;

  var left = anchorRect.right + margin;
  if (left + fw > vw - margin) left = anchorRect.left - fw - margin;
  left = Math.max(margin, Math.min(left, vw - fw - margin));

  var top = anchorRect.top;
  top = Math.max(margin, Math.min(top, vh - fh - margin));

  flyout.style.left = left + 'px';
  flyout.style.top = top + 'px';
}
function positionSchoolFlyout(anchorRect) { positionFlyout($('school-flyout'), anchorRect); }

/* 長男のレーン全体（時限の帯を含む列）の位置。ボード側でバッジ・帯どちらを
   タップしても、同じ位置（長男のレーンの右隣）にパネルを出すために使う。 */
function schoolLaneRect() {
  var col = document.querySelector('.school-col');
  var lane = col && col.closest('.lane');
  return lane ? lane.getBoundingClientRect() : null;
}

/* ボードのレーン見出し（名前）をタップしたときに、その人の今後の予定を
   一覧で見せるパネル。#school-flyoutと同じ「背景なしの浮かせ表示」で、
   タップした見出しのすぐ横に出す。送り・迎え・付き添いで担当している
   他の人の予定も、そのレーンに出ているのと同じ形で混ぜて見せる。 */
function openMemberSchedule(memberKey, anchorRect) {
  var mem = memberByKey(memberKey);
  var now = new Date();
  var upcoming = eventsForLaneWithEscort(STATE.events, memberKey)
    .filter(function (e) { return e.end > now; })
    .sort(function (a, b) { return a.start - b.start; });

  var titleEl = $('member-flyout-title');
  titleEl.textContent = mem.label + 'の予定';
  titleEl.style.color = mem.color;

  var html = '';
  if (upcoming.length === 0) {
    html = '<div class="mf-empty">今後の予定はありません</div>';
  } else {
    for (var i = 0; i < upcoming.length; i++) {
      var ev = upcoming[i];
      var dateLabel = (ev.start.getMonth() + 1) + '/' + ev.start.getDate() + '（' + DOW[ev.start.getDay()] + '）';
      var timeLabel = ev.allDay ? '終日' : boardTimeLabel(ev);
      html += '<div class="mf-ev" data-id="' + esc(ev.id) + '">' +
                '<div class="mf-date"><b>' + dateLabel + '</b>' + esc(timeLabel) + '</div>' +
                '<div class="mf-body">' +
                  '<div class="mf-title">' + esc(eventDisplayTitle(ev)) + '</div>' +
                  (ev.location ? '<div class="mf-loc">' + esc(ev.location) + '</div>' : '') +
                '</div>' +
              '</div>';
    }
  }
  $('member-flyout-list').innerHTML = html;

  closeSchoolTable();   // 2枚同時に出さない
  closeEventDetail();
  var flyout = $('member-flyout');
  flyout.hidden = false;
  if (anchorRect) positionFlyout(flyout, anchorRect);
}
function closeMemberSchedule() {
  $('member-flyout').hidden = true;
}
function initMemberScheduleTap() {
  $('member-flyout-list').addEventListener('click', function (ev) {
    var row = ev.target.closest('.mf-ev');
    if (!row) return;
    var found = eventById(row.getAttribute('data-id'));
    if (found) { closeMemberSchedule(); openEditEvent(found); }
  });
  $('member-flyout-close').addEventListener('click', closeMemberSchedule);
}

/* ボードで予定そのものをタップしたときの詳細パネル。縦向き(アジェンダ)の
   「タップ→詳細→編集ボタン」と同じ2段階にするため、renderAgendaDetail()を
   そのまま使い回す。ボードはタイムライン上に絶対配置なので、詳細を
   予定の「下」に置く場所が無く、他のflyout群と同じ「タップした場所の
   横に浮かせる」方式にしている。 */
function openEventDetail(ev, escortRole, titleText, anchorRect) {
  var titleEl = $('event-flyout-title');
  titleEl.textContent = titleText;
  titleEl.style.color = memberByKey(ev.member).color;
  $('event-flyout-body').innerHTML = renderAgendaDetail(ev, escortRole);

  closeSchoolTable();
  closeMemberSchedule();
  var flyout = $('event-flyout');
  flyout.hidden = false;
  if (anchorRect) positionFlyout(flyout, anchorRect);
}
function closeEventDetail() {
  $('event-flyout').hidden = true;
}
function initEventDetailTap() {
  $('event-flyout-body').addEventListener('click', function (ev) {
    var btn = ev.target.closest('.ag-detail-edit');
    if (!btn) return;
    var found = eventById(btn.getAttribute('data-id'));
    if (found) { closeEventDetail(); openEditEvent(found); }
  });
  $('event-flyout-close').addEventListener('click', closeEventDetail);
}

/* 表示ボードの長男レーンに「ここからここが何時限目」を帯で示すための
   HTML（レーンの右列＝.school-colの中に、予定より下に敷く背景帯として挿入する）。 */
function schoolBandsHtml(day, sh, eh) {
  if (!isSchoolDay(day)) return '';
  var periods = schoolPeriodsFor(day);
  var spanMin = (eh - sh) * 60;
  var now = new Date();
  var isViewingToday = ymd(day) === ymd(now);
  var nowMin = now.getHours() * 60 + now.getMinutes();
  var html = '';
  for (var i = 0; i < periods.length; i++) {
    var p = periods[i];
    var s = schoolMin(p.start), e = schoolMin(p.end);
    var sMin = s - sh * 60, eMin = e - sh * 60;
    if (eMin <= 0 || sMin >= spanMin) continue;   // 表示時間帯の外
    sMin = Math.max(0, sMin);
    eMin = Math.min(spanMin, eMin);
    var top = (sMin / spanMin) * 100;
    var hgt = ((eMin - sMin) / spanMin) * 100;
    var isNow = isViewingToday && nowMin >= s && nowMin < e;

    /* lines（給食/清掃/昼休みのように1行に入らない区分）があれば、行に分けて
       表示する（以前は点線の枠で区切っていたが分かりにくかったのでやめた）。 */
    var labelHtml;
    if (p.lines) {
      labelHtml = '<span class="school-band-label multi">';
      for (var j = 0; j < p.lines.length; j++) labelHtml += '<span>' + esc(p.lines[j]) + '</span>';
      labelHtml += '</span>';
    } else {
      labelHtml = '<span class="school-band-label">' + esc(p.name) + '</span>';
    }

    html += '<div class="school-band' + (isNow ? ' now' : '') + '" style="top:' + top + '%;height:' + hgt + '%">' +
              labelHtml +
            '</div>';
  }
  return html;
}

/* 右列（時限の帯）の幅を、文字が潰れない最小限まで詰める。SCHOOL_SCHEDULEの中で
   一番長い「1行」を実際のフォントサイズで測り、CSS変数--school-col-wに反映する
   （sizeHours()と同じ「実測してCSS変数に渡す」手法）。lines持ちの区分は行ごとに
   比較するので、幅は各行の最長文字数だけで決まる。 */
function sizeSchoolCol() {
  var longest = '';
  for (var i = 0; i < SCHOOL_SCHEDULE.length; i++) {
    var p = SCHOOL_SCHEDULE[i];
    var candidates = p.lines || [p.name];
    for (var j = 0; j < candidates.length; j++) {
      if (candidates[j].length > longest.length) longest = candidates[j];
    }
  }
  var probe = document.createElement('span');
  probe.style.cssText = 'position:absolute; visibility:hidden; left:-9999px; top:-9999px; white-space:nowrap; font-size:1.3vh; font-weight:600;';
  probe.textContent = longest;
  document.body.appendChild(probe);
  var textW = probe.getBoundingClientRect().width;
  document.body.removeChild(probe);
  var vh = window.innerHeight / 100;
  document.documentElement.style.setProperty('--school-col-w', Math.ceil(textW + 0.6 * vh) + 'px');
}

/* ------------------------------------------------------------------
   1.6 送り・迎え・付き添い（担当）
   Googleカレンダーの予定には専用の項目が無いので、メモ欄(description)の
   末尾に目印付きの行として埋め込む。担当は役割ごとに複数人チェック可
   （父母両方が付き添う、等）。他の端末もdescriptionを読むだけで
   同じ担当を見られる（GAS側の変更は不要）。 */
var ESCORT_ROLES = ['dropoff', 'pickup', 'accompany'];
var ESCORT_LABELS = { dropoff: '送り', pickup: '迎え', accompany: '付き添い' };
var ESCORT_ICONS  = { dropoff: '🚗', pickup: '🚗', accompany: '🧑‍🤝‍🧑' };
var ESCORT_MARK = '――― 送迎 ―――';
/* 付き添い/付添いのように「き」の送り仮名の有無どちらで手入力されても
   拾えるよう、そこだけ任意にしている（読み取り専用。アプリ自身が書き込む
   ときのラベルは常にESCORT_LABELS.accompanyの「付き添い」で統一）。 */
var ESCORT_LINE_RE = {
  dropoff:   /送り[:：]\s*([^\n]*)/,
  pickup:    /迎え[:：]\s*([^\n]*)/,
  accompany: /付(?:き)?添い[:：]\s*([^\n]*)/
};

function emptyEscort() { return { dropoff: [], pickup: [], accompany: [] }; }

/* 送迎の担当欄に書かれた1トークンを、メンバーのkeyに変換する。
   アプリが書き込むときは常にkey（father等）で書くが、Googleカレンダー側で
   手入力する場合にも困らないよう、いまの表示名（設定でラベルを変えていても）
   や素の日本語（父・母・長男・次男・長女）でも拾えるようにしている。 */
var ESCORT_JA_ALIASES = { father: '父', mother: '母', son1: '長男', son2: '次男', daughter: '長女' };
function resolveMemberToken(token) {
  token = String(token || '').trim();
  if (!token) return null;
  var all = memberList();
  for (var i = 0; i < all.length; i++) {
    if (all[i].key === token || all[i].label === token) return all[i].key;
  }
  for (var key in ESCORT_JA_ALIASES) {
    if (ESCORT_JA_ALIASES[key] === token) return key;
  }
  return null;
}

/* description全体を「メモ本文」と「送迎の担当」に切り分ける */
function parseEscort(description) {
  var text = description || '';
  var idx = text.indexOf(ESCORT_MARK);
  if (idx === -1) return { memo: text, escort: emptyEscort() };

  var memo = text.slice(0, idx).replace(/\n+$/, '');
  var block = text.slice(idx + ESCORT_MARK.length);
  var escort = emptyEscort();
  for (var i = 0; i < ESCORT_ROLES.length; i++) {
    var role = ESCORT_ROLES[i];
    var m = ESCORT_LINE_RE[role].exec(block);
    if (m && m[1].trim()) {
      var tokens = m[1].split(/[,、]/).map(function (s) { return resolveMemberToken(s); }).filter(Boolean);
      escort[role] = tokens;
    }
  }
  return { memo: memo, escort: escort };
}

/* メモ本文＋担当から、Googleカレンダーに書き込むdescription文字列を組み立てる。
   担当が誰もいなければ目印ごと付けず、メモ本文だけを返す（描く跡を残さない）。 */
function buildDescriptionWithEscort(memo, escort) {
  var lines = [];
  for (var i = 0; i < ESCORT_ROLES.length; i++) {
    var role = ESCORT_ROLES[i];
    if (escort[role] && escort[role].length) {
      lines.push(ESCORT_LABELS[role] + ': ' + escort[role].join(','));
    }
  }
  var body = (memo || '').replace(/\n+$/, '');
  if (lines.length === 0) return body;
  return (body ? body + '\n\n' : '') + ESCORT_MARK + '\n' + lines.join('\n');
}

/* ------------------------------------------------------------------
   2. 設定（localStorage）
   ------------------------------------------------------------------ */
var DEFAULTS = {
  endpoint: '',
  startHour: 6,
  endHour: 23,
  refreshMin: 5,
  burnin: true,
  kiosk: false,
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
  monthSelectedKey: null,  // 月間一覧でタップして選んだ日("YYYY-MM-DD")。もう一度タップでその日に移動
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
    var parsedDesc = parseEscort(e.description || '');
    out.push({
      id: e.id || ('e' + i),
      calId: e.calId || '',
      member: e.member || 'shared',
      title: e.title || '(無題)',
      allDay: !!e.allDay,
      start: s,
      end: en,
      location: e.location || '',
      description: e.description || '',
      memo: parsedDesc.memo,
      escort: parsedDesc.escort,
      recurring: !!e.recurring
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
  updateSchoolBadges();
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
            '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunset' +
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

/* 日の入り時刻は曜日バッジの隣に表示する（天気ウィジェットとは別の場所）。
   ラベル文字は付けずアイコン＋時刻のみで横幅を節約している。 */
function renderSunset(idx) {
  var sunset = idx >= 0 && WX.daily && WX.daily.sunset && WX.daily.sunset[idx];
  $('ck-sunset').hidden = !sunset;
  $('ck-sunset-time').textContent = sunset ? sunset.split('T')[1] : '';
}

function renderWeather() {
  var box = $('wx');
  if (!CFG.place || typeof CFG.place.lat !== 'number') { box.hidden = true; renderSunset(-1); return; }
  box.hidden = false;

  $('wx-place').textContent = CFG.place.admin1 || CFG.place.name || '';

  if (!WX.daily || !WX.daily.time) {
    $('wx-icon').textContent = '…';
    $('wx-t').textContent = '--';
    $('wx-hl').textContent = '';
    $('wx-pop').textContent = '';
    renderSunset(-1);
    return;
  }

  var key = ymd(STATE.viewDate);
  var idx = WX.daily.time.indexOf(key);
  renderSunset(idx);
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

/* その予定でmemberKeyが送り・迎え・付き添いの担当になっていれば、
   役割の配列（例: ['dropoff']）を返す。担当でなければ空配列。 */
function escortRolesFor(ev, memberKey) {
  var roles = [];
  if (!ev.escort) return roles;
  for (var i = 0; i < ESCORT_ROLES.length; i++) {
    var role = ESCORT_ROLES[i];
    if (ev.escort[role] && ev.escort[role].indexOf(memberKey) >= 0) roles.push(role);
  }
  return roles;
}

/* 送り・迎えは「その瞬間」の目印なので、予定の全時間帯を占領する帯にはせず、
   開始時刻（送り）／終了時刻（迎え）のところに短い印（既定15分ぶん）だけを置く。
   付き添いは実際に一緒にいる時間なので、これまで通り予定の全時間帯のまま。 */
var ESCORT_MARKER_MIN = 15;

/* あるレーン(memberKey)に出す予定の一覧。本人の予定に加えて、本人が
   送り・迎え・付き添いの担当になっている「他の人の予定」も混ぜて返す
   （役割ごとに1件ずつのコピーにする。同じ人が送りと迎えの両方でも、
   別々の印として置きたいため）。重なりはpackLaneに任せる。 */
function eventsForLaneWithEscort(dayEvents, memberKey) {
  var out = [];
  for (var i = 0; i < dayEvents.length; i++) {
    var e = dayEvents[i];
    if (e.member === memberKey) { out.push(e); continue; }
    var roles = escortRolesFor(e, memberKey);
    for (var r = 0; r < roles.length; r++) {
      var role = roles[r];
      var copy = {};
      for (var k in e) { if (Object.prototype.hasOwnProperty.call(e, k)) copy[k] = e[k]; }
      copy._escortRole = role;
      copy._escortOrigStart = e.start;
      copy._escortOrigEnd = e.end;
      if (!e.allDay && role === 'dropoff') {
        copy.start = e.start;
        copy.end = new Date(Math.min(e.end.getTime(), e.start.getTime() + ESCORT_MARKER_MIN * 60000));
      } else if (!e.allDay && role === 'pickup') {
        copy.end = e.end;
        copy.start = new Date(Math.max(e.start.getTime(), e.end.getTime() - ESCORT_MARKER_MIN * 60000));
      }
      out.push(copy);
    }
  }
  return out;
}

/* 予定の見出し(タイトル)。送迎の担当として出しているコピーには、
   役割のアイコンと名前を頭に付けて「これは自分の予定ではなく担当だ」と
   分かるようにする（例: 🚗送り：長男のサッカー練習）。時刻はboardTimeLabel()/
   agendaTimeHtml()側で出すので、ここには含めない。 */
function eventDisplayTitle(ev) {
  if (!ev._escortRole) return ev.title;
  var icon = ESCORT_ICONS[ev._escortRole];
  var label = ESCORT_LABELS[ev._escortRole];
  var owner = memberByKey(ev.member).label;
  return icon + label + '：' + owner + 'の' + ev.title;
}

/* 表示ボードの時刻表示。送り・迎えの印は範囲ではなく元の予定の該当する
   1点（送りなら開始・迎えなら終了）だけを見せる。 */
function boardTimeLabel(ev) {
  if (ev._escortRole === 'dropoff') return hhmm(ev._escortOrigStart);
  if (ev._escortRole === 'pickup') return hhmm(ev._escortOrigEnd);
  return hhmm(ev.start) + '–' + hhmm(ev.end);
}

/* 縦向き(アジェンダ)の時刻表示。考え方はboardTimeLabel()と同じ。 */
function agendaTimeHtml(ev) {
  if (ev.allDay) return '終日';
  if (ev._escortRole === 'dropoff') return hhmm(ev._escortOrigStart);
  if (ev._escortRole === 'pickup') return hhmm(ev._escortOrigEnd);
  return hhmm(ev.start) + '<small>' + hhmm(ev.end) + '</small>';
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
    var cnt = eventsForLaneWithEscort(dayEvents, mem.key).length;
    var schoolBadge = (mem.key === SCHOOL_MEMBER_KEY) ? '<span class="lh-school" id="lh-school" hidden></span>' : '';
    headHtml += '<div class="lh" data-member="' + mem.key + '" style="--c:' + mem.color + '">' + esc(mem.label) +
                schoolBadge +
                '<span class="lh-n">' + (cnt ? cnt + ' 件' : '—') + '</span></div>';
  }
  $('lanes-head').innerHTML = headHtml;

  /* --- 終日予定バンド --- */
  var adAny = dayEvents.some(function (e) { return e.allDay; });
  var adHtml = '<div class="ad-cell">' + (adAny ? '<span class="ad-lbl">終日</span>' : '') + '</div>';
  for (var a = 0; a < lanes.length; a++) {
    var mm = lanes[a];
    var ads = eventsForLaneWithEscort(dayEvents, mm.key).filter(function (e) { return e.allDay; });
    var inner = '';
    for (var b = 0; b < ads.length; b++) {
      inner += '<div class="ad-ev" style="--c:' + mm.color + '">' + esc(eventDisplayTitle(ads[b])) + '</div>';
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
    /* 長男は、学校がある日はレーンを2列に分け、左に予定・右に時限の帯を出す
       （同じ幅いっぱいに重ねると、予定の下に時限の帯が隠れて見えなくなるため）。 */
    var splitSchool = mem2.key === SCHOOL_MEMBER_KEY && isSchoolDay(day);
    var mine = packLane(eventsForLaneWithEscort(dayEvents, mem2.key).filter(function (e) { return !e.allDay; }));
    var body = splitSchool ? ('<div class="school-col">' + schoolBandsHtml(day, sh, eh) + '</div>') : '';

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

      /* 学校がある日の長男は、右列(--school-col-w、文字が潰れない最小幅)を
         除いた残りだけが予定の置き場所になる。calc()で「レーン幅 - 右列px」を
         _cols等分する（右列の幅はJSではなくCSS変数として実測されるため）。 */
      var leftExpr, widthExpr;
      if (splitSchool) {
        var frac = 1 / ev._cols;
        var fracLeft = ev._col / ev._cols;
        leftExpr = 'calc((100% - var(--school-col-w) - 0.3vh) * ' + fracLeft + ' + 0.4vh)';
        widthExpr = 'calc((100% - var(--school-col-w) - 0.3vh) * ' + frac + ' - 0.8vh)';
      } else {
        var wPct = 100 / ev._cols;
        leftExpr = 'calc(' + (wPct * ev._col) + '% + 0.4vh)';
        widthExpr = 'calc(' + wPct + '% - 0.8vh)';
      }

      var isPast = en < now && ymd(day) === ymd(now);
      var isLive = s <= now && en > now && ymd(day) === ymd(now);
      var isShort = (eMin - sMin) < 50;
      var isEscort = !!ev._escortRole;
      var isEscortBlock = ev._escortRole === 'accompany';
      var isEscortPoint = ev._escortRole === 'dropoff' || ev._escortRole === 'pickup';
      /* 送迎の担当ぶんは、本人の予定ではなく「誰かの予定に付いている」ことが
         分かるよう、色はその予定の本来の持ち主のままにする。付き添いは
         時間帯まるごとなので点線の枠、送り・迎えは一瞬の印なので枠は付けない。 */
      var evColor = isEscort ? memberByKey(ev.member).color : mem2.color;
      var evClass = 'ev' + (isPast ? ' past' : '') + (isLive ? ' live' : '') + (isShort ? ' short' : '') +
                    (isEscort ? ' escort' : '') + (isEscortBlock ? ' escort-block' : '') + (isEscortPoint ? ' escort-point' : '');

      body += '<div class="' + evClass + '" data-id="' + esc(ev.id) + '"' +
              (isEscort ? ' data-escort-role="' + esc(ev._escortRole) + '"' : '') +
              ' style="--c:' + evColor + ';--c-bg:' + mix(evColor, 0.22) + ';--c-bg2:' + mix(evColor, 0.34) + ';' +
              'top:' + top + '%;height:' + hgt + '%;' +
              'left:' + leftExpr + ';width:' + widthExpr + ';">' +
                '<div class="ev-t">' + boardTimeLabel(ev) + '</div>' +
                '<div class="ev-n">' + esc(eventDisplayTitle(ev)) + '</div>' +
                (ev.location ? '<div class="ev-loc">' + esc(ev.location) + '</div>' : '') +
              '</div>';
    }

    if (body === '') body = '<div class="empty-lane">—</div>';
    lanesHtml += '<div class="lane">' + body + '</div>';
  }
  $('lanes').innerHTML = lanesHtml;

  sizeHours();
  sizeSchoolCol();
  updateNowLine();
  updateSchoolBadges();
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

/* 1マス(.mc)が実際に必要とする高さ(3件表示+日付行ぶん)を、
   画面外に同じ構造のダミーを一瞬だけ置いて実測する。以前は
   月間グリッドの高さを「残りを6等分」で決めていたため、予定が
   少ない日にもマス目いっぱいの空白ができていた。3件ぶんに必要な
   最小限の高さだけを固定値として使い、余った分は下の詳細パネルに
   回す(--mc-row-hとしてCSSに渡す。sizeHours()の--hour-hと同じ手法)。 */
function measureMonthCellHeight(narrow) {
  var probe = document.createElement('div');
  probe.className = 'mc' + (narrow ? ' narrow' : '');
  probe.style.cssText = 'position:absolute; visibility:hidden; left:-9999px; top:-9999px; width:100px;';
  var evsHtml = '';
  for (var i = 0; i < MC_MAX; i++) {
    evsHtml += '<div class="mc-ev">00:00 ダミー予定</div>';
  }
  probe.innerHTML =
    '<div class="mc-num-row"><span class="mc-num">30</span><span class="mc-more">+9</span></div>' +
    '<div class="mc-evs">' + evsHtml + '</div>';
  document.body.appendChild(probe);
  var h = probe.getBoundingClientRect().height;
  document.body.removeChild(probe);
  return h;
}

function renderMonthView() {
  var view = STATE.viewDate;
  var today = startOfDay(new Date());
  var y = view.getFullYear(), m = view.getMonth();
  var narrow = isNarrowScreen();

  document.documentElement.style.setProperty('--mc-row-h', measureMonthCellHeight(narrow) + 'px');

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
    if (key === STATE.monthSelectedKey) cls += ' selected';

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
    // あふれた件数の「+N」は、専用の行を足さずに日付の隣(右詰め)に出す。
    // "+1"のためだけに予定1件ぶんの高さを使うのはもったいないため。
    var moreLabel = evs.length > MC_MAX ? '+' + (evs.length - MC_MAX) : '';

    html += '<div class="' + cls + (narrow ? ' narrow' : '') + '" data-date="' + key + '">' +
              '<div class="mc-num-row"><span class="mc-num">' + d.getDate() + '</span>' +
              (moreLabel ? '<span class="mc-more">' + moreLabel + '</span>' : '') + '</div>' +
              '<div class="mc-evs">' + body + '</div>' +
            '</div>';
  }
  $('month-grid').innerHTML = html;

  var cells = $('month-grid').querySelectorAll('.mc');
  for (var k = 0; k < cells.length; k++) {
    cells[k].addEventListener('click', function (ev) {
      var key = ev.currentTarget.getAttribute('data-date');
      var p = key.split('-');
      var d2 = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));

      if (STATE.monthSelectedKey === key) {
        // 選択済みの日をもう一度タップ → その日の1日表示へ移動
        STATE.viewDate = d2;
        STATE.monthSelectedKey = null;
        setMonthMode(false);
      } else {
        // 1回目のタップ → 月表示のまま選択し、下に予定を大きめに出す
        STATE.viewDate = d2;
        STATE.monthSelectedKey = key;
        renderAll();
      }
    });
  }

  renderMonthDetail();
}

/* 月間一覧で選ばれている日の予定を、下の詳細パネルに少し大きく表示する。
   グリッドのセルは小さくて読みにくいための補助。もう一度同じ日をタップ
   すると1日表示に移動する(cellsのクリックハンドラ側で処理)。
   パネルは月表示の間ずっと表示したまま(高さ固定)にする。表示/非表示を
   切り替えるとカレンダーの高さが変わって「動いて」しまうため、
   常に同じ場所に同じ高さで存在させ、中身の件数が多いときはパネル内で
   スクロールさせる(高さはstyle.cssの.month-detailで固定)。 */
function renderMonthDetail() {
  var box = $('month-detail');
  var key = STATE.monthSelectedKey || defaultMonthSelection(STATE.viewDate);
  STATE.monthSelectedKey = key;

  var p = key.split('-');
  var day = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  var dayEvents = eventsOn(day).slice().sort(function (a, b) {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return a.start - b.start;
  });

  var html = '<div class="md-head"><b>' + (day.getMonth() + 1) + '/' + day.getDate() +
             '（' + DOW[day.getDay()] + '）</b><span>' + dayEvents.length + '件</span>' +
             '<span class="md-hint">もう一度タップでこの日を開く</span></div>';

  html += '<div class="md-list">';
  if (dayEvents.length === 0) {
    html += '<div class="md-empty">予定はありません</div>';
  } else {
    for (var i = 0; i < dayEvents.length; i++) {
      var ev = dayEvents[i];
      var mem = memberByKey(ev.member);
      var time = ev.allDay ? '終日' : hhmm(ev.start);
      html += '<div class="md-ev" data-id="' + esc(ev.id) + '" style="--c:' + mem.color + ';--c-bg:' + mix(mem.color, 0.22) + '">' +
                '<span class="md-time">' + time + '</span>' +
                '<span class="md-title">' + esc(ev.title) + '</span>' +
                (ev.location ? '<span class="md-loc">' + esc(ev.location) + '</span>' : '') +
              '</div>';
    }
  }
  html += '</div>';
  box.innerHTML = html;
  box.hidden = false;
}

/* 月表示に入った/月を切り替えたときに、最初から選んでおく日。
   表示中の月に今日が含まれていれば今日を、含まれていなければ
   その月の1日を選ぶ。これにより詳細パネルが常に何かしらの内容を
   表示した状態になり、パネルの出現/消滅でカレンダーの高さが
   変わって「動く」ことがなくなる。 */
function defaultMonthSelection(viewDate) {
  var today = startOfDay(new Date());
  if (viewDate.getFullYear() === today.getFullYear() && viewDate.getMonth() === today.getMonth()) {
    return ymd(today);
  }
  return ymd(new Date(viewDate.getFullYear(), viewDate.getMonth(), 1));
}

function setMonthMode(on) {
  STATE.monthMode = on;
  STATE.monthSelectedKey = on ? defaultMonthSelection(STATE.viewDate) : null;
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

  var order = memberList().concat([SHARED]);
  var html = '';
  for (var m = 0; m < order.length; m++) {
    var mem = order[m];
    var mine = eventsForLaneWithEscort(dayEvents, mem.key);
    /* 長男(SCHOOL_MEMBER_KEY)は、その日に予定が1件もなくても
       学校の時程バッジを出したいので、授業日ならグループ自体は残す。 */
    var isSchoolLane = mem.key === SCHOOL_MEMBER_KEY && isSchoolDay(day);
    if (mine.length === 0 && !isSchoolLane) continue;

    var schoolBadge = isSchoolLane ? '<span class="ag-school" id="ag-school" hidden></span>' : '';
    html += '<div class="ag-group" style="--c:' + mem.color + '">' +
              '<div class="ag-head"><b>' + esc(mem.label) + '</b>' + schoolBadge +
              (mine.length ? '<span>' + mine.length + '件</span>' : '') + '</div>';

    for (var i = 0; i < mine.length; i++) {
      var ev = mine[i];
      var isPast = !ev.allDay && ev.end < now && ymd(day) === ymd(now);
      var isEscort = !!ev._escortRole;
      html += '<div class="ag-ev' + (isPast ? ' past' : '') + (isEscort ? ' escort' : '') + '" data-id="' + esc(ev.id) + '"' +
              (isEscort ? ' data-escort-role="' + esc(ev._escortRole) + '"' : '') + '>' +
                '<div class="ag-time">' + agendaTimeHtml(ev) + '</div>' +
                '<div class="ag-body">' +
                  '<div class="ag-title">' + esc(eventDisplayTitle(ev)) + '</div>' +
                  (ev.location ? '<div class="ag-loc">' + esc(ev.location) + '</div>' : '') +
                '</div>' +
              '</div>';
    }
    html += '</div>';
  }
  $('agenda').innerHTML = html || '<div class="ag-empty">予定はありません</div>';
  updateSchoolBadges();
}

function eventById(id) {
  for (var i = 0; i < STATE.events.length; i++) {
    if (STATE.events[i].id === id) return STATE.events[i];
  }
  return null;
}

/* アジェンダ(縦向き)の予定タップ。以前は直接編集パネルを開いていたが、
   誤って編集画面に入ってしまうという声があったため、まずタップした予定の
   すぐ下に詳細を広げるだけにし、実際の編集はそこにある「編集する」
   ボタンから行うようにした。委譲方式なのはメンバーピルと同じ理由
   (取りこぼしに強い)。 */
function initAgendaTap() {
  $('agenda').addEventListener('click', function (ev) {
    var editBtn = ev.target.closest('.ag-detail-edit');
    if (editBtn) {
      var found = eventById(editBtn.getAttribute('data-id'));
      if (found) openEditEvent(found);
      return;
    }
    var row = ev.target.closest('.ag-ev');
    if (!row) return;
    toggleAgendaDetail(row);
  });
}

/* タップした予定の詳細を、その予定の下に広げる/閉じる。
   同じ予定を再タップすると閉じるだけ。別の予定をタップすると、
   開いていた詳細を閉じてから新しい詳細を開く(同時に1つだけ)。 */
function toggleAgendaDetail(row) {
  var id = row.getAttribute('data-id');
  var already = row.nextElementSibling;
  var wasOpen = !!(already && already.classList.contains('ag-detail') && already.getAttribute('data-for') === id);

  var openDetail = $('agenda').querySelector('.ag-detail');
  if (openDetail) {
    var openRow = openDetail.previousElementSibling;
    if (openRow) openRow.classList.remove('open');
    openDetail.remove();
  }
  if (wasOpen) return;

  var found = eventById(id);
  if (!found) return;
  var detail = document.createElement('div');
  detail.className = 'ag-detail';
  detail.setAttribute('data-for', id);
  detail.innerHTML = renderAgendaDetail(found, row.getAttribute('data-escort-role') || '');
  row.insertAdjacentElement('afterend', detail);
  row.classList.add('open');
}

/* 予定の詳細のHTML。escortRoleがあれば(送迎の担当として出ている行なら)
   「誰の予定の何担当か」を先頭に添える。編集は必ずこの中のボタンから。 */
function renderAgendaDetail(ev, escortRole) {
  var html = '';
  if (escortRole) {
    var owner = memberByKey(ev.member).label;
    html += '<div class="ag-detail-row ag-detail-role">' + ESCORT_ICONS[escortRole] + ' ' +
            esc(owner) + 'の予定の' + esc(ESCORT_LABELS[escortRole]) + '担当です</div>';
  }
  var timeText = ev.allDay ? '終日' : (hhmm(ev.start) + ' 〜 ' + hhmm(ev.end));
  html += '<div class="ag-detail-row"><b>時間</b>' + esc(timeText) + '</div>';
  if (ev.location) html += '<div class="ag-detail-row"><b>場所</b>' + esc(ev.location) + '</div>';
  if (ev.memo) html += '<div class="ag-detail-row ag-detail-memo"><b>メモ</b>' + esc(ev.memo).replace(/\n/g, '<br>') + '</div>';

  if (ev.escort) {
    var parts = [];
    for (var i = 0; i < ESCORT_ROLES.length; i++) {
      var r = ESCORT_ROLES[i];
      if (ev.escort[r] && ev.escort[r].length) {
        var names = ev.escort[r].map(function (k) { return memberByKey(k).label; }).join('・');
        parts.push(ESCORT_ICONS[r] + ESCORT_LABELS[r] + ':' + names);
      }
    }
    if (parts.length) html += '<div class="ag-detail-row">' + esc(parts.join('　')) + '</div>';
  }

  html += '<button type="button" class="btn ag-detail-edit" data-id="' + esc(ev.id) + '">編集する</button>';
  return html;
}

/* 月表示の詳細パネルの予定をタップしても編集を開けるようにする。
   以前はアジェンダ(縦向きの1日表示)の行しかタップできず、月表示で
   その日の予定を見ているときに「直したい」と思っても開けなかった。 */
function initMonthDetailTap() {
  $('month-detail').addEventListener('click', function (ev) {
    var row = ev.target.closest('.md-ev');
    if (!row) return;
    var found = eventById(row.getAttribute('data-id'));
    if (found) openEditEvent(found);
  });
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
  $('s-kiosk').checked = !!CFG.kiosk;

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
  CFG.kiosk      = $('s-kiosk').checked;
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
  applyKioskMode();
  STATE.events = [];
  fetchData(false);
  fetchWeather();
}

/* ------------------------------------------------------------------
   11.5 予定を追加
   Googleカレンダーの「ファミリー カレンダー」に直接書き込む。
   GAS(doPost)へJSONを送るが、Content-Typeは text/plain にすること。
   application/json にすると、iOS Safari + GAS の組み合わせで
   CORSプリフライトが通らず失敗することがあるため。
   ------------------------------------------------------------------ */
function renderAddMemberPicker(selectedKey) {
  var all = memberList().concat([SHARED]);
  var html = '';
  for (var i = 0; i < all.length; i++) {
    var m = all[i];
    html += '<button type="button" class="am-pick' + (m.key === selectedKey ? ' sel' : '') +
            '" data-key="' + m.key + '" style="--c:' + m.color + '">' + esc(m.label) + '</button>';
  }
  $('ae-members').innerHTML = html;
}

/* ピル1つ1つにリスナーを付けるのではなく、親要素で受け止めて
   実際にタップされたボタンを closest() で特定する(委譲)。
   一部のiOS Safariで「どこを押しても同じボタンが選ばれる」報告が
   あったため、個別リスナー方式より取りこぼしに強いこちらに変更した。 */
function initAddMemberPicker() {
  $('ae-members').addEventListener('click', function (ev) {
    var btn = ev.target.closest('.am-pick');
    if (!btn) return;
    renderAddMemberPicker(btn.getAttribute('data-key'));
  });
}

/* 送り・迎え・付き添いの担当ピッカー（役割ごとに複数人チェック可）。
   「誰の予定？」とは違い排他選択ではないので、タップしたボタン自身の
   .selだけをトグルする（他のボタンには触らない）。 */
function renderEscortPicker(role, selectedKeys) {
  var sel = selectedKeys || [];
  var all = memberList();
  var html = '';
  for (var i = 0; i < all.length; i++) {
    var m = all[i];
    html += '<button type="button" class="am-pick' + (sel.indexOf(m.key) >= 0 ? ' sel' : '') +
            '" data-key="' + m.key + '" style="--c:' + m.color + '">' + esc(m.label) + '</button>';
  }
  $('ae-escort-' + role).innerHTML = html;
}
function renderEscortPickers(escort) {
  var e = escort || emptyEscort();
  for (var i = 0; i < ESCORT_ROLES.length; i++) {
    renderEscortPicker(ESCORT_ROLES[i], e[ESCORT_ROLES[i]]);
  }
}
function initEscortPickers() {
  for (var i = 0; i < ESCORT_ROLES.length; i++) {
    (function (role) {
      $('ae-escort-' + role).addEventListener('click', function (ev) {
        var btn = ev.target.closest('.am-pick');
        if (!btn) return;
        btn.classList.toggle('sel');
      });
    })(ESCORT_ROLES[i]);
  }
}
function readEscortSelections() {
  var out = emptyEscort();
  for (var i = 0; i < ESCORT_ROLES.length; i++) {
    var role = ESCORT_ROLES[i];
    var picks = $('ae-escort-' + role).querySelectorAll('.am-pick.sel');
    var keys = [];
    for (var j = 0; j < picks.length; j++) keys.push(picks[j].getAttribute('data-key'));
    out[role] = keys;
  }
  return out;
}

/* 編集中の予定。null なら新規追加、値があれば「その予定を編集中」。 */
STATE.editingEvent = null;

/* 予定の保存/削除の進行状況を⚙の横に小さく出す。GAS側の書き込みは
   数秒かかることがあるため、モーダルは操作した瞬間に閉じてしまい、
   その間も普段通りボードを操作できるようにしている(下のsubmitAddEvent/
   deleteCurrentEvent参照)。その代わり、裏で進んでいることが分かる
   ようにこのバッジで知らせる。 */
var syncStatusTimer = null;
function setSyncStatus(text, kind) {
  var el = $('sync-status');
  clearTimeout(syncStatusTimer);
  if (!text) { el.hidden = true; el.textContent = ''; el.className = 'sync-status'; return; }
  el.hidden = false;
  el.textContent = text;
  el.className = 'sync-status' + (kind ? ' ' + kind : '');
  if (kind !== 'saving') {
    syncStatusTimer = setTimeout(function () { setSyncStatus(''); }, kind === 'err' ? 8000 : 3000);
  }
}

function openAddEvent() {
  STATE.editingEvent = null;
  $('ae-heading').textContent = '予定を追加';
  $('ae-save').textContent = '追加する';
  $('ae-delete').hidden = true;
  $('ae-save').disabled = false;
  $('ae-delete').disabled = false;
  $('ae-msg').textContent = '';
  $('ae-title').value = '';
  $('ae-location').value = '';
  $('ae-memo').value = '';
  $('ae-allday').checked = false;
  $('ae-time-row').hidden = false;
  $('ae-date').value = ymd(STATE.viewDate);
  $('ae-start').value = '09:00';
  $('ae-end').value = '10:00';
  renderAddMemberPicker(null);
  renderEscortPickers(null);
  $('modal-add').hidden = false;
}

/* 既存の予定をタップしたときに呼ばれる。同じフォームを編集モードで開く。 */
function openEditEvent(ev) {
  STATE.editingEvent = ev;
  $('ae-heading').textContent = '予定を編集';
  $('ae-save').textContent = '更新する';
  $('ae-delete').hidden = false;
  /* 繰り返し予定はカレンダー側で1件だけ直せず、全体が壊れるので、ボードからは触らせない */
  $('ae-save').disabled = !!ev.recurring;
  $('ae-delete').disabled = !!ev.recurring;
  $('ae-msg').textContent = ev.recurring ? '繰り返し予定はボードから変更できません。Googleカレンダーで直してください' : '';
  $('ae-title').value = ev.title;
  $('ae-location').value = ev.location || '';
  $('ae-memo').value = ev.memo || '';
  $('ae-allday').checked = ev.allDay;
  $('ae-time-row').hidden = ev.allDay;
  $('ae-date').value = ymd(ev.start);
  $('ae-start').value = ev.allDay ? '09:00' : hhmm(ev.start);
  $('ae-end').value = ev.allDay ? '10:00' : hhmm(ev.end);
  renderAddMemberPicker(ev.member);
  renderEscortPickers(ev.escort);
  $('modal-add').hidden = false;
}

function closeAddEvent() {
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  STATE.editingEvent = null;
  $('modal-add').hidden = true;
  $('modal-add').scrollTop = 0;
  window.scrollTo(0, 0);
}

function readAddEventForm() {
  var sel = $('ae-members').querySelector('.am-pick.sel');
  return {
    member: sel ? sel.getAttribute('data-key') : null,
    title: $('ae-title').value.trim(),
    allDay: $('ae-allday').checked,
    date: $('ae-date').value,
    start: $('ae-start').value,
    end: $('ae-end').value,
    location: $('ae-location').value.trim(),
    memo: $('ae-memo').value.trim(),
    escort: readEscortSelections()
  };
}

function validateAddEventForm(f) {
  if (!CFG.endpoint) return '⚙で取得URLを設定すると使えます（デモ表示中は追加できません）';
  if (!f.member) return '誰の予定か選んでください';
  if (!f.title) return 'タイトルを入れてください';
  if (!f.date) return '日付を選んでください';
  if (!f.allDay && (!f.start || !f.end)) return '開始・終了の時刻を入れてください';
  if (!f.allDay && f.start >= f.end) return '終了時刻は開始時刻より後にしてください';
  return null;
}

function submitAddEvent() {
  var f = readAddEventForm();
  var err = validateAddEventForm(f);
  if (err) { $('ae-msg').textContent = err; return; }

  var payload = {
    member: f.member, title: f.title, allDay: f.allDay,
    date: f.date, startTime: f.start, endTime: f.end,
    location: f.location, description: buildDescriptionWithEscort(f.memo, f.escort)
  };
  var isUpdate = !!STATE.editingEvent;
  if (isUpdate) {
    payload.action = 'update';
    payload.id = STATE.editingEvent.id;
    payload.calId = STATE.editingEvent.calId;
  }

  // GAS側の書き込みは数秒かかることがあるので、待たせずにその日の
  // 画面へすぐ戻す。保存自体は裏で続け、状況は⚙横のバッジで示す。
  closeAddEvent();
  setSyncStatus(isUpdate ? '更新中…' : '追加中…', 'saving');

  fetch(CFG.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.ok) throw new Error(data.error || '保存に失敗しました');
      STATE.events = [];
      fetchData(false);
      setSyncStatus(isUpdate ? '更新しました' : '追加しました', 'ok');
    })
    .catch(function (e) {
      setSyncStatus('保存できません: ' + String(e.message || e).slice(0, 40), 'err');
    });
}

function deleteCurrentEvent() {
  if (!STATE.editingEvent) return;
  if (!window.confirm('この予定を削除しますか？\n' + STATE.editingEvent.title)) return;

  var id = STATE.editingEvent.id;
  var calId = STATE.editingEvent.calId;

  closeAddEvent();
  setSyncStatus('削除中…', 'saving');

  fetch(CFG.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'delete', id: id, calId: calId })
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.ok) throw new Error(data.error || '削除に失敗しました');
      STATE.events = [];
      fetchData(false);
      setSyncStatus('削除しました', 'ok');
    })
    .catch(function (e) {
      setSyncStatus('削除できません: ' + String(e.message || e).slice(0, 40), 'err');
    });
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

/* Wake Lock APIはiOS 16.4未満のSafariには存在せず、対象機種(iOS 15〜16)の
   一部では何もしていない可能性がある。また対応端末でも、バックグラウンド
   遷移やOS都合で無音のうちに解放されることがある(iOS Safariで既知)。
   そのため: (1) 解放イベントで即座に再取得を試み、(2) 念のため数分おきにも
   再取得を試み、(3) Wake Lock自体が使えない端末では、古くから知られる
   「無音の動画を再生させ続けるとiOS Safariはスリープしない」という手法
   (canvas.captureStream()で映像を自作。ライブラリ不要)にフォールバックする。 */
var wakeLockObj = null;

function keepAwake() {
  if (navigator.wakeLock && navigator.wakeLock.request) {
    navigator.wakeLock.request('screen')
      .then(function (lock) {
        wakeLockObj = lock;
        lock.addEventListener('release', function () { wakeLockObj = null; });
      })
      .catch(function () { startNoSleepFallback(); });
  } else {
    startNoSleepFallback();
  }
}

function startNoSleepFallback() {
  if (window.__noSleepVideo) return;
  try {
    var canvas = document.createElement('canvas');
    canvas.width = 2; canvas.height = 2;
    var ctx = canvas.getContext('2d');
    var toggle = 0;
    function draw() {
      toggle = 1 - toggle;
      ctx.fillStyle = toggle ? '#000000' : '#010101';
      ctx.fillRect(0, 0, 2, 2);
    }
    draw();

    var stream = canvas.captureStream(1);
    var video = document.createElement('video');
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.muted = true;
    video.style.position = 'fixed';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    video.srcObject = stream;
    document.body.appendChild(video);
    var timer = setInterval(draw, 1000);
    video.play().catch(function () {});
    window.__noSleepVideo = { video: video, timer: timer };
  } catch (e) {}
}

/* ------------------------------------------------------------------
   12.5 常時表示モード（壁掛け用）
   ⚙・＋などのボタンを普段は消しておき、画面をタップした瞬間だけ
   数秒間だけ表示する。日付移動のスワイプ等、既存のタッチ検知
   (STATE.lastTouch) にそのまま相乗りする。
   ------------------------------------------------------------------ */
var kioskHideTimer = null;

function showKioskControls() {
  if (!CFG.kiosk) return;
  document.body.classList.add('controls-visible');
  clearTimeout(kioskHideTimer);
  kioskHideTimer = setTimeout(function () {
    document.body.classList.remove('controls-visible');
  }, 6000);
}

function applyKioskMode() {
  document.body.classList.toggle('kiosk-mode', !!CFG.kiosk);
  document.body.classList.remove('controls-visible');
  clearTimeout(kioskHideTimer);
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

  applyKioskMode();
  renderAll();
  tickClock();
  fetchData(false);
  fetchWeather();

  setInterval(tickClock, 1000);
  setInterval(function () { fetchData(true); }, Math.max(1, CFG.refreshMin) * 60000);
  setInterval(fetchWeather, 20 * 60000);
  setInterval(burnInShift, 3 * 60000);
  setInterval(renderNextUp, 60000);
  // Wake Lockが無音のうちに解放されていた場合の保険で、数分おきに取り直す
  setInterval(function () { if (!wakeLockObj) keepAwake(); }, 3 * 60000);

  // 操作が5分止まったら自動的に今日(1日表示)へ戻す
  setInterval(function () {
    var idle = Date.now() - STATE.lastTouch > 5 * 60000;
    var notToday = ymd(STATE.viewDate) !== ymd(new Date());
    if (idle && (STATE.monthMode || notToday)) {
      STATE.viewDate = startOfDay(new Date());
      if (STATE.monthMode) { setMonthMode(false); } else { renderAll(); }
    }
  }, 30000);

  window.addEventListener('resize', function () { sizeHours(); sizeSchoolCol(); updateNowLine(); });
  window.addEventListener('orientationchange', function () { setTimeout(renderAll, 300); });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { tickClock(); fetchData(true); fetchWeather(); keepAwake(); }
  });

  function touched() { STATE.lastTouch = Date.now(); showKioskControls(); }
  document.addEventListener('touchstart', touched, { passive: true });
  document.addEventListener('click', touched);

  $('btn-prev').addEventListener('click', function () {
    if (STATE.monthMode) {
      var d = STATE.viewDate;
      STATE.viewDate = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      STATE.monthSelectedKey = defaultMonthSelection(STATE.viewDate);
    } else {
      STATE.viewDate = addDays(STATE.viewDate, -1);
    }
    renderAll();
  });
  $('btn-next').addEventListener('click', function () {
    if (STATE.monthMode) {
      var d2 = STATE.viewDate;
      STATE.viewDate = new Date(d2.getFullYear(), d2.getMonth() + 1, 1);
      STATE.monthSelectedKey = defaultMonthSelection(STATE.viewDate);
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

  $('btn-add').addEventListener('click', openAddEvent);
  $('ae-close').addEventListener('click', closeAddEvent);
  $('ae-save').addEventListener('click', submitAddEvent);
  $('ae-delete').addEventListener('click', deleteCurrentEvent);
  initAddMemberPicker();
  initEscortPickers();
  initAgendaTap();
  initMonthDetailTap();
  $('ae-allday').addEventListener('change', function () {
    $('ae-time-row').hidden = this.checked;
  });
  $('modal-add').addEventListener('click', function (ev) {
    if (ev.target === $('modal-add')) closeAddEvent();
  });

  // 時限表: ボードの🏫バッジ・時限の帯、アジェンダの🏫バッジをタップして開く。
  // ev.stopPropagation()で止めておかないと、同じクリックがdocumentまで
  // 伝わって「外側タップで閉じる」の判定に引っかかり、開いた瞬間に閉じてしまう。
  $('lanes-head').addEventListener('click', function (ev) {
    if (ev.target.closest('.lh-school')) { ev.stopPropagation(); openSchoolTable(schoolLaneRect()); return; }
    // 見出し（名前）をタップしたら、その人の今後の予定一覧を出す
    var lane = ev.target.closest('.lh');
    if (lane && lane.getAttribute('data-member')) {
      ev.stopPropagation();
      openMemberSchedule(lane.getAttribute('data-member'), lane.getBoundingClientRect());
    }
  });
  $('lanes').addEventListener('click', function (ev) {
    if (ev.target.closest('.school-col')) { ev.stopPropagation(); openSchoolTable(schoolLaneRect()); return; }
    // 予定そのものをタップしたら、縦向きと同じ詳細パネルを出す（編集はその中のボタンから）
    var row = ev.target.closest('.ev');
    if (row) {
      ev.stopPropagation();
      var found = eventById(row.getAttribute('data-id'));
      if (found) {
        var titleEl = row.querySelector('.ev-n');
        openEventDetail(found, row.getAttribute('data-escort-role') || '',
          titleEl ? titleEl.textContent : found.title, row.getBoundingClientRect());
      }
    }
  });
  $('agenda').addEventListener('click', function (ev) {
    var badge = ev.target.closest('.ag-school');
    if (badge) { ev.stopPropagation(); openSchoolTable(badge.getBoundingClientRect()); }
  });
  $('school-close').addEventListener('click', closeSchoolTable);
  initMemberScheduleTap();
  initEventDetailTap();
  // パネルの外側をタップしたら閉じる（設定等の.modalと違い背景を敷いていないため）
  document.addEventListener('click', function (ev) {
    var flyout = $('school-flyout');
    if (!flyout.hidden && !flyout.contains(ev.target)) closeSchoolTable();
    var mflyout = $('member-flyout');
    if (!mflyout.hidden && !mflyout.contains(ev.target)) closeMemberSchedule();
    var eflyout = $('event-flyout');
    if (!eflyout.hidden && !eflyout.contains(ev.target)) closeEventDetail();
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
        STATE.monthSelectedKey = defaultMonthSelection(STATE.viewDate);
      } else {
        STATE.viewDate = addDays(STATE.viewDate, dx < 0 ? 1 : -1);
      }
      renderAll();
    }
  }, { passive: true });

  keepAwake();

  /* 壁掛けボードのように何日も再読み込みされない画面は、新しいバージョンを
     デプロイしても、ブラウザが自分でsw.jsの更新に気づくまで（最大でも
     半日〜1日程度かかることがある）ずっと古いapp.jsのまま動き続けてしまう。
     この「新機能が本番反映されたはずなのに壁掛け側だけ古い動きのまま」を
     防ぐため、①一定間隔で明示的に更新チェックし、②新しいService Workerに
     切り替わったら（＝新バージョンが降ってきたら）ページごと自動で
     再読み込みする。hadControllerで「初回インストール時の切り替わり」を
     除外し、以降の「本当の更新」のときだけリロードする。 */
  if ('serviceWorker' in navigator) {
    var hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      setInterval(function () { reg.update().catch(function () {}); }, 30 * 60000);
    }).catch(function () {});
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (hadController) { location.reload(); return; }
      hadController = true;
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
