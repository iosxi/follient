/**
 * follient - スクリーンショットによる代替サムネイル
 *
 * OGP 画像を持たないページのために、実際にページを開いて見た目を撮る。
 * 拡張機能からヘッドレスブラウザは起動できないので、フォーカスを奪わない
 * ポップアップウィンドウでページを開き、tabs.captureTab() で撮って閉じる。
 *
 * 相手サイトに負荷や不審なアクセスと見なされないよう、撮影は必ず 1 件ずつ、
 * 全体間隔とホスト単位の間隔の両方を空けて行う。
 */

/* IIFE: 背景ページは複数スクリプトを同じグローバルスコープで読む。
   名前の衝突で他のスクリプトが丸ごと死ぬのを防ぐため閉じ込める。 */
(() => {
  /* ------------------------------------------------------------------ *
   * 調整用の定数
   * ------------------------------------------------------------------ */

  /** 撮影と撮影のあいだに必ず空ける時間 (全ホスト共通)。 */
  const GLOBAL_GAP_MS = 6000;

  /** 同一ホストを続けて撮るときに空ける時間。 */
  const HOST_GAP_MS = 90 * 1000;

  /** 上記の間隔に上乗せするゆらぎの割合。機械的な等間隔アクセスを避ける。 */
  const JITTER_RATIO = 0.4;

  /** ページを開いてから読み込み完了を待つ上限。 */
  const LOAD_TIMEOUT_MS = 20000;

  /** 読み込み完了後、描画が落ち着くまで待つ時間。 */
  const SETTLE_MS = 1800;

  /**
   * 撮影用ウィンドウは最初から最小化して開く。こうすると一度も画面に
   * 描画されないまま、中身だけを captureTab で取り出せる。
   *
   * 注意: state と width/height は同時に指定できない (windows.create が
   * 例外を投げる)。そのため大きさは Firefox の既定に任せる。撮った画像は
   * どのみち後処理で切り詰めて縮小するので支障は無い。
   *
   * 画面外へ動かす方法は使えない。Firefox はウィンドウ位置を画面内へ
   * 強制的に引き戻すため、左右上のどこへ追い出してもクランプされる。
   */
  const WINDOW_STATE = 'minimized';

  /** 保存する画像の最大幅。カード幅の 2 倍程度あれば足りる。 */
  const STORE_MAX_WIDTH = 640;
  const STORE_QUALITY = 0.72;

  /** 保存しておくスクリーンショットの上限。超えたら古いものから捨てる。 */
  const MAX_CACHED = 120;

  const OK_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日
  const FAIL_TTL_MS = 24 * 60 * 60 * 1000; // 失敗は1日で再挑戦

  const SHOT_PREFIX = 'shot:';
  const INDEX_KEY = 'shot:index';

  /* ------------------------------------------------------------------ *
   * キャッシュ
   * ------------------------------------------------------------------ */

  function shotKey(url) {
    return SHOT_PREFIX + url;
  }

  async function readShotCache(url) {
    const key = shotKey(url);
    const stored = await browser.storage.local.get(key);
    const entry = stored[key];
    if (!entry) return null;
    const ttl = entry.image ? OK_TTL_MS : FAIL_TTL_MS;
    if (Date.now() - entry.at > ttl) return null;
    return entry;
  }

  /** 保存件数が上限を超えたら、古いものから消す。 */
  async function trimCache(index) {
    if (index.length <= MAX_CACHED) return index;
    index.sort((a, b) => a.at - b.at);
    const drop = index.slice(0, index.length - MAX_CACHED);
    await browser.storage.local.remove(drop.map((e) => shotKey(e.url)));
    return index.slice(index.length - MAX_CACHED);
  }

  async function writeShotCache(url, image) {
    try {
      await browser.storage.local.set({ [shotKey(url)]: { at: Date.now(), image } });

      const stored = await browser.storage.local.get(INDEX_KEY);
      let index = Array.isArray(stored[INDEX_KEY]) ? stored[INDEX_KEY] : [];
      index = index.filter((entry) => entry.url !== url);
      if (image) index.push({ url, at: Date.now() });
      index = await trimCache(index);
      await browser.storage.local.set({ [INDEX_KEY]: index });
    } catch (e) {
      console.warn('follient: screenshot cache write failed', e);
    }
  }

  /* ------------------------------------------------------------------ *
   * 画像の後処理 (余白の切り落としと縮小)
   * ------------------------------------------------------------------ */

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('screenshot decode failed'));
      img.src = dataUrl;
    });
  }

  /**
   * 画像の縁にある単色の余白を削る。
   * 各辺について、その角の色と十分近い画素だけで構成される行/列を削っていく。
   * 削りすぎると絵が壊れるので、片側あたり 40% までに制限する。
   */
  function findContentBox(imageData, width, height) {
    const data = imageData.data;
    const TOLERANCE = 12;
    const maxTrimX = Math.floor(width * 0.4);
    const maxTrimY = Math.floor(height * 0.4);

    const at = (x, y) => {
      const i = (y * width + x) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const near = (a, b) =>
      Math.abs(a[0] - b[0]) <= TOLERANCE &&
      Math.abs(a[1] - b[1]) <= TOLERANCE &&
      Math.abs(a[2] - b[2]) <= TOLERANCE;

    const rowUniform = (y, reference) => {
      // 端まで 1px 刻みで見る必要はないので、間引いて走査する
      const step = Math.max(1, Math.floor(width / 160));
      for (let x = 0; x < width; x += step) {
        if (!near(at(x, y), reference)) return false;
      }
      return true;
    };
    const colUniform = (x, reference) => {
      const step = Math.max(1, Math.floor(height / 160));
      for (let y = 0; y < height; y += step) {
        if (!near(at(x, y), reference)) return false;
      }
      return true;
    };

    let top = 0;
    const topColor = at(0, 0);
    while (top < maxTrimY && rowUniform(top, topColor)) top += 1;

    let bottom = height - 1;
    const bottomColor = at(0, height - 1);
    while (bottom > height - 1 - maxTrimY && rowUniform(bottom, bottomColor)) bottom -= 1;

    let left = 0;
    const leftColor = at(0, top);
    while (left < maxTrimX && colUniform(left, leftColor)) left += 1;

    let right = width - 1;
    const rightColor = at(width - 1, top);
    while (right > width - 1 - maxTrimX && colUniform(right, rightColor)) right -= 1;

    if (right - left < 40 || bottom - top < 40) {
      return { x: 0, y: 0, w: width, h: height };
    }
    return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
  }

  /**
   * ほぼ単色の画像を弾く。ページが描画されないまま撮れてしまった場合や、
   * 真っ白なだけのページを、カードに出しても意味が無いので捨てる。
   */
  function looksBlank(imageData, width, height) {
    const data = imageData.data;
    const buckets = new Set();
    // 中身の薄いページを取りこぼさないよう、細かめに標本を取る
    const stepX = Math.max(1, Math.floor(width / 80));
    const stepY = Math.max(1, Math.floor(height / 80));

    for (let y = 0; y < height; y += stepY) {
      for (let x = 0; x < width; x += stepX) {
        const i = (y * width + x) * 4;
        // 24bit を 4bit x3 に落として、微妙な差は同じ色とみなす
        buckets.add(
          ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4)
        );
        // 描画されていない画面はほぼ 1〜2 色にしかならない。
        // 素っ気ないだけの実在ページを捨てないよう、閾値は低くしておく。
        if (buckets.size > 3) return false;
      }
    }
    return true;
  }

  /** 余白を削って縮小し、JPEG の data URL にして返す。 */
  async function postProcess(dataUrl) {
    const img = await loadImage(dataUrl);
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (!width || !height) throw new Error('screenshot has no size');

    const source = document.createElement('canvas');
    source.width = width;
    source.height = height;
    const sourceCtx = source.getContext('2d', { willReadFrequently: true });
    sourceCtx.drawImage(img, 0, 0);

    const full = sourceCtx.getImageData(0, 0, width, height);
    if (looksBlank(full, width, height)) throw new Error('blank screenshot');

    const box = findContentBox(full, width, height);

    const scale = Math.min(1, STORE_MAX_WIDTH / box.w);
    const outWidth = Math.max(1, Math.round(box.w * scale));
    const outHeight = Math.max(1, Math.round(box.h * scale));

    const out = document.createElement('canvas');
    out.width = outWidth;
    out.height = outHeight;
    out
      .getContext('2d')
      .drawImage(img, box.x, box.y, box.w, box.h, 0, 0, outWidth, outHeight);

    return out.toDataURL('image/jpeg', STORE_QUALITY);
  }

  /* ------------------------------------------------------------------ *
   * 撮影
   * ------------------------------------------------------------------ */

  function waitForLoad(tabId) {
    return new Promise((resolve, reject) => {
      let done = false;

      const finish = (fn, arg) => {
        if (done) return;
        done = true;
        browser.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
        fn(arg);
      };

      const onUpdated = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          finish(resolve);
        }
      };

      const timer = setTimeout(
        () => finish(reject, new Error('load timeout')),
        LOAD_TIMEOUT_MS
      );

      browser.tabs.onUpdated.addListener(onUpdated);

      // リスナー登録前に読み終わっていた場合の取りこぼしを拾う
      browser.tabs.get(tabId).then(
        (tab) => {
          if (tab && tab.status === 'complete') finish(resolve);
        },
        () => {}
      );
    });
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function captureUrl(url) {
    let windowId = null;
    try {
      const win = await browser.windows.create({
        url,
        type: 'popup',
        // 最初から最小化して開くので、一度も画面に現れない
        state: WINDOW_STATE,
        focused: false,
      });
      windowId = win.id;
      const tab = win.tabs && win.tabs[0];
      if (!tab) throw new Error('no tab in capture window');

      await waitForLoad(tab.id);
      await sleep(SETTLE_MS);

      const raw = await browser.tabs.captureTab(tab.id, { format: 'png' });
      return await postProcess(raw);
    } finally {
      if (windowId !== null) {
        browser.windows.remove(windowId).catch(() => {});
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 待ち行列
   * ------------------------------------------------------------------ */

  /** 待機中の URL。重複投入を防ぐ。 */
  const queue = [];
  const queued = new Set();

  /** ホストごとの最終撮影時刻。 */
  const lastByHost = new Map();
  let lastCaptureAt = 0;
  let running = false;

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return '';
    }
  }

  function withJitter(ms) {
    return ms * (1 + Math.random() * JITTER_RATIO);
  }

  /** いま撮ってよい仕事を選ぶ。無ければ次に空くまでの待ち時間を返す。 */
  function pickJob(now) {
    const globalReadyAt = lastCaptureAt + withJitter(GLOBAL_GAP_MS);
    if (now < globalReadyAt) return { waitMs: globalReadyAt - now };

    let soonest = Infinity;
    for (let i = 0; i < queue.length; i += 1) {
      const url = queue[i];
      const last = lastByHost.get(hostOf(url)) || 0;
      const readyAt = last + withJitter(HOST_GAP_MS);
      if (now >= readyAt) {
        queue.splice(i, 1);
        return { url };
      }
      soonest = Math.min(soonest, readyAt);
    }
    return { waitMs: Math.max(1000, soonest - now) };
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        const job = pickJob(Date.now());
        if (job.waitMs) {
          await sleep(Math.min(job.waitMs, 30000));
          continue;
        }

        const { url } = job;
        queued.delete(url);
        lastByHost.set(hostOf(url), Date.now());
        lastCaptureAt = Date.now();

        let image = null;
        try {
          image = await captureUrl(url);
        } catch (e) {
          console.warn(
            'follient: screenshot failed for ' + url,
            e && e.message ? e.message : String(e)
          );
        }

        await writeShotCache(url, image);
        if (image) {
          // 開いているニュータブに知らせる。誰も見ていなければ失敗するので握りつぶす。
          browser.runtime
            .sendMessage({ type: 'follient:screenshot-ready', url, image })
            .catch(() => {});
        }
      }
    } finally {
      running = false;
    }
  }

  function enqueue(url) {
    if (queued.has(url)) return;
    queued.add(url);
    queue.push(url);
    pump();
  }

  /* ------------------------------------------------------------------ *
   * 受け口
   * ------------------------------------------------------------------ */

  async function requestScreenshot(url) {
    if (!/^https?:\/\//i.test(url)) return { image: null };

    const cached = await readShotCache(url);
    if (cached) return { image: cached.image, cached: true };

    enqueue(url);
    return { image: null, queued: true };
  }

  browser.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'follient:screenshot') return undefined;
    return requestScreenshot(message.url);
  });
})();
