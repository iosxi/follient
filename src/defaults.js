/**
 * 設定の既定値と読み出し。
 *
 * 背景ページ (background.js) と設定画面の両方から読むため、
 * IIFE で包まずにグローバルへ置いている。名前は follient 用に区別できる
 * ものにしてあるので、他のスクリプトと衝突しない。
 */

var FOLLIENT_DEFAULTS = {
  sourceOg: true, // 1. og:image / twitter:image
  sourceImageSrc: true, // 2. link rel="image_src"
  sourceJsonLd: true, // 3. JSON-LD
  sourceFeed: true, // 4. RSS / Atom
  sourceBodyImg: true, // 5. 本文中の大きな img

  // 画像が読めなかったときのやり直し。相手が短時間の要求を絞ることが
  // あるので、既定では待ち時間を倍々に伸ばす。
  retryMax: 6, // 一巡して全部だめだったあと、やり直す回数
  retryExponential: true, // 待ち時間を 1 回ごとに倍にする
};

/** 保存されている設定を既定値で埋めて返す。 */
async function follientLoadSettings() {
  try {
    const stored = await browser.storage.local.get('settings');
    return Object.assign({}, FOLLIENT_DEFAULTS, stored.settings || {});
  } catch (e) {
    return Object.assign({}, FOLLIENT_DEFAULTS);
  }
}
