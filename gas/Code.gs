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
    var from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
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
   予定の追加（家族ボードの「＋」から呼ばれる）

   POSTの本文はJSON文字列（Content-Type: text/plain で送る決まり。
   application/json にすると、iOSのSafari/GASの組み合わせでCORSの
   プリフライトが通らないことがあるため、あえて text/plain にしている）。

   { member, title, allDay, date, startTime, endTime, location }
   --------------------------------------------------------------------- */
function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    if (CONFIG.accessKey && body.key !== CONFIG.accessKey) {
      return json({ ok: false, error: 'unauthorized' });
    }

    var title = String(body.title || '').trim();
    if (!title) return json({ ok: false, error: 'タイトルが空です' });
    if (!body.date) return json({ ok: false, error: '日付が指定されていません' });

    var memberDef = null;
    for (var i = 0; i < CONFIG.members.length; i++) {
      if (CONFIG.members[i].key === body.member) { memberDef = CONFIG.members[i]; break; }
    }
    var fullTitle = memberDef ? ('【' + memberDef.tags[0] + '】' + title) : title;

    // 書き込み先：その人専用のカレンダーがあればそこへ、無ければ共通カレンダーへ。
    var calId = (memberDef && memberDef.calendars && memberDef.calendars[0])
              || CONFIG.sharedCalendars[0];
    if (!calId) return json({ ok: false, error: '書き込み先のカレンダーが設定されていません' });

    var cal = CalendarApp.getCalendarById(calId);
    if (!cal) return json({ ok: false, error: 'カレンダーが見つかりません: ' + calId });

    var ev;
    if (body.allDay) {
      var d = parseYmd(body.date);
      ev = cal.createAllDayEvent(fullTitle, d, { location: body.location || '' });
    } else {
      if (!body.startTime || !body.endTime) {
        return json({ ok: false, error: '開始・終了の時刻が指定されていません' });
      }
      var start = parseYmdHm(body.date, body.startTime);
      var end = parseYmdHm(body.date, body.endTime);
      if (!(end > start)) return json({ ok: false, error: '終了時刻は開始時刻より後にしてください' });
      ev = cal.createEvent(fullTitle, start, end, { location: body.location || '' });
    }

    return json({ ok: true, id: ev.getId() });

  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
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
      member: member,
      title: clean,
      allDay: allDay,
      start: start,
      end: end,
      location: ev.getLocation() || ''
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
