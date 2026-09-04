// Variables used by Scriptable.
// icon-color: deep-gray; icon-glyph: calendar-alt;

/* =====================================================================
 *  家族ボード ウィジェット（Scriptable用）
 *
 *  家族ボードPWAと同じ Google Apps Script の JSON を取得して、
 *  今日の予定を人ごとに色分けしてホーム画面ウィジェットに表示する。
 *
 *  【使い方】
 *   1. Scriptable アプリでこのスクリプトを新規作成し、中身を全部貼り付ける
 *   2. スクリプト一覧からこの項目を「タップして実行」する（ウィジェットとしてではなく）
 *      → 初回は取得URLの入力を求められるので、家族ボードの⚙と同じURLを貼る
 *      → 保存すると、その場でウィジェットのプレビューが出る
 *   3. ホーム画面を編集 →「+」→ Scriptable を探す → サイズを選んで追加
 *   4. 追加したウィジェットをタップ →「スクリプトを選択」でこのスクリプトを選ぶ
 *
 *  設定を変更したいとき（URLを変える等）は、Scriptable アプリからこの
 *  スクリプトを「タップして実行」すると、いつでも再設定できる。
 *
 *  ※ iOSの仕様で、ウィジェットの更新は数十分に一度程度（正確なタイミングは
 *    iOS側が決める）。壁掛けボードのようにリアルタイムには更新されない。
 * =====================================================================
 */

// ---- 家族ボード本体(app.js)と同じメンバー定義。名前を変えたらここも変える ----
const MEMBERS = [
  { key: "father",   label: "父",     color: "#8FA0B5" },
  { key: "mother",   label: "母",     color: "#FF7AA8" },
  { key: "son1",     label: "長男",   color: "#4FA3FF" },
  { key: "son2",     label: "次男",   color: "#4ED9A4" },
  { key: "daughter", label: "長女",   color: "#FFD84D" },
  { key: "shared",   label: "みんな", color: "#B98BFF" }
];

// 家族ボードの公開URL。ウィジェットをタップしたときに開く先。
// ホーム画面に追加した「アプリ版」とSafariで開いたタブは端末上では
// 別々のストレージを持つため、タップ時はURLに ?endpoint=... を付けて渡し、
// Safari側が真っさらでもデモ表示にならず本番データが出るようにしている。
const BOARD_URL = "https://yasuokun-pro.github.io/family-board/";

const KC_ENDPOINT = "familyBoardEndpoint";
const KC_CACHE = "familyBoardCache";

const COL_BG = new Color("#0B0F14");
const COL_TEXT = new Color("#E6EDF5");
const COL_MUTED = new Color("#8093A8");
const COL_DIM = new Color("#55677D");
const COL_LINE = new Color("#1C2530");
const COL_ERR = new Color("#FF8A8A");

const DOW = ["日", "月", "火", "水", "木", "金", "土"];

// ---------------------------------------------------------------------
// 日付ユーティリティ（家族ボード本体の app.js と揃えてある）
// ---------------------------------------------------------------------
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function hhmm(d) { return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }

// "2026-09-06" のような日付だけの文字列は、ローカルの0時として解釈する。
// new Date("2026-09-06") はUTCの0時＝日本時間の朝9時になってしまうため、
// 終日予定がずれる（app.js の parseWhen と同じ理由・同じ対処）。
function parseWhen(v, allDay) {
  if (allDay && typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    var p = v.split("-");
    return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  }
  return new Date(v);
}

function memberInfo(key) {
  for (var i = 0; i < MEMBERS.length; i++) {
    if (MEMBERS[i].key === key) return MEMBERS[i];
  }
  return MEMBERS[MEMBERS.length - 1];
}

// ---------------------------------------------------------------------
// 設定（取得URL）
// ---------------------------------------------------------------------
function getEndpoint() {
  return Keychain.contains(KC_ENDPOINT) ? Keychain.get(KC_ENDPOINT) : null;
}

async function promptEndpoint(existing) {
  var a = new Alert();
  a.title = "家族ボードの設定";
  a.message = "Google Apps Script の取得URL（/exec で終わるもの）を入力してください。\n家族ボードの⚙で設定したものと同じものです。";
  a.addTextField("https://script.google.com/macros/s/xxxxx/exec", existing || "");
  a.addAction("保存");
  a.addCancelAction("キャンセル");
  var i = await a.presentAlert();
  if (i === -1) return existing;
  var v = a.textFieldValue(0).trim();
  if (v) Keychain.set(KC_ENDPOINT, v);
  return v || existing;
}

// ---------------------------------------------------------------------
// データ取得（失敗時は前回の内容を使う。家族ボード本体と同じ考え方）
// ---------------------------------------------------------------------
async function fetchEvents(url) {
  var sep = url.indexOf("?") >= 0 ? "&" : "?";
  var req = new Request(url + sep + "days=3&_=" + Date.now());
  req.timeoutInterval = 8;
  var json = await req.loadJSON();
  if (!json || json.ok === false) {
    throw new Error((json && json.error) || "不正な応答");
  }
  Keychain.set(KC_CACHE, JSON.stringify({ json: json, at: Date.now() }));
  return { json: json, stale: false };
}

