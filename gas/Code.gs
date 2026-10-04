/**
 * =====================================================================
 *  家族ボード — データ配信スクリプト（Google Apps Script）
 *
 *  Googleカレンダーの予定を読み取って、家族ボードPWAにJSONで渡します。
 *  カレンダーを「一般公開」せずに済むのがポイントです。
 *
 *  【使い方】
 *   1. https://script.google.com/ で新規プロジェクトを作り、このファイルの
 *      中身をぜんぶ貼り付ける
 *   2. 下の CONFIG を家族用に書き換える
 *   3. 上部の関数選択で「listMyCalendars」を選び▶実行 → 実行ログに
 *      カレンダーIDの一覧が出るので、必要なIDを CONFIG に貼る
 *   4. 「デプロイ」→「新しいデプロイ」→種類「ウェブアプリ」
 *        次のユーザーとして実行: 自分
 *        アクセスできるユーザー: 全員
 *      → 発行された /exec で終わるURLを、家族ボードの⚙設定に貼る
 *
 *  ※「アクセスできるユーザー: 全員」でも、URLを知らない人には届きません。
 *    URLは家族以外に共有しないでください。
 * =====================================================================
 */

var CONFIG = {

  /* 表示する5人。key は index.html / app.js 側と必ず一致させること。
     - calendars : この人専用のカレンダーID（複数可・無くてもよい）
     - tags      : 予定タイトルの先頭に付ける目印（【父】父: #父 などに対応）
     - colorIds  : 1つの家族カレンダーを色分けで運用する場合の Google の色番号
                   （1薄紫 2薄緑 3紫 4赤桃 5黄 6橙 7水 8灰 9青 10緑 11赤） */
  members: [
    { key: 'father',   tags: ['父', 'パパ', 'とうさん'],   calendars: [], colorIds: [] },
    { key: 'mother',   tags: ['母', 'ママ', 'かあさん'],   calendars: [], colorIds: [] },
    { key: 'son1',     tags: ['長男', '兄', '2年生'],      calendars: [], colorIds: [] },
    { key: 'son2',     tags: ['次男', '弟'],               calendars: [], colorIds: [] },
    { key: 'daughter', tags: ['長女', '妹'],               calendars: [], colorIds: [] }
  ],

  /* 誰のものとも判定できなかった予定を入れる、家族共通のカレンダー。
     ここに入れたものは「みんな」レーンに出ます。 */
  sharedCalendars: [
    'family02965375801837896526@group.calendar.google.com'
  ],

  /* ここに入れたカレンダーからは「目印(tags)か色が付いた予定だけ」を取り込みます。
     個人カレンダーのように、Gmailが自動で作る宿やレストランの予約が混ざる場所を
     ボードに出したいときに使います。目印の無い予定は丸ごと無視されます。
     例: ['自分のアドレス@gmail.com'] */
  tagOnlyCalendars: [],

  /* 祝日カレンダー（時計の下と月カレンダーの色に使用）。不要なら '' に。 */
  holidayCalendar: 'ja.japanese#holiday@group.v.calendar.google.com',

  /* 取得しない予定のタイトル（部分一致）。例: ['誕生日'] */
  excludeTitles: [],

  /* 空文字なら認証なし。設定すると ?key=... が必要になる。 */
  accessKey: '',

  /* 何日前の予定から返すか。以前は「昨日から」だったため、先週の予定が
     ボードに出ず、後から日付を直す/内容を確認することもできなかった。 */
  pastDays: 14,

  timeZone: 'Asia/Tokyo'
};

