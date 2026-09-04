/* 家族ボード Service Worker
   ※ ファイルを更新したら必ず VER を上げること（キャッシュが切り替わらないため） */
const VER = 'v14';
const PREFIX = 'family-board-';
const CACHE = PREFIX + VER;

const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  // cache:'reload' で必ずネットワークから取り直す（ブラウザのHTTPキャッシュを無視）
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .catch(() => caches.open(CACHE).then((c) => c.addAll(ASSETS)))   // 古い環境向けの保険
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        // 同じオリジンに置いた他アプリ（ヘリナビ等）のキャッシュを消さないよう、
        // 自分のプレフィックスが付いたものだけを掃除する
        keys.filter((k) => k.indexOf(PREFIX) === 0 && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // カレンダーのデータ取得は絶対にキャッシュしない
  if (url.hostname.indexOf('script.google') >= 0 || url.hostname.indexOf('googleusercontent') >= 0) {
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // アプリ本体は network-first。
  // cache:'no-cache' でサーバに必ず問い合わせる（304なら軽い）。
  // これがないと GitHub Pages の max-age=600 のせいで、
  // sw.js の VER を上げても最大10分ほど古いファイルが表示され続ける。
  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