function loadCache() {
  if (!Keychain.contains(KC_CACHE)) return null;
  try {
    var c = JSON.parse(Keychain.get(KC_CACHE));
    return { json: c.json, stale: true, at: c.at };
  } catch (e) {
    return null;
  }
}

async function loadData(url) {
  try {
    return await fetchEvents(url);
  } catch (e) {
    var cached = loadCache();
    if (cached) return cached;
    throw e;
  }
}

function parseEvents(rawEvents) {
  return (rawEvents || []).map(function (e) {
    return {
      member: e.member || "shared",
      title: e.title || "(無題)",
      allDay: !!e.allDay,
      start: parseWhen(e.start, e.allDay),
      end: parseWhen(e.end, e.allDay),
      location: e.location || ""
    };
  });
}

function eventsToday(events) {
  var now = new Date();
  var dayStart = startOfDay(now);
  var dayEnd = new Date(dayStart.getTime() + 86400000);
  return events
    .filter(function (e) { return e.start < dayEnd && e.end > dayStart; })
    .sort(function (a, b) {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return a.start - b.start;
    });
}

function groupByMember(events) {
  var map = {};
  for (var i = 0; i < events.length; i++) {
    var m = events[i].member;
    if (!map[m]) map[m] = [];
    map[m].push(events[i]);
  }
  return map;
}

// ---------------------------------------------------------------------
// ウィジェット組み立て
// ---------------------------------------------------------------------
function addHeader(widget, now, holiday, small) {
  var row = widget.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();

  var dateText = row.addText((now.getMonth() + 1) + "/" + now.getDate());
  dateText.font = Font.boldSystemFont(small ? 20 : 17);
  dateText.textColor = COL_TEXT;

  row.addSpacer(6);
  var dowText = row.addText("(" + DOW[now.getDay()] + ")");
  dowText.font = Font.systemFont(small ? 14 : 13);
  dowText.textColor = now.getDay() === 0 ? new Color("#E08585")
                     : now.getDay() === 6 ? new Color("#7FB6FF")
                     : COL_MUTED;
  row.addSpacer();

  if (holiday) {
    var h = row.addText(holiday);
    h.font = Font.systemFont(11);
    h.textColor = new Color("#E08585");
    h.lineLimit = 1;
  }
}

function addEventLine(stack, ev, fontSize) {
  var mem = memberInfo(ev.member);
  var row = stack.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();

  var dot = row.addText("●");
  dot.font = Font.systemFont(fontSize - 3);
  dot.textColor = new Color(mem.color);
  row.addSpacer(4);

  if (!ev.allDay) {
    var t = row.addText(hhmm(ev.start));
    t.font = Font.mediumSystemFont(fontSize - 2);
    t.textColor = COL_MUTED;
    row.addSpacer(5);
  }

  var title = row.addText(ev.title);
  title.font = Font.systemFont(fontSize);
  title.textColor = COL_TEXT;
  title.lineLimit = 1;
  row.addSpacer();
}

function addEmpty(widget, fontSize) {
  var t = widget.addText("今日の予定はありません");
  t.font = Font.systemFont(fontSize);
  t.textColor = COL_DIM;
}

function buildSmall(widget, ctx) {
  addHeader(widget, ctx.now, ctx.holiday, true);
  widget.addSpacer(8);

  if (ctx.today.length === 0) {
    addEmpty(widget, 13);
    return;
  }

  // 一番小さいサイズは「直近の予定」1件だけ大きく見せ、
  // あとは誰に予定があるかをドットだけ添える。
  var now = new Date();
  var next = ctx.today.filter(function (e) { return e.allDay || e.end > now; })[0] || ctx.today[0];
  var mem = memberInfo(next.member);

  var nameRow = widget.addStack();
  nameRow.layoutHorizontally();
  var nameText = nameRow.addText(mem.label);
  nameText.font = Font.boldSystemFont(13);
  nameText.textColor = new Color(mem.color);

  widget.addSpacer(2);
  var timeText = widget.addText(next.allDay ? "終日" : (hhmm(next.start) + " - " + hhmm(next.end)));
  timeText.font = Font.systemFont(12);
  timeText.textColor = COL_MUTED;

  widget.addSpacer(2);
  var titleText = widget.addText(next.title);
  titleText.font = Font.semiboldSystemFont(15);
  titleText.textColor = COL_TEXT;
  titleText.lineLimit = 2;

  widget.addSpacer();

  var order = MEMBERS.filter(function (m) { return ctx.byMember[m.key]; });
  if (order.length) {
    var dotRow = widget.addStack();
    dotRow.layoutHorizontally();
    for (var i = 0; i < order.length; i++) {
      var d = dotRow.addText("●");
      d.font = Font.systemFont(10);
      d.textColor = new Color(order[i].color);
      if (i < order.length - 1) dotRow.addSpacer(4);
    }
  }
}