/* =====================================================================
   ここから下は通常さわらなくて大丈夫です
   ===================================================================== */

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};

    if (CONFIG.accessKey && params.key !== CONFIG.accessKey) {
      return json({ ok: false, error: 'unauthorized' });
    }

    var days = Math.min(parseInt(params.days, 10) || 45, 120);

    var now = new Date();
    var from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (CONFIG.pastDays || 1));
    var to   = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);

    var events = collectEvents(from, to);
    var holidays = collectHolidays(from, to);

    return json({
      ok: true,
      generatedAt: fmt(now),
      rangeStart: fmt(from),
      rangeEnd: fmt(to),
      count: events.length,
      events: events,
      holidays: holidays
    });

  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/* ---------------------------------------------------------------------
   予定の追加・編集・削除（家族ボードの「＋」／予定タップから呼ばれる）

   POSTの本文はJSON文字列（Content-Type: text/plain で送る決まり。
   application/json にすると、iOSのSafari/GASの組み合わせでCORSの
   プリフライトが通らないことがあるため、あえて text/plain にしている）。

   追加: { member, title, allDay, date, startTime, endTime, location, description }
   更新: 上記 + { action:'update', id, calId }
   削除: { action:'delete', id, calId }

   id/calId は doGet が返す予定データの id/calId をそのまま返すこと。
   --------------------------------------------------------------------- */
/* 繰り返し予定は、CalendarAppのsetTime/deleteEventを呼ぶとシリーズ全体が動く/消える
   （本番データで確認済み）ため、CalendarAppでは触らない。代わりにCalendar高度サービス
   （Calendar.Events.*）で、body.scope = 'this'(この回だけ) / 'following'(これ以降すべて) /
   'all'(すべて) に応じて安全に変更する。下の「繰り返し予定の編集・削除」参照。 */

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    if (CONFIG.accessKey && body.key !== CONFIG.accessKey) {
      return json({ ok: false, error: 'unauthorized' });
    }

    if (body.action === 'delete') {
      if (!body.id) return json({ ok: false, error: 'idが指定されていません' });
      var target = findRawEvent(body.id, body.calId);
      if (!target) return json({ ok: false, error: '予定が見つかりません（既に削除された可能性があります）' });
      if (target.isRecurringEvent()) {
        deleteRecurring(target, body.calId, body.scope);
        return json({ ok: true });
      }
      target.deleteEvent();
      return json({ ok: true });
    }

    // 追加・更新とも、まず新しい内容を検証してから書き込む
    // （更新で先に古い予定を消してしまい、検証エラーで内容だけ消える事故を防ぐため）。
    var fields = buildEventFields(body);

    if (body.action === 'update') {
      if (!body.id) return json({ ok: false, error: 'idが指定されていません' });
      var old = findRawEvent(body.id, body.calId);
      if (!old) return json({ ok: false, error: '予定が見つかりません（既に削除された可能性があります）' });
      if (old.isRecurringEvent()) {
        updateRecurring(old, body.calId, fields, body.scope);
        return json({ ok: true });
      }
      var updated = updateEventInPlace(old, fields);
      if (fields.rrule) makeRecurring(updated, fields);
      return json({ ok: true, id: updated.getId() });
    }

    if (fields.rrule) {
      var rec = createRecurringEvent(fields);
      return json({ ok: true, id: rec.id });
    }
    var created = createEventInCalendar(fields);
    return json({ ok: true, id: created.getId() });

  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

/* 入力内容を検証し、書き込みに必要な情報を組み立てる。
   エラーがあれば例外を投げる（doPost側でcatchしてエラー応答にする）。 */
function buildEventFields(body) {
  var title = String(body.title || '').trim();
  if (!title) throw new Error('タイトルが空です');
  if (!body.date) throw new Error('日付が指定されていません');

  var memberDef = null;
  for (var i = 0; i < CONFIG.members.length; i++) {
    if (CONFIG.members[i].key === body.member) { memberDef = CONFIG.members[i]; break; }
  }
  var fullTitle = memberDef ? ('【' + memberDef.tags[0] + '】' + title) : title;

  // 書き込み先：その人専用のカレンダーがあればそこへ、無ければ共通カレンダーへ。
  var calId = (memberDef && memberDef.calendars && memberDef.calendars[0])
            || CONFIG.sharedCalendars[0];
  if (!calId) throw new Error('書き込み先のカレンダーが設定されていません');

  var f = {
    calId: calId,
    fullTitle: fullTitle,
    location: body.location || '',
    description: body.description || '',
    allDay: !!body.allDay,
    dateStr: body.date,
    startHm: body.startTime || '',
    endHm: body.endTime || ''
  };

  if (f.allDay) {
    f.date = parseYmd(body.date);
  } else {
    if (!body.startTime || !body.endTime) throw new Error('開始・終了の時刻が指定されていません');
    f.start = parseYmdHm(body.date, body.startTime);
    f.end = parseYmdHm(body.date, body.endTime);
    if (!(f.end > f.start)) throw new Error('終了時刻は開始時刻より後にしてください');
  }

  if (body.recurrence) {
    f.rrule = buildRrule(body.recurrence, f.allDay);
    f.dateStr = firstOccurrence(body.date, body.recurrence);
  }
  return f;
}

