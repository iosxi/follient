/**
 * follient - スクリーンショットによる代替サムネイル
 *
 * OGP 画像を持たないページのために、実際にページを開いて見た目を撮る。
 * 拡張機能からヘッドレスブラウザは起動できないので、利用者のウィンドウに
 * 隠しタブを 1 枚だけ作り、そこへ順に読み込んで tabs.captureTab() で撮る。
 * 新しいウィンドウは作らない (作ると一瞬表示されフォーカスを奪うため)。
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
   * 撮影時の拡大率。
   *
   * 3〜4K のウィンドウだとビューポートが 3000 CSS px 近くになり、そのまま
   * 縮小するとカード上では 0.2 倍ほどになって何のサイトか分からなくなる。
   * 拡大してからビューポートの一部だけを切り出すことで、ウィンドウの
   * 大きさに関係なく同じ読みやすさになる。
   *
   * ズームは Firefox ではオリジン単位でしか設定できない (scope:'per-tab' は
   * 受け付けられない)。放置すると利用者が普段そのサイトを見るときの拡大率まで
   * 変わってしまうので、撮影後に必ず既定へ戻すこと。
   */
  const CAPTURE_ZOOM = 1.75;

  /** 切り出すビューポートの大きさ (CSS ピクセル)。カード向けに横長すぎない比率にする。 */
  const CAPTURE_WIDTH = 1100;
  const CAPTURE_HEIGHT = 690;

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

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * 読み込み完了を待つ。
   * 必ず navigate の「前」に呼んでリスナーを張ること。後から張ると、
   * 直前のページの complete を拾って早すぎる撮影になる。
   */
  function waitForComplete(tabId) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (how) => {
        if (done) return;
        done = true;
        browser.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
        resolve(how);
      };
      const onUpdated = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') finish('complete');
      };
      const timer = setTimeout(() => finish('timeout'), LOAD_TIMEOUT_MS);
      browser.tabs.onUpdated.addListener(onUpdated);
    });
  }

  /* ------------------------------------------------------------------ *
   * 作業用タブ
   *
   * ウィンドウは作らない。利用者のウィンドウに非アクティブなタブを 1 枚だけ
   * 作り、tabs.hide() でタブ一覧からも消して、それを使い回す。
   *
   * ウィンドウを作ると、Windows では生成時のアクティブ化を拡張機能から
   * 抑止できない。focused:false も state:'minimized' も、一瞬の表示と
   * フォーカス移動を防げなかった (入力中のキーを持っていかれる)。
   * タブなら新しいウィンドウが生まれないので、この問題自体が起きない。
   * ------------------------------------------------------------------ */

  let workerTabId = null;

  async function getWorkerTab() {
    if (workerTabId !== null) {
      try {
        await browser.tabs.get(workerTabId);
        return workerTabId;
      } catch (e) {
        workerTabId = null; // 利用者に閉じられた等
      }
    }

    const windows = await browser.windows.getAll({ windowTypes: ['normal'] });
    if (windows.length === 0) throw new Error('no browser window to host the capture tab');

    // about:blank で作ってから目的の URL へ移動する。こうすると
    // 新規作成と使い回しで待ち方が同じになり、取りこぼしが無い。
    const tab = await browser.tabs.create({ url: 'about:blank', active: false });
    workerTabId = tab.id;

    if (browser.tabs.hide) {
      try {
        await browser.tabs.hide(workerTabId);
      } catch (e) {
        // tabHide 権限が無い場合。タブ一覧には残るが撮影自体は行える。
        console.warn('follient: タブを隠せませんでした', e && e.message ? e.message : e);
      }
    }
    return workerTabId;
  }

  /** 待ち行列が空になったら片付ける。隠しタブを残したままにしない。 */
  async function releaseWorkerTab() {
    if (workerTabId === null) return;
    const id = workerTabId;
    workerTabId = null;
    await browser.tabs.remove(id).catch(() => {});
  }

  /**
   * 切り出す範囲を決める。ビューポートより大きく要求すると破綻するので、
   * 実寸を測って収める。測れない場合は範囲指定なしで撮る。
   */
  async function viewportRect(tabId) {
    try {
      const result = await browser.tabs.executeScript(tabId, {
        code: 'JSON.stringify([window.innerWidth, window.innerHeight])',
      });
      const size = JSON.parse(result[0]);
      const width = Math.min(CAPTURE_WIDTH, size[0]);
      const height = Math.min(CAPTURE_HEIGHT, size[1]);
      if (!(width > 0) || !(height > 0)) return null;
      return { x: 0, y: 0, width, height };
    } catch (e) {
      return null;
    }
  }

  /**
   * 撮影前のズーム状態を控える。
   *
   * Firefox はサイト (オリジン) ごとの拡大率を永続保存している。利用者が
   * そのサイトに設定していた値を壊さないよう、撮影前の値を必ず控えて戻す。
   * 既定のままだったのか明示設定だったのかは getZoom だけでは分からないので、
   * getZoomSettings の defaultZoomFactor と比べて判断する。
   */
  async function readZoomState(tabId) {
    try {
      const factor = await browser.tabs.getZoom(tabId);
      let fallback = null;
      try {
        const settings = await browser.tabs.getZoomSettings(tabId);
        fallback = settings && settings.defaultZoomFactor;
      } catch (e) {
        /* 既定値が取れなくても、控えた値そのものは戻せる */
      }
      return { factor, fallback };
    } catch (e) {
      return null;
    }
  }

  /** 控えておいたズーム状態へ戻す。 */
  async function restoreZoom(tabId, state) {
    if (!state) return;
    // 既定のままだった場合は 0 (既定に戻す) を渡し、明示設定を作らない。
    const wasDefault =
      state.fallback != null && Math.abs(state.factor - state.fallback) < 0.001;
    try {
      await browser.tabs.setZoom(tabId, wasDefault ? 0 : state.factor);
    } catch (e) {
      await browser.tabs.setZoom(tabId, state.factor).catch(() => {});
    }
  }

  async function captureUrl(url) {
    const tabId = await getWorkerTab();
    let zoomState = null;
    try {
      const loaded = waitForComplete(tabId); // navigate より先に張る
      await browser.tabs.update(tabId, { url });
      await loaded;

      // 触る前の拡大率を控える。これを読めなかった場合は拡大もしない。
      zoomState = await readZoomState(tabId);
      if (zoomState) {
        await browser.tabs.setZoom(tabId, CAPTURE_ZOOM).catch(() => {});
      }
      await sleep(SETTLE_MS);

      const rect = await viewportRect(tabId);
      const options = { format: 'png' };
      if (rect) {
        options.rect = rect;
        options.scale = 1;
      }

      const raw = await browser.tabs.captureTab(tabId, options);
      return await postProcess(raw);
    } finally {
      // 利用者がそのサイトに設定していた拡大率を必ず元へ戻す
      await restoreZoom(tabId, zoomState);
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
      releaseWorkerTab();
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