function buildMedium(widget, ctx) {
  addHeader(widget, ctx.now, ctx.holiday, false);
  widget.addSpacer(6);

  if (ctx.today.length === 0) {
    addEmpty(widget, 13);
    return;
  }

  var order = MEMBERS.filter(function (m) { return ctx.byMember[m.key]; });
  var shown = 0;
  for (var i = 0; i < order.length && shown < 5; i++) {
    var evs = ctx.byMember[order[i].key];
    var mem = order[i];

    var row = widget.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();

    var labelStack = row.addStack();
    labelStack.layoutHorizontally();
    labelStack.size = new Size(38, 0);
    var label = labelStack.addText(mem.label);
    label.font = Font.boldSystemFont(12);
    label.textColor = new Color(mem.color);
    row.addSpacer(4);

    var first = evs[0];
    var text = (first.allDay ? "終日" : hhmm(first.start)) + " " + first.title;
    if (evs.length > 1) text += "  他" + (evs.length - 1) + "件";
    var t = row.addText(text);
    t.font = Font.systemFont(12);
    t.textColor = COL_TEXT;
    t.lineLimit = 1;
    row.addSpacer();

    shown++;
    if (i < order.length - 1 && shown < 5) widget.addSpacer(5);
  }
}

function buildLarge(widget, ctx) {
  addHeader(widget, ctx.now, ctx.holiday, false);
  widget.addSpacer(10);

  if (ctx.today.length === 0) {
    addEmpty(widget, 14);
    return;
  }

  var order = MEMBERS.filter(function (m) { return ctx.byMember[m.key]; });
  for (var i = 0; i < order.length; i++) {
    var mem = order[i];
    var evs = ctx.byMember[mem.key];

    var head = widget.addStack();
    head.layoutHorizontally();
    var h = head.addText(mem.label);
    h.font = Font.boldSystemFont(14);
    h.textColor = new Color(mem.color);
    head.addSpacer(6);
    var c = head.addText(evs.length + "件");
    c.font = Font.systemFont(11);
    c.textColor = COL_DIM;

    widget.addSpacer(3);

    var maxRows = 3;
    for (var j = 0; j < Math.min(evs.length, maxRows); j++) {
      addEventLine(widget, evs[j], 13);
      if (j < Math.min(evs.length, maxRows) - 1) widget.addSpacer(3);
    }
    if (evs.length > maxRows) {
      var more = widget.addText("+" + (evs.length - maxRows) + "件");
      more.font = Font.systemFont(11);
      more.textColor = COL_DIM;
    }

    if (i < order.length - 1) widget.addSpacer(10);
  }
}

// ---------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------
async function run() {
  var endpoint = getEndpoint();

  if (!config.runsInWidget) {
    // ウィジェットとしてではなく、Scriptableアプリから直接実行されたとき＝設定モード
    endpoint = await promptEndpoint(endpoint);
    if (!endpoint) {
      var a = new Alert();
      a.title = "未設定";
      a.message = "取得URLが設定されていません。";
      a.addAction("OK");
      await a.presentAlert();
      return;
    }
  }

  var widget = new ListWidget();
  widget.backgroundColor = COL_BG;
  widget.setPadding(14, 14, 14, 14);

  if (!endpoint) {
    var err = widget.addText("⚙ Scriptableアプリからこのスクリプトを実行して、取得URLを設定してください");
    err.font = Font.systemFont(12);
    err.textColor = COL_ERR;
    Script.setWidget(widget);
    Script.complete();
    return;
  }

  try {
    var result = await loadData(endpoint);
    var events = parseEvents(result.json.events);
    var today = eventsToday(events);
    var ctx = {
      now: new Date(),
      holiday: (result.json.holidays || {})[
        (function (d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); })(new Date())
      ],
      today: today,
      byMember: groupByMember(today)
    };

    var family = (config.widgetFamily) || "medium";
    if (family === "small") buildSmall(widget, ctx);
    else if (family === "large" || family === "extraLarge") buildLarge(widget, ctx);
    else buildMedium(widget, ctx);

    if (result.stale) {
      widget.addSpacer(6);
      var s = widget.addText("更新できず前回の内容を表示中");
      s.font = Font.systemFont(9);
      s.textColor = COL_DIM;
    }
  } catch (e) {
    var msg = widget.addText("取得できません: " + e.message);
    msg.font = Font.systemFont(11);
    msg.textColor = COL_ERR;
  }

  widget.url = BOARD_URL + "?endpoint=" + encodeURIComponent(endpoint);
  widget.refreshAfterDate = new Date(Date.now() + 20 * 60 * 1000);

  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else {
    var family2 = config.widgetFamily || "medium";
    if (family2 === "small") await widget.presentSmall();
    else if (family2 === "large") await widget.presentLarge();
    else await widget.presentMedium();
  }
  Script.complete();
}

await run();