/* ---------------------------------------------------------------------
   繰り返しの新規作成・設定（Calendar高度サービス）
   body.recurrence = { freq:'daily'|'weekly'|'monthly',
                       byday:['MO','WE'],      // weeklyのみ
                       bymonthday: 15 | -1,    // monthlyのみ（-1は月末）
                       count: 10 | null,       // 回数（untilとどちらか）
                       until: 'yyyy-MM-dd' | null }
   クライアントからRRULE文字列は受け取らず、ここで値を検証して組み立てる。
   --------------------------------------------------------------------- */
var WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function buildRrule(rec, allDay) {
  var parts = [];
  if (rec.freq === 'daily') parts.push('FREQ=DAILY');
  else if (rec.freq === 'weekly') {
    var days = [];
    var src = rec.byday || [];
    for (var i = 0; i < src.length; i++) {
      if (WEEKDAY_CODES.indexOf(src[i]) >= 0 && days.indexOf(src[i]) < 0) days.push(src[i]);
    }
    if (!days.length) throw new Error('繰り返す曜日を選んでください');
    parts.push('FREQ=WEEKLY');
    parts.push('BYDAY=' + days.join(','));
  } else if (rec.freq === 'monthly') {
    var md = parseInt(rec.bymonthday, 10);
    if (!(md === -1 || (md >= 1 && md <= 31))) throw new Error('毎月の日にちが正しくありません');
    parts.push('FREQ=MONTHLY');
    parts.push('BYMONTHDAY=' + md);
  } else {
    throw new Error('繰り返しの種類が正しくありません');
  }

  var count = rec.count ? parseInt(rec.count, 10) : 0;
  if (count) {
    if (!(count >= 1 && count <= 730)) throw new Error('繰り返しの回数は1〜730で指定してください');
    parts.push('COUNT=' + count);
  } else if (rec.until) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rec.until)) throw new Error('繰り返しの終了日が正しくありません');
    if (allDay) {
      parts.push('UNTIL=' + rec.until.replace(/-/g, ''));
    } else {
      // その日の終わり(日本時間の23:59:59)までを含める
      var endOfDay = new Date(parseYmd(rec.until).getTime() + DAY_MS - 1000);
      parts.push('UNTIL=' + Utilities.formatDate(endOfDay, 'UTC', "yyyyMMdd'T'HHmmss'Z'"));
    }
  }
  return 'RRULE:' + parts.join(';');
}

/* 開始日が選んだ曜日・日にちと合っていないとき、最初に当てはまる日へ送る */
function firstOccurrence(dateStr, rec) {
  if (rec.freq === 'daily') return dateStr;
  var base = parseYmd(dateStr);
  for (var i = 0; i < 370; i++) {
    var d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    var ok;
    if (rec.freq === 'weekly') {
      ok = (rec.byday || []).indexOf(WEEKDAY_CODES[d.getDay()]) >= 0;
    } else {
      var md = parseInt(rec.bymonthday, 10);
      var last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      ok = (md === -1) ? (d.getDate() === last) : (d.getDate() === md);
    }
    if (ok) return Utilities.formatDate(d, CONFIG.timeZone, 'yyyy-MM-dd');
  }
  return dateStr;
}

function createRecurringEvent(f) {
  requireCalendarApi();
  var body = { summary: f.fullTitle, location: f.location, description: f.description, recurrence: [f.rrule] };
  body.start = apiTimes(f, f.dateStr, true).start;
  body.end = apiTimes(f, f.dateStr, true).end;
  return Calendar.Events.insert(body, f.calId);
}

