# 家族ボード / family-board — 作業メモ

家族5人の予定を人ごとの縦レーンで常時表示するPWA。
古いiPhone → HDMI → モバイルモニターにミラーリングして壁掛け表示する用途。

## 前提・制約

- **TimeTreeからのデータ取得は不可能**。Connect App（API）は2023-12-22終了、
  外部カレンダー連携は「取り込む」一方通行で書き出し機能がない。
  → Googleカレンダーを正のデータ元とし、TimeTreeは表示側に回す構成に決定（ユーザー合意済み）。
- 表示端末は **iPhone 8〜11世代 / iOS 15〜16 想定**。
  `:has()` / container query / CSS nesting / `color-mix()` は **使わないこと**。
  JSも ES2020 相当（`structuredClone` `Array.at` `findLast` 不使用）。
- サイズはすべて `vh` 基準。ミラーリングで拡大されても比率が崩れないため。
  px固定はしない。

## 構成

```
Googleカレンダー → gas/Code.gs（Apps Script Web App, JSON） → app.js（fetch）
```

- **GASのURLはリポジトリに書かない。** 端末の localStorage（`fb.cfg`）にのみ保存する。
  公開リポジトリでも予定が漏れないようにするための設計判断。
- 予定の担当判定の優先順位：タイトルの目印タグ > 予定の色 > カレンダー > `shared`（みんな）
- メンバーの `key`（`father` `mother` `son1` `son2` `daughter` `shared`）は
  `app.js` の `MEMBERS` と `gas/Code.gs` の `CONFIG.members` で **必ず一致** させる。

## 更新時の手順

1. ファイルを編集
2. **`sw.js` の `VER` をインクリメント**（しないとキャッシュが切り替わらない）
3. ローカル確認：Claude Code の preview で `family-board`（http://localhost:8766）
4. 実機相当の確認は 812×375（iPhone横）と 1624×750（モニター相当）の両方で見る

## 動作確認のしかた

- ⚙ の取得URLを空にすると `demoEvents()` のサンプルが出る
- `sample-data.json` はGASが返すJSONの形式サンプル。
  ⚙ に `http://localhost:8766/sample-data.json` を入れれば取得経路のテストになる

## 天気

- Open-Meteo（APIキー不要・CORS対応・無料）。予報と、地名→座標のジオコーディングの2本立て。
- **ジオコーディングは候補を必ず選ばせること。** 先頭を自動採用すると事故る
  （「松本」の第1候補は長野県ではなく沖縄県、「横浜」は青森県が先に出る）。
- 地点はリポジトリに持たず localStorage（`fb.cfg.place`）にだけ保存する。

## 色の決め方

現行は 父=#FF6E40(朱) 母=#FF7AA8(桃) 長男=#4FA3FF(青) 次男=#4ED9A4(緑) 長女=#FFD84D(黄) みんな=#8FA0B5(灰)。
ユーザー指定は「長男=青・次男=緑・長女=黄・母は据え置き・父は紫以外で被らない色」。
父にシアンやオレンジを使わなかったのは、遠目で青・黄と混同するため。

## Service Worker の注意（ハマりどころ）

- キャッシュ削除は **`family-board-` プレフィックスのものだけ**。
  Cache Storage はオリジン単位で共有されるので、同じ `yasuokun-pro.github.io` にある
  ヘリナビの `hnav-tiles`（オフライン地図タイル）を消してしまう。
- 逆方向は未対応。ヘリナビ側 `sw.js` も同様のプレフィックスガードが必要
  （ユーザー未承認のため未着手）。
- 取得は `fetch(url, {cache:'no-cache'})`。これがないと GitHub Pages の
  `max-age=600` により、VERを上げても最大10分間古いファイルが出続ける。

## 未着手・検討中

- ヘリナビ側 sw.js のプレフィックスガード（要ユーザー承認・VER上げと再デプロイが必要）
- ゴミ出しなどの定型予定の扱い
