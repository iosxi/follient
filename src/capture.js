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
   * 切り出す範囲 (CSS ピクセル)。
   *
   * カード上での文字の大きさは「カード幅 ÷ 切り出した CSS 幅」で決まる。
   * 3〜4K のウィンドウではビューポートが 3000 CSS px 近くになるため、
   * 全体を撮ると 0.1 倍以下になって何のサイトか分からない。狭く切り出す。
   *
   * ズームで何とかしようとしてはいけない。レイアウト幅が変わるだけで
   * 文字の大きさには効かず (上の式に拡大率は出てこない)、そのうえ Firefox の
   * ズームはオリジン単位で永続保存されるので、利用者の設定を壊す。
   */
  const CAPTURE_WIDTH = 640;
  const CAPTURE_HEIGHT = 400;

  /** 中身を探すときに見る縦方向の範囲 (CSS ピクセル)。 */
  const CONTENT_PROBE_HEIGHT = 900;

  /**
   * 中身の左端ちょうどから切ると文字が縁で切れる。少し手前から切り出す。
   */
  const CONTENT_LEFT_MARGIN = 28;

  /** 上端を削った結果、これより横長にはしない。カード側の切り抜きを避けるため。 */
  const MAX_ASPECT = 2.2;

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
   * 上端の単色な帯だけを削る。
   *
   * 切り出す範囲は contentRect が中身に合わせて選んでいるので、四辺を削る
   * 必要はない。削りすぎると極端な横長になり、カード側の object-fit: cover が
   * 左右を切り落として文字が欠ける (example.com で "Example Domain" が
   * "Domain" になった)。そのため上端だけ、比率が崩れない範囲で削る。
   */
  function trimTop(imageData, width, height) {
    const data = imageData.data;
    const TOLERANCE = 12;
    // 横長になりすぎない範囲までしか削らない
    const minHeight = Math.ceil(width / MAX_ASPECT);
    const maxTrim = Math.max(0, height - minHeight);

    const at = (x, y) => {
      const i = (y * width + x) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const near = (a, b) =>
      Math.abs(a[0] - b[0]) <= TOLERANCE &&
      Math.abs(a[1] - b[1]) <= TOLERANCE &&
      Math.abs(a[2] - b[2]) <= TOLERANCE;

    const reference = at(0, 0);
    const step = Math.max(1, Math.floor(width / 160));
    let top = 0;
    while (top < maxTrim) {
      let uniform = true;
      for (let x = 0; x < width; x += step) {
        if (!near(at(x, top), reference)) {
          uniform = false;
          break;
        }
      }
      if (!uniform) break;
      top += 1;
    }
    return { x: 0, y: top, w: width, h: height - top };
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

    const box = trimTop(full, width, height);

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

  /** 撮影に使用中か。タブが消えたとき、自分の後始末か外部かを見分ける。 */
  let workerTabInUse = false;

  /** 一度でも安全でないことが起きたら、この起動中はもう撮影しない。 */
  let disabledReason = null;

  function disableCapturing(reason) {
    if (disabledReason) return;
    disabledReason = reason;
    queue.length = 0;
    queued.clear();
    console.warn('follient: 撮影を停止しました (' + reason + ')');
  }

  /**
   * 作業用タブが「隠されていて、選択もされていない」ことを確かめる。
   *
   * タブは利用者のウィンドウの中にあるので、他の拡張機能から見えている。
   * タブを操作する拡張機能 (コンテナー、重複タブ削除、セッション管理など) が
   * 表に出したり、選択したり、閉じたりすることがある。撮影の前後で必ず確認し、
   * 少しでも怪しければ撮影自体をやめる。利用者の画面に見知らぬページを
   * 出してしまうより、サムネイルを諦めるほうがましなため。
   */
  async function assertInvisible(tabId) {
    let tab;
    try {
      tab = await browser.tabs.get(tabId);
    } catch (e) {
      throw new Error('capture tab disappeared');
    }
    if (!tab.hidden) throw new Error('capture tab became visible');
    if (tab.active) throw new Error('capture tab became active');
    return tab;
  }

  /** 撮影のたびに 1 枚作る。使い回さないので、居座るタブが生まれない。 */
  async function openWorkerTab() {
    if (!browser.tabs.hide) throw new Error('tabs.hide unavailable');

    const windows = await browser.windows.getAll({ windowTypes: ['normal'] });
    if (windows.length === 0) throw new Error('no browser window');

    const tab = await browser.tabs.create({ url: 'about:blank', active: false });
    workerTabId = tab.id;
    workerTabInUse = true;

    // ここから先で失敗したら、作ったタブを必ず閉じてから投げる。
    // 閉じ忘れると、隠せなかったタブが利用者の画面に residue として残る。
    try {
      try {
        await browser.tabs.hide(workerTabId);
      } catch (e) {
        throw new Error('tabs.hide failed: ' + (e && e.message ? e.message : e));
      }
      // 隠せたと言われても実際に隠れているか確かめる
      await assertInvisible(workerTabId);
      return workerTabId;
    } catch (e) {
      await closeWorkerTab();
      throw e;
    }
  }

  async function closeWorkerTab() {
    const id = workerTabId;
    workerTabId = null;
    workerTabInUse = false; // これより後の onRemoved は自分の後始末
    if (id !== null) await browser.tabs.remove(id).catch(() => {});
  }

  /** 作業用タブが選択されてしまったら、直ちにやめる。 */
  browser.tabs.onActivated.addListener((info) => {
    if (workerTabId !== null && info.tabId === workerTabId) {
      disableCapturing('capture tab was activated');
      closeWorkerTab();
    }
  });

  /**
   * 撮影中のページが自分で開いたタブを閉じる。
   *
   * 隠しタブでもページの JavaScript は普通に動く。広告の多いサイトは
   * ポップアップで別のタブを開くことがあり、それは follient が作ったタブでは
   * ないので隠されておらず、選択されることもある。openerTabId が作業用タブと
   * 一致するものだけを閉じるので、利用者のタブを閉じてしまうことはない。
   */
  let openedByPage = false;

  browser.tabs.onCreated.addListener((tab) => {
    if (!workerTabInUse || workerTabId === null) return;
    if (tab.openerTabId !== workerTabId) return;
    openedByPage = true;
    console.warn('follient: 撮影中のページが開いたタブを閉じました');
    browser.tabs.remove(tab.id).catch(() => {});
  });

  /** 自分以外に閉じられたら、作り直さずにやめる。無限にタブが増えるのを防ぐ。 */
  browser.tabs.onRemoved.addListener((tabId) => {
    if (workerTabInUse && workerTabId !== null && tabId === workerTabId) {
      workerTabId = null;
      workerTabInUse = false;
      disableCapturing('capture tab was closed by something else');
    }
  });

  /**
   * 切り出す範囲を決める。
   *
   * 幅の広いウィンドウでは、中身が中央に寄せられていて左右が余白ということが
   * 多い。左上を機械的に切ると余白しか写らないので、上の方に実際に描かれて
   * いる要素の左端を調べて、そこから切り出す。
   */
  async function contentRect(tabId) {
    // ページ側で走らせる。全幅いっぱいの要素は背景や枠であって中身の
    // 目印にならないので除く。要素数の多いページで重くならないよう上限を置く。
    const code =
      '(function () {' +
      '  var W = window.innerWidth, H = window.innerHeight;' +
      '  var minX = Infinity;' +
      '  var all = document.body ? document.body.getElementsByTagName("*") : [];' +
      '  var limit = Math.min(all.length, 4000);' +
      '  for (var i = 0; i < limit; i++) {' +
      '    var r = all[i].getBoundingClientRect();' +
      '    if (r.top > ' + CONTENT_PROBE_HEIGHT + ' || r.bottom < 0) continue;' +
      '    if (r.width < 40 || r.height < 12) continue;' +
      '    if (r.width > W * 0.97) continue;' +
      '    if (r.left < 0) continue;' +
      '    if (r.left < minX) minX = r.left;' +
      '  }' +
      '  return JSON.stringify([W, H, isFinite(minX) ? minX : 0]);' +
      '})()';

    try {
      const result = await browser.tabs.executeScript(tabId, { code });
      const parsed = JSON.parse(result[0]);
      const viewWidth = parsed[0];
      const viewHeight = parsed[1];
      let left = parsed[2];

      if (!(viewWidth > 0) || !(viewHeight > 0)) return null;

      // 中身の縁で文字が切れないよう少し手前から。右にはみ出す場合は戻す。
      left = Math.max(0, left - CONTENT_LEFT_MARGIN);
      left = Math.min(left, Math.max(0, viewWidth - CAPTURE_WIDTH));

      return {
        x: Math.round(left),
        y: 0,
        width: Math.round(Math.min(CAPTURE_WIDTH, viewWidth)),
        height: Math.round(Math.min(CAPTURE_HEIGHT, viewHeight)),
      };
    } catch (e) {
      return null;
    }
  }

  async function captureUrl(url) {
    openedByPage = false;
    const tabId = await openWorkerTab();
    try {
      const loaded = waitForComplete(tabId); // navigate より先に張る
      await browser.tabs.update(tabId, { url });
      await loaded;

      // 読み込みの最中に横取りされていないか
      await assertInvisible(tabId);
      await sleep(SETTLE_MS);
      await assertInvisible(tabId);

      // ポップアップを出すサイトは、以後この URL を撮らない
      if (openedByPage) throw new Error('page opened tabs on its own');

      const rect = await contentRect(tabId);
      const options = { format: 'png' };
      if (rect) {
        options.rect = rect;
        options.scale = 1;
      }

      const raw = await browser.tabs.captureTab(tabId, options);
      return await postProcess(raw);
    } finally {
      await closeWorkerTab();
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
          const reason = e && e.message ? e.message : String(e);
          console.warn('follient: screenshot failed for ' + url, reason);

          // 作業用タブが表に出た/選択された/外から閉じられた場合は、
          // 作り直さずに撮影そのものをやめる。同じことを繰り返して
          // 利用者の画面にタブを撒き散らさないため。
          if (
            reason.indexOf('capture tab') === 0 ||
            reason.indexOf('tabs.hide') === 0
          ) {
            disableCapturing(reason);
          }
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
      // 念のため。captureUrl が自分で閉じているので通常は何もしない。
      closeWorkerTab();
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
    if (disabledReason) return { image: null, disabled: true };
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