/* 単発の既存予定に繰り返しを設定する（編集画面で「繰り返し」にチェックしたとき） */
function makeRecurring(ev, f) {
  requireCalendarApi();
  var listed = Calendar.Events.list(f.calId, { iCalUID: ev.getId(), showDeleted: false, maxResults: 5 });
  var items = (listed && listed.items) || [];
  if (!items.length) throw new Error('繰り返しにする予定が見つかりません');
  var body = { recurrence: [f.rrule] };
  var t = apiTimes(f, f.dateStr, false);
  body.start = t.start;
  body.end = t.end;
  Calendar.Events.patch(body, f.calId, items[0].id);
}

function createEventInCalendar(f) {
  var cal = CalendarApp.getCalendarById(f.calId);
  if (!cal) throw new Error('カレンダーが見つかりません: ' + f.calId);

  if (f.allDay) {
    return cal.createAllDayEvent(f.fullTitle, f.date, { location: f.location, description: f.description });
  }
  return cal.createEvent(f.fullTitle, f.start, f.end, { location: f.location, description: f.description });
}

/* 既存の予定を「その場で」書き換える。以前は古い予定を削除して作り直して
   いたが、繰り返し予定の1回分を直そうとしたときにシリーズごと消えてしまう
   事故が起きたため、setTitle/setTime等で該当の1件だけを直接更新する方式に
   した（IDも変わらず、通知などの設定も引き継がれる）。
   書き込み先のカレンダーが変わる場合だけは移せないので、作り直す。 */
function updateEventInPlace(ev, f) {
  if (ev.getOriginalCalendarId() !== f.calId) {
    var created = createEventInCalendar(f);
    ev.deleteEvent();
    return created;
  }
  ev.setTitle(f.fullTitle);
  ev.setLocation(f.location);
  ev.setDescription(f.description);
  if (f.allDay) {
    ev.setAllDayDate(f.date);
  } else {
    ev.setTime(f.start, f.end);
  }
  return ev;
}

/* =====================================================================
   繰り返し予定の編集・削除（Calendar高度サービス = Calendar.Events.*）

   ★事前準備: Apps Scriptエディタの「サービス ＋」→「Google Calendar API」(v3)を
     追加しておくこと（識別子は Calendar のまま）。無料。
   ★CalendarApp の getId() は iCalUID を返し、API の event id とは別物。
     そのため Calendar.Events.list({iCalUID}) で元の予定(master)を引き、
     Calendar.Events.instances() で「この回」(instance)を開始時刻で特定する。

   scope:
     'this'      … この回だけ（instance を patch / remove。例外として個別に変わる）
     'all'       … すべて（master を patch / remove。日付は動かさず内容と時刻だけ変える）
     'following' … これ以降すべて（master を前日で打ち切り、この回からの新しい繰り返しを作る。
                   最初の回なら master をそのまま変更/削除。日付は動かさない）
   ===================================================================== */
var DAY_MS = 86400000;

function requireCalendarApi() {
  if (typeof Calendar === 'undefined' || !Calendar.Events) {
    throw new Error('Calendar高度サービスが有効になっていません（Apps Scriptの「サービス」でGoogle Calendar APIを追加してください）');
  }
}

function checkScope(scope) {
  if (scope !== 'this' && scope !== 'following' && scope !== 'all') {
    throw new Error('繰り返し予定は変更する範囲（この日だけ／これ以降すべて／すべて）を選んでください');
  }
}

function ymdStr(d) {
  return Utilities.formatDate(d, CONFIG.timeZone, 'yyyy-MM-dd');
}

/* APIの予定が始まるミリ秒（終日は日付の0時） */
function startMsOf(item) {
  if (item.start && item.start.dateTime) return new Date(item.start.dateTime).getTime();
  return parseYmd(item.start.date).getTime();
}

/* APIの予定が始まる日（yyyy-MM-dd） */
function startDateOf(item) {
  if (item.start && item.start.dateTime) return ymdStr(new Date(item.start.dateTime));
  return item.start.date;
}

/* CalendarAppのインスタンスevから、API上のmasterとinstanceを引き当てる */
function resolveRecurring(ev, calId) {
  requireCalendarApi();
  if (!calId) throw new Error('calIdが指定されていません');

  var listed = Calendar.Events.list(calId, { iCalUID: ev.getId(), showDeleted: false, maxResults: 50 });
  var master = null;
  var items = (listed && listed.items) || [];
  for (var i = 0; i < items.length; i++) {
    if (items[i].recurrence && items[i].recurrence.length) { master = items[i]; break; }
  }
  if (!master) throw new Error('繰り返しの元の予定が見つかりません');

  var allDay = ev.isAllDayEvent();
  var startMs = ev.getStartTime().getTime();
  var targetDate = allDay ? ymdStr(ev.getAllDayStartDate()) : '';
  var insts = Calendar.Events.instances(calId, master.id, {
    timeMin: new Date(startMs - 2 * DAY_MS).toISOString(),
    timeMax: new Date(startMs + 3 * DAY_MS).toISOString(),
    showDeleted: false,
    maxResults: 50
  });
  var inst = null;
  var arr = (insts && insts.items) || [];
  for (var j = 0; j < arr.length; j++) {
    var hit = allDay ? (arr[j].start.date === targetDate) : (startMsOf(arr[j]) === startMs);
    if (hit) { inst = arr[j]; break; }
  }
  if (!inst) throw new Error('繰り返しのこの回が見つかりません（既に変更または削除された可能性があります）');

  return { master: master, inst: inst, allDay: allDay };
}

function rruleIndex(rec) {
  for (var i = 0; i < rec.length; i++) {
    if (/^RRULE:/i.test(rec[i])) return i;
  }
  return -1;
}
function rruleParts(line) {
  return line.replace(/^RRULE:/i, '').split(';').filter(function (p) { return p; });
}
function partsWithout(parts, names) {
  return parts.filter(function (p) { return names.indexOf(p.split('=')[0].toUpperCase()) < 0; });
}
function partValue(parts, name) {
  for (var i = 0; i < parts.length; i++) {
    var kv = parts[i].split('=');
    if (kv[0].toUpperCase() === name) return kv.slice(1).join('=');
  }
  return null;
}

/* masterを「この回の直前まで」で打ち切った繰り返しルール（RRULEのUNTILに置き換え、COUNTは外す） */
function truncatedRecurrence(master, instItem) {
  var rec = master.recurrence.slice();
  var idx = rruleIndex(rec);
  if (idx < 0) throw new Error('繰り返しルールが読み取れません');
  var parts = partsWithout(rruleParts(rec[idx]), ['UNTIL', 'COUNT']);
  var until;
  if (instItem.start.dateTime) {
    // この回の「開始時刻」ではなく「その日の0時の1秒前」で打ち切る。開始時刻にすると、
    // 後から「すべて」で時刻を動かしたときに、打ち切ったはずの回が復活してしまう（実測）。
    var dayStart = parseYmd(startDateOf(instItem));
    until = Utilities.formatDate(new Date(dayStart.getTime() - 1000), 'UTC', "yyyyMMdd'T'HHmmss'Z'");
  } else {
    var prev = parseYmd(instItem.start.date);
    prev.setDate(prev.getDate() - 1);
    until = Utilities.formatDate(prev, CONFIG.timeZone, 'yyyyMMdd');
  }
  parts.push('UNTIL=' + until);
  rec[idx] = 'RRULE:' + parts.join(';');
  return rec;
}

/* 「これ以降」の新しい繰り返しルール。回数指定(COUNT)の場合は、すでに過ぎた回を引いた残りにする。
   EXDATE等は元のシリーズ基準なので引き継がない。 */
function followingRecurrence(master, instItem, calId) {
  var idx = rruleIndex(master.recurrence);
  if (idx < 0) throw new Error('繰り返しルールが読み取れません');
  var parts = rruleParts(master.recurrence[idx]);
  var count = partValue(parts, 'COUNT');
  if (count !== null) {
    var before = Calendar.Events.instances(calId, master.id, {
      timeMax: new Date(startMsOf(instItem)).toISOString(),
      showDeleted: false,
      maxResults: 2500
    });
    var done = ((before && before.items) || []).length;
    var remain = Math.max(1, parseInt(count, 10) - done);
    parts = partsWithout(parts, ['COUNT']);
    parts.push('COUNT=' + remain);
  }
  return ['RRULE:' + parts.join(';')];
}

/* フォームの内容をAPI用の start/end に直す。patchのときは、終日⇔時刻ありの切り替えで
   古い方を消せるよう null を入れる。insertのときは null を入れない。 */
function apiTimes(f, dateStr, forInsert) {
  var tz = CONFIG.timeZone;
  var out = {};
  if (f.allDay) {
    var d = parseYmd(dateStr);
    var e = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    out.start = { date: ymdStr(d) };
    out.end = { date: ymdStr(e) };
    if (!forInsert) { out.start.dateTime = null; out.end.dateTime = null; }
  } else {
    out.start = { dateTime: fmt(parseYmdHm(dateStr, f.startHm)), timeZone: tz };
    out.end = { dateTime: fmt(parseYmdHm(dateStr, f.endHm)), timeZone: tz };
    if (!forInsert) { out.start.date = null; out.end.date = null; }
  }
  return out;
}

function withTimes(base, times) {
  base.start = times.start;
  base.end = times.end;
  return base;
}

function updateRecurring(ev, calId, f, scope) {
  checkScope(scope);
  if (ev.getOriginalCalendarId() !== f.calId) {
    throw new Error('繰り返し予定は、別のカレンダーへ移すような変更はできません');
  }
  var r = resolveRecurring(ev, calId);
  var master = r.master;
  var inst = r.inst;
  var common = function () { return { summary: f.fullTitle, location: f.location, description: f.description }; };
  var isFirst = startMsOf(master) === startMsOf(inst);

  if (scope === 'this') {
    Calendar.Events.patch(withTimes(common(), apiTimes(f, f.dateStr, false)), calId, inst.id);
    return;
  }

  // 'all' / 'following' は日付を動かさない（曜日指定などの繰り返しルールとずれるため）。
  // 日付を変えたいときは 'this'（この日だけ）で行う。内容と「時刻」だけを反映する。
  if (scope === 'all' || isFirst) {
    Calendar.Events.patch(withTimes(common(), apiTimes(f, startDateOf(master), false)), calId, master.id);
    return;
  }

  // following（2回目以降）：この回からの新しい繰り返しを作り、元は前日で打ち切る
  var fresh = withTimes(common(), apiTimes(f, startDateOf(inst), true));
  fresh.recurrence = followingRecurrence(master, inst, calId);
  if (master.colorId) fresh.colorId = master.colorId;
  if (master.reminders) fresh.reminders = master.reminders;
  var created = Calendar.Events.insert(fresh, calId);
  try {
    Calendar.Events.patch({ recurrence: truncatedRecurrence(master, inst) }, calId, master.id);
  } catch (err) {
    try { Calendar.Events.remove(calId, created.id); } catch (e2) {}
    throw err;
  }
}

function deleteRecurring(ev, calId, scope) {
  checkScope(scope);
  var r = resolveRecurring(ev, calId);
  if (scope === 'this') {
    Calendar.Events.remove(calId, r.inst.id);
    return;
  }
  if (scope === 'all' || startMsOf(r.master) === startMsOf(r.inst)) {
    Calendar.Events.remove(calId, r.master.id);
    return;
  }
  Calendar.Events.patch({ recurrence: truncatedRecurrence(r.master, r.inst) }, calId, r.master.id);
}

/* doGetが返す複合id("実イベントID@開始時刻ms")とcalIdから、
   実際のCalendarEventを引き当てる。実イベントID自体に"@"を含むことが
   多い(例: xxxx@google.com)ため、最後の"@"で区切る。

   ★getEventById()だけに頼ってはいけない理由が2つある。
   (1) TimeTreeなど外部から取り込まれた予定は、getEvents()一覧には出るのに
       getEventById()ではnullが返る（既知の制限）。
   (2) 繰り返し予定は、全ての回が同じIDを共有し、getEventById()は
       「シリーズの最初の1件」しか返さない。これをそのまま削除/更新すると
       意図しない回、または親を消してシリーズ全体が消える。
   そのため、まず複合idの開始時刻の近辺をgetEvents()で走査し、
   「実ID＋開始時刻」が両方一致する1件を探す。見つからないときだけ
   getEventById()に頼るが、繰り返し予定だった場合は別の回の可能性が
   あるため採用しない。 */
function findRawEvent(compositeId, calId) {
  var s = String(compositeId);
  var idx = s.lastIndexOf('@');
  var rawId = idx >= 0 ? s.substring(0, idx) : s;
  var tsMs = idx >= 0 ? parseInt(s.substring(idx + 1), 10) : NaN;

  if (calId && !isNaN(tsMs)) {
    try {
      var cal2 = CalendarApp.getCalendarById(calId);
      if (cal2) {
        var day = new Date(tsMs);
        var from = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1);
        var to = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 2);
        var candidates = cal2.getEvents(from, to);
        for (var i = 0; i < candidates.length; i++) {
          if (candidates[i].getId() === rawId && candidates[i].getStartTime().getTime() === tsMs) {
            return candidates[i];
          }
        }
      }
    } catch (e2) {
      // 走査に失敗したら下の直接引き当てに進む
    }
  }

  try {
    var direct = null;
    if (calId) {
      var cal = CalendarApp.getCalendarById(calId);
      if (cal) direct = cal.getEventById(rawId);
    }
    if (!direct) direct = CalendarApp.getEventById(rawId);
    if (direct && !direct.isRecurringEvent()) return direct;
  } catch (e) {
    // 見つからなければ下でnullを返す
  }

  return null;
}

function parseYmd(s) {
  var p = String(s).split('-');
  return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
}

function parseYmdHm(dateStr, hm) {
  var d = parseYmd(dateStr);
  var t = String(hm || '00:00').split(':');
  d.setHours(parseInt(t[0], 10), parseInt(t[1], 10), 0, 0);
  return d;
}

function collectEvents(from, to) {
  var out = [];
  var seen = {};

  // 1. メンバー専用カレンダー
  for (var i = 0; i < CONFIG.members.length; i++) {
    var m = CONFIG.members[i];
    for (var c = 0; c < m.calendars.length; c++) {
      pull(m.calendars[c], m.key, from, to, out, seen, false);
    }
  }

  // 2. 家族共通カレンダー（タグ・色で振り分け、無ければ「みんな」）
  for (var s = 0; s < CONFIG.sharedCalendars.length; s++) {
    pull(CONFIG.sharedCalendars[s], null, from, to, out, seen, false);
  }

  // 3. 目印の付いた予定だけを拾うカレンダー（個人カレンダーなど）
  var tagOnly = CONFIG.tagOnlyCalendars || [];
  for (var t = 0; t < tagOnly.length; t++) {
    pull(tagOnly[t], null, from, to, out, seen, true);
  }

  out.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
  return out;
}

function pull(calId, defaultMember, from, to, out, seen, tagOnly) {
  var cal = CalendarApp.getCalendarById(calId);
  if (!cal) {
    Logger.log('カレンダーが見つかりません: ' + calId);
    return;
  }

  var evs = cal.getEvents(from, to);

  for (var i = 0; i < evs.length; i++) {
    var ev = evs[i];
    var title = ev.getTitle() || '(無題)';

    if (isExcluded(title)) continue;

    var uid = ev.getId() + '@' + ev.getStartTime().getTime();
    if (seen[uid]) continue;
    seen[uid] = true;

    var byColor = memberByColor(safeColor(ev));
    var byTag   = memberByTag(title);

    // 目印が無い予定を切り捨てるカレンダー（個人カレンダーなど）
    if (tagOnly && !byTag.key && !byColor) continue;

    var member = byTag.key || byColor || defaultMember || 'shared';
    var clean  = byTag.title;

    var allDay = ev.isAllDayEvent();

    // 終日予定は「日付だけ」で返す。時刻を付けると、カレンダーのタイムゾーンが
    // 東京以外（UTCなど）のときに9時間ずれて2日にまたがって表示されてしまう。
    // end は「翌日」＝終了日の翌日を指す排他的な値（Googleの仕様どおり）。
    var start, end;
    if (allDay) {
      start = Utilities.formatDate(ev.getAllDayStartDate(), CONFIG.timeZone, 'yyyy-MM-dd');
      end   = Utilities.formatDate(ev.getAllDayEndDate(),   CONFIG.timeZone, 'yyyy-MM-dd');
    } else {
      start = fmt(ev.getStartTime());
      end   = fmt(ev.getEndTime());
    }

    out.push({
      id: uid,
      calId: calId,
      member: member,
      title: clean,
      allDay: allDay,
      start: start,
      end: end,
      location: ev.getLocation() || '',
      description: ev.getDescription() || '',
      recurring: ev.isRecurringEvent()
    });
  }
}

/* タイトル先頭のタグで担当を判定し、タグを取り除いたタイトルを返す
   対応形式: 【父】〇〇 / [父]〇〇 / 父:〇〇 / 父：〇〇 / #父 〇〇 / 父　〇〇 */
function memberByTag(title) {
  for (var i = 0; i < CONFIG.members.length; i++) {
    var m = CONFIG.members[i];
    for (var t = 0; t < m.tags.length; t++) {
      var tag = m.tags[t];
      var patterns = [
        '^【\\s*' + tag + '\\s*】\\s*',
        '^\\[\\s*' + tag + '\\s*\\]\\s*',
        '^#\\s*' + tag + '[\\s　]+',
        '^' + tag + '\\s*[:：]\\s*'
      ];
      for (var p = 0; p < patterns.length; p++) {
        var re = new RegExp(patterns[p]);
        if (re.test(title)) {
          return { key: m.key, title: title.replace(re, '').trim() || title };
        }
      }
    }
  }
  return { key: null, title: title };
}

function memberByColor(colorId) {
  if (!colorId) return null;
  for (var i = 0; i < CONFIG.members.length; i++) {
    var ids = CONFIG.members[i].colorIds || [];
    for (var c = 0; c < ids.length; c++) {
      if (String(ids[c]) === String(colorId)) return CONFIG.members[i].key;
    }
  }
  return null;
}

function safeColor(ev) {
  try { return ev.getColor(); } catch (e) { return ''; }
}

function isExcluded(title) {
  for (var i = 0; i < CONFIG.excludeTitles.length; i++) {
    if (CONFIG.excludeTitles[i] && title.indexOf(CONFIG.excludeTitles[i]) >= 0) return true;
  }
  return false;
}

function collectHolidays(from, to) {
  var map = {};
  if (!CONFIG.holidayCalendar) return map;
  try {
    var cal = CalendarApp.getCalendarById(CONFIG.holidayCalendar);
    if (!cal) return map;
    var evs = cal.getEvents(from, to);
    for (var i = 0; i < evs.length; i++) {
      var d = evs[i].isAllDayEvent() ? evs[i].getAllDayStartDate() : evs[i].getStartTime();
      map[Utilities.formatDate(d, CONFIG.timeZone, 'yyyy-MM-dd')] = evs[i].getTitle();
    }
  } catch (e) {
    Logger.log('祝日カレンダー読み込み失敗: ' + e);
  }
  return map;
}

function fmt(d) {
  return Utilities.formatDate(d, CONFIG.timeZone, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------------------------------------------------------------------
   セットアップ補助：▶実行するとカレンダーIDの一覧がログに出ます
   （表示 → 実行ログ）
   --------------------------------------------------------------------- */
function listMyCalendars() {
  var cals = CalendarApp.getAllCalendars();
  Logger.log('--- あなたが見られるカレンダー ---');
  for (var i = 0; i < cals.length; i++) {
    Logger.log('%s\n    ID: %s', cals[i].getName(), cals[i].getId());
  }
}

/* 動作確認：▶実行すると、いま返すJSONの冒頭がログに出ます */
function testOutput() {
  var res = doGet({ parameter: { days: '3' } });
  var text = res.getContent();
  Logger.log('件数など: ' + text.slice(0, 400));
}

/* 動作確認：▶実行すると、テスト用の予定を1件作ってログにIDを出します。
   確認できたらGoogleカレンダー側で削除してください。 */
function testAddEvent() {
  var body = {
    member: 'shared',
    title: 'テスト予定（削除してOK）',
    allDay: false,
    date: Utilities.formatDate(new Date(), CONFIG.timeZone, 'yyyy-MM-dd'),
    startTime: '23:00',
    endTime: '23:30',
    location: ''
  };
  var res = doPost({ postData: { contents: JSON.stringify(body) } });
  Logger.log(res.getContent());
}

