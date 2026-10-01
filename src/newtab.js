/**
 * follient - new tab
 *
 * ブックマークツリーを Pinterest 風のタイルで表示する。
 * - フォルダ: フォルダアイコンのカード。クリックでその中へ入る。
 * - ブックマーク: OGP のタイトルと画像のカード。
 *   画像とメタデータはカードがビューエリアに入った時点で取得する。
 */

const grid = document.getElementById('grid');
const emptyMessage = document.getElementById('empty');
const upLink = document.getElementById('up-link');
const breadcrumb = document.getElementById('breadcrumb');
const cardTemplate = document.getElementById('card-template');
const cardMenu = document.getElementById('card-menu');

/** 設定。既定値で動き出し、読めたら差し替える。 */
let settings = Object.assign({}, FOLLIENT_DEFAULTS);
follientLoadSettings().then((loaded) => {
  settings = loaded;
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    const before = settings.sortByUpdated;
    settings = Object.assign({}, FOLLIENT_DEFAULTS, changes.settings.newValue || {});
    // 並び順の設定は、設定画面で切り替えたその場で効いてほしい。
    // 入り切りどちらも描き直す。切ったときは order を外すだけでは足りず、
    // ホスト名の行に添えた日時も消さねばならないため。
    if (before !== settings.sortByUpdated) render();
  }
});

/** grid-auto-rows / gap の実測値。masonry の span 計算に使う。 */
let rowUnit = 4;
let gapUnit = 18;

/** 描画世代。非同期処理が古い画面に書き込むのを防ぐ。 */
let generation = 0;

/**
 * いま画面に出しているブックマークの範囲。ブックマークの変更が画面に
 * 関係するかを見分けるのに使う。描画の途中は null。
 * - pathIds: 開いているフォルダとその祖先 (パンくず)
 * - childIds: カードになっている子
 * - childFolderIds: 子のうちフォルダ (カードに件数を出している)
 */
let shownTree = null;

/** そのフォルダの中身の増減が、今の画面に出るか。 */
function showsChildrenOf(parentId) {
  return parentId === shownTree.folderId || shownTree.childFolderIds.has(parentId);
}

function readGridMetrics() {
  const styles = getComputedStyle(document.documentElement);
  rowUnit = parseFloat(styles.getPropertyValue('--row')) || 4;
  gapUnit = parseFloat(styles.getPropertyValue('--gap')) || 18;
}

/* ------------------------------------------------------------------ *
 * Masonry
 * ------------------------------------------------------------------ */

/**
 * カードの実高さから grid-row の span を決める。
 * row-gap は 0 で、縦の隙間はカードの margin-bottom が作っている。
 */
function layoutCard(card) {
  const height = card.getBoundingClientRect().height;
  if (!height) return;
  const span = Math.max(1, Math.ceil((height + gapUnit) / rowUnit));
  if (card.dataset.span !== String(span)) {
    card.dataset.span = String(span);
    card.style.gridRowEnd = 'span ' + span;
  }
}

/** 画像読み込みやウィンドウ幅の変化で高さが変わるたびに貼り直す。 */
const cardResizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) layoutCard(entry.target);
});

/* ------------------------------------------------------------------ *
 * 見た目のためのユーティリティ
 * ------------------------------------------------------------------ */

function hashString(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** ホスト名から安定した色を作り、画像が無いカードの面を塗る。 */
function applyFallbackColor(element, seed) {
  const hue = hashString(seed || 'follient') % 360;
  element.style.setProperty('--fb-a', 'hsl(' + hue + ' 62% 62%)');
  element.style.setProperty('--fb-b', 'hsl(' + ((hue + 32) % 360) + ' 58% 44%)');
}

function hostOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '') || parsed.protocol.replace(':', '');
  } catch (e) {
    return '';
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** フォルダのグリフ。innerHTML を避けて要素として組み立てる。 */
function createFolderIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');

  const body = document.createElementNS(SVG_NS, 'path');
  body.setAttribute(
    'd',
    'M3 7.2c0-1.1.9-2 2-2h3.6c.6 0 1.2.28 1.6.76l.9 1.12c.38.48.95.76 1.56.76H19' +
      'c1.1 0 2 .9 2 2v7.4c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V7.2z'
  );
  body.setAttribute('fill', '#ffffff');
  body.setAttribute('fill-opacity', '0.95');

  const crease = document.createElementNS(SVG_NS, 'path');
  crease.setAttribute('d', 'M3 10.5h18');
  crease.setAttribute('stroke', 'rgba(0,0,0,0.14)');
  crease.setAttribute('stroke-width', '1.2');

  svg.appendChild(body);
  svg.appendChild(crease);
  return svg;
}

/**
 * 一覧に並べる小さなフォルダ。移動先を選ぶダイアログで使う。
 *
 * createFolderIcon は色タイルの上に白で置く前提なので、紙の上では消える。
 * 形は同じまま、面の色に合わせて currentColor で描くものを別に用意する。
 */
function createFolderGlyph() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'folder-glyph');
  svg.setAttribute('aria-hidden', 'true');

  const body = document.createElementNS(SVG_NS, 'path');
  body.setAttribute(
    'd',
    'M3 7.2c0-1.1.9-2 2-2h3.6c.6 0 1.2.28 1.6.76l.9 1.12c.38.48.95.76 1.56.76H19' +
      'c1.1 0 2 .9 2 2v7.4c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V7.2z'
  );
  body.setAttribute('fill', 'currentColor');
  body.setAttribute('fill-opacity', '0.8');

  svg.appendChild(body);
  return svg;
}

/** 取得できなかったことを示す、斜線の入った画像のグリフ。 */
function createNoImageIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.9');
  svg.setAttribute('stroke-linecap', 'round');

  const frame = document.createElementNS(SVG_NS, 'rect');
  frame.setAttribute('x', '3.2');
  frame.setAttribute('y', '4.6');
  frame.setAttribute('width', '17.6');
  frame.setAttribute('height', '14.8');
  frame.setAttribute('rx', '2.4');

  const hill = document.createElementNS(SVG_NS, 'path');
  hill.setAttribute('d', 'M4 16l4.2-4.2 3.3 3.3');

  const slash = document.createElementNS(SVG_NS, 'path');
  slash.setAttribute('d', 'M3.6 20.4L20.4 3.6');

  svg.appendChild(frame);
  svg.appendChild(hill);
  svg.appendChild(slash);
  return svg;
}

/* ------------------------------------------------------------------ *
 * サムネイルの途中経過
 *
 * 取りにいっている間と、どこにも画像が無かった場合とで顔を変える。
 * 同じ頭文字タイルのままだと、待てば出るのか出ないのかが分からない。
 * ------------------------------------------------------------------ */

const THUMB_STATES = ['is-pending', 'is-nothumb'];

function setThumbState(card, state, label) {
  const box = card.querySelector('.thumb-state');
  if (!box) return;

  card.classList.remove(...THUMB_STATES);
  const icon = box.querySelector('.state-icon');
  icon.textContent = '';

  if (!state) {
    box.hidden = true;
    layoutCard(card);
    return;
  }

  card.classList.add(state);
  if (state === 'is-nothumb') icon.appendChild(createNoImageIcon());
  box.querySelector('.state-label').textContent = label;
  box.hidden = false;
  layoutCard(card);
}

/* ------------------------------------------------------------------ *
 * メタデータの遅延取得
 * ------------------------------------------------------------------ */

function requestMetadata(url, force) {
  return browser.runtime
    .sendMessage({ type: 'follient:metadata', url, force: Boolean(force) })
    .catch(() => ({ title: null, image: null }));
}

/**
 * 2xx で応答しなかったページは、画像の代わりに状態を出す。
 * 消えたブックマークがひと目で分かるほうが、白いカードより役に立つ。
 */
const STATUS_LABELS = {
  400: '不正なリクエスト',
  401: '認証が必要',
  403: 'アクセスできません',
  404: 'ページがありません',
  408: 'タイムアウト',
  410: '削除されました',
  429: 'アクセスが多すぎます',
  451: '法的理由で見られません',
  500: 'サーバーエラー',
  502: 'ゲートウェイエラー',
  503: '一時的に使えません',
  504: 'ゲートウェイタイムアウト',
};

function statusLabel(status, kind) {
  if (status === 0) return kind === 'timeout' ? '応答がありません' : '接続できません';
  if (STATUS_LABELS[status]) return STATUS_LABELS[status];
  if (status >= 500) return 'サーバーの問題';
  if (status >= 400) return 'ページの問題';
  if (status >= 300) return 'リダイレクト';
  return 'エラー';
}

function showStatusTile(card, status, kind) {
  const fallback = card.querySelector('.thumb-fallback');
  if (!fallback) return;

  setThumbState(card, null);
  card.classList.add('is-status');
  card.classList.add(status >= 500 || status === 0 ? 'status-server' : 'status-client');

  fallback.textContent = '';
  fallback.style.removeProperty('--fb-a');
  fallback.style.removeProperty('--fb-b');

  const code = document.createElement('span');
  code.className = 'status-code';
  code.textContent = status === 0 ? '×' : String(status);


  const label = document.createElement('span');
  label.className = 'status-label';
  label.textContent = statusLabel(status, kind);

  fallback.appendChild(code);
  fallback.appendChild(label);
  layoutCard(card);
}

/** 状態タイルで潰した代替面を、頭文字と色の姿に戻す。 */
function restoreFallback(card) {
  const fallback = card.querySelector('.thumb-fallback');
  if (!fallback) return;
  card.classList.remove('is-status', 'status-client', 'status-server');
  const host = card.dataset.host || '';
  fallback.textContent = '';
  applyFallbackColor(fallback, host || card.dataset.url);
  fallback.textContent = (host || '?').charAt(0).toUpperCase();
}

/** ビューエリアに入ったカードだけ OGP を取りにいく。 */
const viewportObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      viewportObserver.unobserve(entry.target);
      hydrateCard(entry.target);
    }
  },
  { rootMargin: '200px 0px' }
);

/** 背景から返った結果を、試す順に並んだ URL の配列にする。 */
function imageListOf(data) {
  if (!data) return [];
  if (Array.isArray(data.images) && data.images.length) {
    return data.images.map((candidate) => candidate.url);
  }
  return data.image ? [data.image] : [];
}

/**
 * @param {boolean} [force] キャッシュの有効期間を無視して取り直す。
 */
async function hydrateCard(card, force) {
  const url = card.dataset.url;
  const myGeneration = generation;

  setThumbState(card, 'is-pending', '取得中');

  const data = await requestMetadata(url, force);
  if (myGeneration !== generation || !card.isConnected) return;

  // ブックマークに利用者自身が付けた名前があればそれを尊重し、
  // 既定のまま (= URL そのもの等) の場合だけ OG タイトルで補う。
  if (data && data.title && card.dataset.useOgTitle === 'true') {
    card.querySelector('.title').textContent = data.title;
    card.querySelector('.link-label').textContent = data.title;
    card.title = data.title + '\n' + url;
  }

  // 設定で切ったら、その場で消えてほしい。キャッシュに残っている話数を
  // 出さないよう、ここでも見る。
  renderChapters(card, settings.showChapters ? data && data.chapters : null);

  // 取得のついでに更新日時も返ってくる。対象のカードだけ反映する。
  if (
    settings.sortByUpdated &&
    card.dataset.sortable === 'true' &&
    setUpdatedAt(card, data && data.updatedAt)
  ) {
    requestSort();
  }

  // 相手がはっきり 4xx / 5xx を返したときだけ、手元の絵より状態を優先する。
  // 消えたブックマークだと分かるほうが、昔の絵が出続けるより役に立つため。
  // 逆に httpStatus 0 (応答なし・接続不可) では優先しない。回線が一瞬
  // 途切れただけで、苦労して取れた絵が隠れてしまうから。
  const refused = data && typeof data.httpStatus === 'number' && data.httpStatus >= 400;

  // 一度読めた絵は手元にある。相手の機嫌に左右されず、網にも出ない。
  if (!force && !refused) {
    const stored = await requestStoredThumb(url);
    if (myGeneration !== generation || !card.isConnected) return;
    if (stored && stored.image) {
      showImage(card, [stored.image]);
      return;
    }
  }

  // 2xx で返らなかったページは、番号と意味を出して終わる。
  if (data && typeof data.httpStatus === 'number') {
    showStatusTile(card, data.httpStatus, data.netKind);
    return;
  }

  const candidates = imageListOf(data);
  if (candidates.length) {
    showImage(card, candidates);
    return;
  }

  // 取り出せる画像がどこにも無かった。ここが行き止まりなので、
  // 待たせずにそう出す。
  setThumbState(card, 'is-nothumb', 'サムネイルなし');
}

/**
 * やり直しの基準時間。実際の待ち時間はここから設定に従って伸ばす。
 *
 * rawkuma.net の画像は Cloudflare のエッジにある間だけ 200 で返り、
 * エッジから落ちるとオリジンに無いので 404 になる。実測で 8 本中 2 本しか
 * 通らなかった。1 回の失敗で諦めると、生きている絵を捨ててしまう。
 */
const IMAGE_RETRY_BASE_MS = 1200;

/** 待ち時間の上限。倍々に伸ばしても、これ以上は待たせない。 */
const IMAGE_RETRY_MAX_WAIT_MS = 60000;

/**
 * 何回目のやり直しを、どれだけ待ってから始めるか。
 *
 * 500 件のフォルダで 30 件ほどが落ちた。短い間隔で叩き直すと、相手の
 * 制限にかかって逆効果になる。既定では 1 回ごとに倍にして間を空ける。
 * 同じ瞬間に何百枚も動かないよう、最後に乱数でばらす。
 */
function retryWaitMs(round) {
  const step = settings.retryExponential ? Math.pow(2, round - 1) : round;
  // ばらしたあとで上限をかける。上限が実際の待ち時間の上限になるように。
  const wait = IMAGE_RETRY_BASE_MS * step * (1 + Math.random());
  return Math.min(wait, IMAGE_RETRY_MAX_WAIT_MS);
}

/** 設定は文字列で入っていることがある。数として使える形に均す。 */
function retryRounds() {
  const value = parseInt(settings.retryMax, 10);
  return Number.isFinite(value) && value >= 0 ? value : FOLLIENT_DEFAULTS.retryMax;
}

/**
 * 一度に置く話数。残りは箱を下へ送ったときに継ぎ足す。
 *
 * 全話を最初から <a> にしてはいけない。カードは画面に入ると二度と消えない
 * ので、500 件のフォルダを一巡すると置いた <a> がそのまま積み上がる。
 * 1 作 300 話なら 15 万本になり、:visited はその 1 本ずつが履歴への
 * 問い合わせになる。見えているのは 3 行だけなのだから、その場で要るぶんだけ
 * 置けばよい。
 */
const CHAPTER_CHUNK = 24;

/** 箱の底から何 px 手前で継ぎ足すか。行の高さ 3 つ分ほど。 */
const CHAPTER_REACH_PX = 60;

/** 箱ごとの「まだ置いていない話数」。作り直すたびに置き換わる。 */
const chapterRest = new WeakMap();

/** 続きを 1 かたまり分だけ置く。もう無ければ何もしない。 */
function appendChapters(box) {
  const rest = chapterRest.get(box);
  if (!rest || rest.at >= rest.list.length) return;

  const until = Math.min(rest.at + CHAPTER_CHUNK, rest.list.length);
  const batch = document.createDocumentFragment();
  for (let i = rest.at; i < until; i += 1) {
    const chapter = rest.list[i];
    const link = document.createElement('a');
    link.href = chapter.url;
    link.textContent = chapter.label;
    link.title = chapter.url;
    batch.appendChild(link);
  }
  rest.at = until;
  box.appendChild(batch);
  syncChapterBar(box);
}

/** つまみをこれ以上短くしない丈。500 話あっても摘める大きさを残す。 */
const CHAPTER_THUMB_MIN_PX = 18;

/**
 * 送り箱の棒を描き直す。
 *
 * 土台の棒は使えない。Windows 11 の Firefox は重ね置きで、触っている間しか
 * 出てこない。scrollbar-color は色を塗り替えるだけで、出しっぱなしにはできない
 * (OS の「スクロールバーを常に表示する」に従う)。そこで自分で描いている。
 *
 * 丈も位置も px で出す。scrollHeight に対する割合を % で渡す手もあるが、
 * 500 話ある箱ではつまみが 1px を切って摘めなくなる。最低の丈を決めるなら
 * px で計るしかない。位置は transform で動かす (レイアウトが起きない)。
 */
function syncChapterBar(box) {
  const wrap = box.parentElement;
  const thumb = wrap && wrap.querySelector('.chapter-thumb');
  if (!thumb) return;

  const view = box.clientHeight;
  const total = box.scrollHeight;
  if (!view || !total) return;

  const height = Math.max(CHAPTER_THUMB_MIN_PX, Math.round((view / total) * view));
  const room = Math.max(0, view - height);
  const scrolled = Math.max(0, total - view);
  const top = scrolled > 0 ? Math.round((box.scrollTop / scrolled) * room) : 0;

  thumb.style.height = height + 'px';
  thumb.style.transform = 'translateY(' + top + 'px)';
}

/**
 * つまみを掴めるようにする。溝を押したときは、そこへ飛ばす。
 *
 * 箱 1 つにつき 1 回だけ呼ぶ。カードは使い回されるので、話数を並べ直すたびに
 * 付け直す必要はない。
 */
function bindChapterBar(box) {
  const wrap = box.parentElement;
  const bar = wrap.querySelector('.chapter-bar');
  const thumb = wrap.querySelector('.chapter-thumb');
  if (!bar || !thumb) return;

  /** つまみの上端から何 px のところを掴んだか。 */
  let grabAt = 0;

  const moveTo = (clientY) => {
    const view = box.clientHeight;
    const room = view - thumb.offsetHeight;
    if (room <= 0) return;
    const top = clientY - bar.getBoundingClientRect().top - grabAt;
    const ratio = Math.min(1, Math.max(0, top / room));
    box.scrollTop = ratio * (box.scrollHeight - view);
  };

  bar.addEventListener('pointerdown', (event) => {
    // 溝を押したときは、つまみの真ん中がそこへ来るように飛ばす
    grabAt =
      event.target === thumb
        ? event.clientY - thumb.getBoundingClientRect().top
        : thumb.offsetHeight / 2;
    bar.setPointerCapture(event.pointerId);
    moveTo(event.clientY);
    // カードに重ねたリンクへ渡さない。掴んだつもりでページが開いてしまう。
    event.preventDefault();
  });

  bar.addEventListener('pointermove', (event) => {
    if (bar.hasPointerCapture(event.pointerId)) moveTo(event.clientY);
  });

  bar.addEventListener('pointerup', (event) => {
    bar.releasePointerCapture(event.pointerId);
  });
}

/**
 * 話数を並べる (rawkuma 専用)。
 *
 * どこまで読んだかは、本物の <a> を置いて CSS の :visited に任せる。
 * 訪問済みかどうかは JavaScript から読めない (履歴詐取の対策で塞がれて
 * いる) ので、follient 自身は既読の数も日付も知らない。色が変わるのを
 * 利用者が見るだけ、というのがこの仕組みの限界。
 *
 * 新しい話が上に来る。箱は 3 行分しか高さが無いので (CSS)、最新の 3 話は
 * 送らずに見え、それより前は箱の中を下へ送って辿る。
 */
function renderChapters(card, chapters) {
  const box = card.querySelector('.chapters');
  if (!box) return;
  const wrap = box.parentElement;

  box.textContent = '';
  box.scrollTop = 0;
  chapterRest.delete(box);
  if (!Array.isArray(chapters) || chapters.length === 0) {
    // 話数が無いカードでは棒も出さない。包みごと消す。
    wrap.hidden = true;
    return;
  }

  wrap.hidden = false;
  chapterRest.set(box, { list: chapters, at: 0 });
  appendChapters(box);

  // 箱は使い回されるので、聞き役は 1 つで足りる。中身は WeakMap から引く。
  if (box.dataset.moreBound !== 'true') {
    box.dataset.moreBound = 'true';
    bindChapterBar(box);
    box.addEventListener('scroll', () => {
      const left = box.scrollHeight - box.scrollTop - box.clientHeight;
      if (left <= CHAPTER_REACH_PX) appendChapters(box);
      syncChapterBar(box);
    });
  }
}

/** 手元に持っているサムネイルを聞く。あれば網に出ずに済む。 */
function requestStoredThumb(url) {
  return browser.runtime
    .sendMessage({ type: 'follient:thumb-get', url })
    .catch(() => null);
}

/** 読めた絵を手元に残すよう頼む。完了は待たない。 */
function saveThumb(pageUrl, imageUrl) {
  browser.runtime
    .sendMessage({ type: 'follient:thumb-save', url: pageUrl, image: imageUrl })
    .catch(() => {});
}

/** 読めた URL を背景に教える。次からはそれが先頭になる。 */
function reportWorkingImage(pageUrl, imageUrl) {
  browser.runtime
    .sendMessage({ type: 'follient:image-ok', url: pageUrl, image: imageUrl })
    .catch(() => {});
}

/**
 * 候補を順に試す。
 *
 * 取り出せたことと、実際に読めることは別。rawkuma.net は JSON-LD が 404 の
 * ファイルを指していて、本文の img には生きた画像があるのに諦めていた。
 * 最初の 1 件で決め打たず、全部だめだったときに初めて「サムネイルなし」にする。
 *
 * 一巡して全部だめでも、そこでは諦めない。相手が同じ URL に 404 を返したり
 * 返さなかったりすることがあるため (DEVELOPMENT.md「同じ URL が 404 に
 * なったりならなかったりする」)。間を空けて数回やり直す。
 */
function showImage(card, sources) {
  const list = (Array.isArray(sources) ? sources : [sources]).filter(Boolean);
  const img = card.querySelector('.thumb-img');
  const thumb = card.querySelector('.thumb');
  let index = 0;
  let round = 0;

  const attempt = () => {
    if (index >= list.length) {
      if (round >= retryRounds()) {
        // 場所は分かったのに、どれも読めなかった (消えている、外部には
        // 配信しない等)。黙って代替面へ戻すと伝わらないので明示する。
        img.removeAttribute('src');
        setThumbState(card, 'is-nothumb', 'サムネイルなし');
        return;
      }
      round += 1;
      index = 0;
      const wait = retryWaitMs(round);
      setTimeout(() => {
        if (card.isConnected) attempt();
      }, wait);
      return;
    }

    const src = list[index];
    index += 1;

    // once の付いたリスナーは、発火しない限り残って積み上がる。
    // 何度も試すのでプロパティに入れて、そのつど上書きする。
    img.onload = () => {
      img.onload = null;
      img.onerror = null;
      if (!card.isConnected) return;
      const ratio = img.naturalWidth / img.naturalHeight;
      if (ratio > 0 && Number.isFinite(ratio)) {
        // 極端に細長い画像でタイルが破綻しないように制限する
        thumb.style.aspectRatio = String(Math.min(2.4, Math.max(0.62, ratio)));
      }
      img.classList.add('loaded');
      setThumbState(card, null);
      // 先頭が死んでいた。次に開くときは、これを先に試させる
      if (index > 1) reportWorkingImage(card.dataset.url, src);
      // 網から読めた絵は手元に残す。次からは取り直さない。
      if (/^https?:/i.test(src)) saveThumb(card.dataset.url, src);
    };

    img.onerror = () => {
      img.onload = null;
      img.onerror = null;
      if (!card.isConnected) return;
      attempt();
    };

    if (img.getAttribute('src') === src) img.removeAttribute('src');
    img.src = src;
  };

  attempt();
}

/** 「サムネイル更新」から呼ぶ。いまの絵を捨てて、はじめから取り直す。 */
async function refreshThumbnail(card) {
  const img = card.querySelector('.thumb-img');
  if (img) {
    img.classList.remove('loaded');
    img.removeAttribute('src');
  }
  const thumb = card.querySelector('.thumb');
  if (thumb) thumb.style.removeProperty('aspect-ratio');

  restoreFallback(card);
  await hydrateCard(card, true);
}

/* ------------------------------------------------------------------ *
 * カードのメニュー
 * ------------------------------------------------------------------ */

/** いまメニューを開いているカード。閉じているときは null。 */
let menuCard = null;

function closeMenu() {
  if (menuCard) {
    const button = menuCard.querySelector('.menu-button');
    if (button) button.setAttribute('aria-expanded', 'false');
    menuCard = null;
  }
  /*
   * menuCard が無いときも必ず空にする。以前はここで戻っていたため、
   * 何かの弾みで menuCard だけ先に外れると、古い項目が DOM に居残った。
   * そこへ openMenu が足すと同じ項目が二重に並び、1 回押しただけで
   * 移動が 2 つ走って互いを打ち消す。
   */
  cardMenu.hidden = true;
  cardMenu.textContent = '';
}

/**
 * @param {boolean} [danger] 取り消しの利かない操作。色を変えて区別する。
 */
function addMenuItem(label, onChoose, danger) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = danger ? 'menu-item is-danger' : 'menu-item';
  item.setAttribute('role', 'menuitem');
  item.textContent = label;
  item.addEventListener('click', () => {
    closeMenu();
    onChoose();
  });
  cardMenu.appendChild(item);
}

/** 押し間違えると困る操作を、そうでない操作から線で離す。 */
function addMenuSeparator() {
  const line = document.createElement('div');
  line.className = 'menu-separator';
  line.setAttribute('role', 'separator');
  cardMenu.appendChild(line);
}

/** ボタンの下に出す。下に入らなければ上へ、右に溢れれば左へ寄せる。 */
function placeMenu(button) {
  const anchor = button.getBoundingClientRect();
  const size = cardMenu.getBoundingClientRect();
  const margin = 8;

  let left = anchor.right - size.width;
  left = Math.min(left, window.innerWidth - size.width - margin);
  left = Math.max(margin, left);

  let top = anchor.bottom + 4;
  if (top + size.height > window.innerHeight - margin) {
    top = Math.max(margin, anchor.top - size.height - 4);
  }

  cardMenu.style.left = Math.round(left) + 'px';
  cardMenu.style.top = Math.round(top) + 'px';
}

function openMenu(card) {
  const wasOpen = menuCard === card;
  closeMenu();
  if (wasOpen) return; // 同じボタンをもう一度押したら閉じるだけ

  // フォルダのカードには ︙ を置いていないので、ここへは来ない。
  if (card.dataset.kind === 'folder') return;

  addMenuItem('サムネイル更新', () => refreshThumbnail(card));
  addMenuItem('フォルダへ移動…', () => moveCard(card));
  addMenuSeparator();
  addMenuItem('ブックマークを削除', () => removeBookmark(card), true);

  const button = card.querySelector('.menu-button');
  menuCard = card;
  cardMenu.hidden = false;
  placeMenu(button);
  button.setAttribute('aria-expanded', 'true');

  /*
   * preventScroll は外せない。焦点を当てると土台はその要素を画面内へ
   * 送り込もうとし、それが scroll を起こす。scroll では閉じる約束に
   * してあるので、開いた直後に自分で閉じてしまう。項目が 1 つだった
   * ころは menu が短く画面に収まっていたので表に出なかった。
   */
  const first = cardMenu.querySelector('.menu-item');
  if (first) first.focus({ preventScroll: true });
}

cardMenu.addEventListener('click', (event) => event.stopPropagation());

document.addEventListener('click', closeMenu);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !menuCard) return;
  const button = menuCard.querySelector('.menu-button');
  closeMenu();
  if (button) button.focus();
});
// 開いたまま画面が動くとボタンから離れてしまうので、その場で閉じる
window.addEventListener('scroll', closeMenu, true);
window.addEventListener('resize', closeMenu);

/* ------------------------------------------------------------------ *
 * 知らせ (トースト)
 *
 * 移動も削除もカードが目の前から消える操作で、画面を見ているだけでは
 * 「何がどこへ行ったのか」が分からない。何をしたかを文で残し、そのまま
 * 取り消せるようにする。
 * ------------------------------------------------------------------ */

const toastTray = document.getElementById('toast-tray');

/** 知らせを出しておく長さ。「元に戻す」を押す間を取る。 */
const TOAST_MS = 9000;

let toastTimer = 0;

function hideToast() {
  clearTimeout(toastTimer);
  toastTray.textContent = '';
}

/**
 * 画面の下に知らせを出す。前の知らせは消す。
 *
 * @param {string} text
 * @param {{label: string, onChoose: function}} [action] 「元に戻す」など。
 */
function showToast(text, action) {
  hideToast();

  const toast = document.createElement('div');
  toast.className = 'toast';

  const body = document.createElement('span');
  body.className = 'toast-text';
  body.textContent = text;
  toast.appendChild(body);

  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      hideToast();
      action.onChoose();
    });
    toast.appendChild(button);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', '閉じる');
  close.textContent = '✕';
  close.addEventListener('click', hideToast);
  toast.appendChild(close);

  toastTray.appendChild(toast);
  toastTimer = setTimeout(hideToast, TOAST_MS);
}

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

/**
 * 知らせに出す名前。画面に出ているものと同じにする。
 * ブックマーク名が URL のときは OG タイトルを出しているので、
 * node.title をそのまま使うと見えているものと食い違う。
 */
function cardLabel(card) {
  const title = card.querySelector('.title');
  const text = ((title && title.textContent) || '').trim();
  const name = text || card.dataset.url || 'このブックマーク';
  return name.length > 48 ? name.slice(0, 47) + '…' : name;
}

/* ------------------------------------------------------------------ *
 * フォルダの道筋
 * ------------------------------------------------------------------ */

/** ルートの ID。render() が毎回読んでいるので、そこで控えたものを使う。 */
let rootIdCache = '';

async function bookmarksRootId() {
  if (!rootIdCache) rootIdCache = (await browser.bookmarks.getTree())[0].id;
  return rootIdCache;
}

/**
 * フォルダを「aa/bb/cc」の形で表す。区切りはパンくずに合わせる。
 * ルート自身は名前を持たないので、パンくずと同じ「ブックマーク」にする。
 */
async function folderPathLabel(folderId) {
  const rootId = await bookmarksRootId();
  const path = await buildPath(folderId);
  const names = path
    .filter((node) => node.id !== rootId)
    .map((node) => node.title || '(名称未設定)');
  return names.length ? names.join('/') : 'ブックマーク';
}

/* ------------------------------------------------------------------ *
 * よく使う移動先
 *
 * 移動が成功するたびに行き先を 1 つ数える。回数の多い順、同数なら最後に
 * 使った順。移動した実績だけを見ており、閲覧やフォルダの中身は数えない。
 * ------------------------------------------------------------------ */

const MOVE_HISTORY_KEY = 'move:recent';

/** 覚えておく行き先の数。溢れたら使われていないものから捨てる。 */
const MOVE_HISTORY_MAX = 30;

/** ダイアログの先頭に出す数。 */
const MOVE_QUICK_COUNT = 3;

async function readMoveHistory() {
  try {
    const stored = await browser.storage.local.get(MOVE_HISTORY_KEY);
    const history = stored[MOVE_HISTORY_KEY];
    return history && typeof history === 'object' ? history : {};
  } catch (e) {
    return {};
  }
}

function saveMoveHistory(history) {
  return browser.storage.local.set({ [MOVE_HISTORY_KEY]: history }).catch(() => {
    // 覚えられなくても、移動そのものは済んでいる
  });
}

/** 「よく使う」の順。回数が先、同数なら最後に使った時刻で分ける。 */
function compareMoveEntries(a, b) {
  if (b.n !== a.n) return b.n - a.n;
  return b.at - a.at;
}

/** 移動が成功したときだけ呼ぶ。ここが「よく使う」の唯一の根拠。 */
async function bumpMoveHistory(folderId) {
  const history = await readMoveHistory();
  const entry = history[folderId] || { n: 0, at: 0 };
  history[folderId] = { n: entry.n + 1, at: Date.now() };

  const ids = Object.keys(history);
  if (ids.length > MOVE_HISTORY_MAX) {
    ids.sort((a, b) => compareMoveEntries(history[a], history[b]));
    for (const id of ids.slice(MOVE_HISTORY_MAX)) delete history[id];
  }
  await saveMoveHistory(history);
}

/**
 * よく使う移動先を上から数件返す。
 *
 * 消えたフォルダは覚え書きからも落とす。放っておくと、二度と選べない
 * 名前が上位を占めたまま居座る。いまの親も外す。移しても何も起きない
 * 行き先で 3 つの枠を 1 つ潰すのは惜しい。
 */
async function topMoveTargets(excludeId, count) {
  const history = await readMoveHistory();
  const ids = Object.keys(history).sort((a, b) =>
    compareMoveEntries(history[a], history[b])
  );
  if (ids.length === 0) return [];

  // まとめて get すると 1 件でも欠けたところで全体が失敗するので 1 件ずつ
  const found = await Promise.all(
    ids.map((id) =>
      browser.bookmarks.get(id).then(
        (nodes) => nodes[0] || null,
        () => null
      )
    )
  );

  const gone = ids.filter((id, index) => !found[index]);
  if (gone.length > 0) {
    for (const id of gone) delete history[id];
    saveMoveHistory(history);
  }

  const rootId = await bookmarksRootId();
  const picked = [];
  for (let i = 0; i < found.length && picked.length < count; i += 1) {
    const node = found[i];
    if (!node || node.url) continue; // 消えた / フォルダでなくなった
    if (node.id === excludeId || node.id === rootId) continue;
    picked.push(node);
  }

  return Promise.all(
    picked.map(async (node) => ({
      id: node.id,
      title: node.title || '(名称未設定のフォルダ)',
      path: await folderPathLabel(node.id),
    }))
  );
}

/* ------------------------------------------------------------------ *
 * 移動先を選ぶ
 *
 * Google ドライブの「移動」に倣う。木を広げて全体を見せるのではなく、
 * フォルダを 1 階層ずつ**入っていく**。いま開いている場所がそのまま
 * 行き先で、下の「ここに移動」で確定する。どこへ入れるのかが常に見出しに
 * 出ているので、深いフォルダでも選び間違えにくい。
 *
 * 土台の <dialog> を showModal() で開く。覆い・フォーカスの閉じ込め・
 * Esc での取り消しが土台の実装で済み、自前で組むより取りこぼしが無い。
 * ------------------------------------------------------------------ */

const moveDialog = document.getElementById('move-dialog');
const moveSubject = document.getElementById('move-subject');
const moveQuick = document.getElementById('move-quick');
const moveQuickList = document.getElementById('move-quick-list');
const moveUpButton = document.getElementById('move-up');
const moveCurrentName = document.getElementById('move-current');
const moveList = document.getElementById('move-list');
const moveNote = document.getElementById('move-note');
const moveOkButton = document.getElementById('move-ok');
const moveCancelButton = document.getElementById('move-cancel');

/** いま開いている場所。「ここに移動」の行き先になる。 */
let moveCursor = '';
/** 動かすものの、いまの親。ここへは移せない。 */
let moveHome = '';
/** 選ばれた行き先を呼び出し側へ返す。 */
let moveResolve = null;
/** 開いた回数。閉じて開き直したあとに、古い読み出しが書き込むのを防ぐ。 */
let moveGeneration = 0;

/**
 * 移動先を選ばせる。選ばれたフォルダの ID か、やめたときは null を返す。
 * @param {object} node 動かすブックマーク (browser.bookmarks のノード)
 * @param {string} label 画面に出ている名前
 */
function chooseMoveTarget(node, label) {
  finishMove(null); // 万一開きっぱなしなら畳んでから
  moveGeneration += 1;
  moveHome = node.parentId || '';
  moveSubject.textContent = '「' + label + '」の移動先を選んでください。';

  /*
   * 中身を読む前に、行き先を空にして「ここに移動」を封じる。
   * 残しておくと、開いた直後の一瞬だけ前回の行き先を押せてしまう。
   */
  moveCursor = '';
  moveOkButton.disabled = true;
  moveQuick.hidden = true;
  moveQuickList.textContent = '';
  moveList.textContent = '';
  moveCurrentName.textContent = '';
  moveNote.hidden = true;

  const promise = new Promise((resolve) => {
    moveResolve = resolve;
  });

  if (!moveDialog.open) moveDialog.showModal();
  fillQuickTargets(moveGeneration);
  showMoveFolder(moveHome, moveGeneration);
  return promise;
}

/**
 * 選択を終える。close() が 'close' を呼び戻すが、先に moveResolve を
 * 空にしてあるので二度は解決しない。
 */
function finishMove(folderId) {
  const resolve = moveResolve;
  moveResolve = null;
  if (moveDialog.open) moveDialog.close();
  if (resolve) resolve(folderId || null);
}

/** 先頭の「よく使う移動先」。押したその場で移動する。 */
async function fillQuickTargets(myGeneration) {
  moveQuickList.textContent = '';
  moveQuick.hidden = true;

  const home = moveHome;
  const targets = await topMoveTargets(home, MOVE_QUICK_COUNT);
  if (myGeneration !== moveGeneration || !moveDialog.open) return;
  if (targets.length === 0) return;

  for (const target of targets) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'move-quick-item';
    row.appendChild(createFolderGlyph());

    const text = document.createElement('span');
    text.className = 'move-quick-text';

    const name = document.createElement('span');
    name.className = 'move-quick-name';
    name.textContent = target.title;
    text.appendChild(name);

    // 同じ名前のフォルダが複数あっても見分けられるよう道筋を添える
    const path = document.createElement('span');
    path.className = 'move-quick-path';
    path.textContent = target.path;
    text.appendChild(path);

    row.appendChild(text);

    const go = document.createElement('span');
    go.className = 'move-quick-go';
    go.setAttribute('aria-hidden', 'true');
    go.textContent = '→';
    row.appendChild(go);

    row.title = target.path + ' へ移動';
    row.addEventListener('click', () => finishMove(target.id));
    moveQuickList.appendChild(row);
  }

  moveQuick.hidden = false;
}

/** 開く場所を切り替え、その中のフォルダを並べる。 */
async function showMoveFolder(folderId, myGeneration) {
  const generationAtCall =
    myGeneration === undefined ? moveGeneration : myGeneration;
  const rootId = await bookmarksRootId();
  if (generationAtCall !== moveGeneration || !moveDialog.open) return;

  const id = folderId || rootId;
  moveCursor = id;
  moveList.textContent = '';

  const path = await buildPath(id);
  // 待っている間に別のフォルダが選ばれていたら、この結果は捨てる
  if (generationAtCall !== moveGeneration || moveCursor !== id || !moveDialog.open) {
    return;
  }

  const visible = path.filter((node) => node.id !== rootId);
  const leaf = visible.length ? visible[visible.length - 1] : null;
  moveCurrentName.textContent = leaf ? leaf.title || '(名称未設定)' : 'ブックマーク';

  const parent = visible.length >= 2 ? visible[visible.length - 2].id : rootId;
  moveUpButton.disabled = id === rootId;
  moveUpButton.onclick = () => showMoveFolder(parent);

  let children = [];
  try {
    children = await browser.bookmarks.getChildren(id);
  } catch (e) {
    children = [];
  }
  if (generationAtCall !== moveGeneration || moveCursor !== id || !moveDialog.open) {
    return;
  }

  const folders = children.filter((node) => !node.url && node.type !== 'separator');

  for (const folder of folders) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'move-row';
    row.appendChild(createFolderGlyph());

    const name = document.createElement('span');
    name.className = 'move-row-name';
    name.textContent = folder.title || '(名称未設定のフォルダ)';
    row.appendChild(name);

    if (folder.id === moveHome) {
      const note = document.createElement('span');
      note.className = 'move-row-note';
      note.textContent = '現在の場所';
      row.appendChild(note);
    }

    const enter = document.createElement('span');
    enter.className = 'move-row-enter';
    enter.setAttribute('aria-hidden', 'true');
    enter.textContent = '›';
    row.appendChild(enter);

    row.addEventListener('click', () => showMoveFolder(folder.id));
    moveList.appendChild(row);
  }

  if (folders.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'move-empty';
    empty.textContent = 'この中にフォルダはありません。';
    moveList.appendChild(empty);
  }

  /*
   * ルートは Firefox では入れ物ではなく、ブックマークを直接は置けない。
   * 押せるように見せてから失敗させるより、押せなくして理由を出す。
   */
  const note =
    id === rootId
      ? 'いちばん外側には直接置けません。フォルダを選んでください。'
      : id === moveHome
        ? 'このブックマークは、いまここにあります。'
        : '';
  moveOkButton.disabled = Boolean(note);
  moveNote.textContent = note;
  moveNote.hidden = !note;
}

moveOkButton.addEventListener('click', () => {
  if (moveCursor) finishMove(moveCursor);
});
moveCancelButton.addEventListener('click', () => finishMove(null));
// Esc も、覆いを押したのも「やめる」
moveDialog.addEventListener('close', () => finishMove(null));
moveDialog.addEventListener('click', (event) => {
  if (event.target === moveDialog) finishMove(null);
});

/* ------------------------------------------------------------------ *
 * 確認ダイアログ
 * ------------------------------------------------------------------ */

const confirmDialog = document.getElementById('confirm-dialog');
const confirmTitle = document.getElementById('confirm-title');
const confirmBody = document.getElementById('confirm-body');
const confirmDetail = document.getElementById('confirm-detail');
const confirmOkButton = document.getElementById('confirm-ok');
const confirmCancelButton = document.getElementById('confirm-cancel');

let confirmResolve = null;

/**
 * 確認を取る。はい/いいえを Promise で返す。
 *
 * 最初の当たりは「キャンセル」に置く。Enter や Space を押しただけで
 * 消えてしまうと、確認を挟んだ意味が無くなるため。
 */
function askConfirm(title, body, detail, okLabel) {
  finishConfirm(false);
  confirmTitle.textContent = title;
  confirmBody.textContent = body;
  confirmDetail.textContent = detail || '';
  confirmOkButton.textContent = okLabel;

  const promise = new Promise((resolve) => {
    confirmResolve = resolve;
  });

  if (!confirmDialog.open) confirmDialog.showModal();
  confirmCancelButton.focus();
  return promise;
}

function finishConfirm(answer) {
  const resolve = confirmResolve;
  confirmResolve = null;
  if (confirmDialog.open) confirmDialog.close();
  if (resolve) resolve(answer);
}

confirmOkButton.addEventListener('click', () => finishConfirm(true));
confirmCancelButton.addEventListener('click', () => finishConfirm(false));
// Esc も覆いも「やめる」= 消さない側に倒す
confirmDialog.addEventListener('close', () => finishConfirm(false));
confirmDialog.addEventListener('click', (event) => {
  if (event.target === confirmDialog) finishConfirm(false);
});

/* ------------------------------------------------------------------ *
 * ︙ の操作 — 移動と削除
 * ------------------------------------------------------------------ */

/** ︙ の「フォルダへ移動…」。行き先を選ばせ、動かし、結果を知らせる。 */
async function moveCard(card) {
  const id = card.dataset.id;
  if (!id) return;
  // 二重に開かせない。開き直すと、先に開いていたほうが「やめた」ことになる
  if (moveDialog.open) return;

  let node;
  try {
    node = (await browser.bookmarks.get(id))[0];
  } catch (e) {
    showToast('このブックマークは見つかりませんでした。');
    return;
  }
  if (!node) return;

  const label = cardLabel(card);
  const fromId = node.parentId;
  const fromIndex = node.index;

  const toId = await chooseMoveTarget(node, label);
  if (!toId || toId === fromId) return;

  // 動かす前に読む。動かしたあとでは「どこから」が分からなくなる。
  const [fromPath, toPath] = await Promise.all([
    folderPathLabel(fromId),
    folderPathLabel(toId),
  ]);

  try {
    await browser.bookmarks.move(id, { parentId: toId });
  } catch (e) {
    showToast('移動できませんでした: ' + errorText(e));
    return;
  }

  bumpMoveHistory(toId);
  showToast('「' + label + '」を ' + fromPath + ' から ' + toPath + ' に移動しました', {
    label: '元に戻す',
    onChoose: () => undoMove(id, fromId, fromIndex, label),
  });
}

/** 元の親の、元の位置へ戻す。ここでは「よく使う」を数えない。 */
async function undoMove(id, parentId, index, label) {
  try {
    await browser.bookmarks.move(id, { parentId, index });
  } catch (e) {
    showToast('元に戻せませんでした: ' + errorText(e));
    return;
  }
  showToast('「' + label + '」を元の場所に戻しました');
}

/**
 * ︙ の「ブックマークを削除」。
 *
 * v19 で一度外した機能。「押し間違いで元に戻せない操作が、サムネイルの
 * 取り直しと同じ場所に並んでいた」のが理由だったので、戻すにあたって
 * 二重に手当てする。先に確認を取り、消したあとも知らせから元に戻せる。
 * メニューでも区切り線で離し、色を変えてある。
 *
 * 消すのは 1 件のブックマークだけ。フォルダのカードには ︙ を置いて
 * いないので、中身ごと消える removeTree はどこからも呼ばない。
 */
async function removeBookmark(card) {
  const id = card.dataset.id;
  if (!id) return;

  let node;
  try {
    node = (await browser.bookmarks.get(id))[0];
  } catch (e) {
    return;
  }
  if (!node) return;

  const label = cardLabel(card);
  const ok = await askConfirm(
    'ブックマークを削除',
    '「' + label + '」を削除します。',
    node.url,
    '削除'
  );
  if (!ok) return;

  try {
    await browser.bookmarks.remove(id);
  } catch (e) {
    showToast('削除できませんでした: ' + errorText(e));
    return;
  }

  showToast('「' + label + '」を削除しました', {
    label: '元に戻す',
    onChoose: () => undoRemove(node, label),
  });
}

/** 消したブックマークを作り直す。ID は新しくなるが、場所と中身は戻る。 */
async function undoRemove(node, label) {
  try {
    await browser.bookmarks.create({
      parentId: node.parentId,
      index: node.index,
      title: node.title,
      url: node.url,
    });
  } catch (e) {
    showToast('元に戻せませんでした: ' + errorText(e));
    return;
  }
  showToast('「' + label + '」を元に戻しました');
}

/* ------------------------------------------------------------------ *
 * rawkuma を新しい順に並べる (sortByUpdated)
 *
 * 動かすのは rawkuma のカードだけ。しかも**そのカードたちが元から占めて
 * いる場所の中だけ**で入れ替える。よそのブックマークは 1 枚も動かない。
 *
 * v24 はどのサイトの日時も読んで全体を並べ替えていた。rawkuma のフォルダ
 * では良かったが、他のフォルダまで並びが変わって使いづらいという報告が
 * 出た。「新しい順に並ぶと嬉しいのは rawkuma だけ」というのが答えで、
 * 対象を絞るのが正しかった。
 *
 * どれが対象かは背景が決める (isChapterHost)。ニュータブはその答えを
 * dataset.sortable として持つだけで、サイトの名前は知らない。
 *
 * 並べ替えは DOM を組み替えずに CSS の order でやる。カードを差し替えると
 * 取得済みの絵も話数の送り位置も失われ、取り直しが起きるため。grid の
 * 自動配置は order の順に置くので、これだけで並びが変わる。
 * ------------------------------------------------------------------ */

const sortStatus = document.getElementById('sort-status');

/** 並べ替えを反映してよい位置。ここより下にいるときは触らない。 */
const SORT_TOP_PX = 120;

/** 日時が届くたびに並べ替えず、少し待ってまとめて反映する。 */
const SORT_SETTLE_MS = 400;

/** ニュータブ側で同時に投げる「日時だけ」の問い合わせ数。 */
const SWEEP_WORKERS = 3;

let sortTimer = 0;
/** 反映を待たせている並べ替えがあるか (利用者が下を見ている間)。 */
let sortPending = false;
/** まだ日時の分かっていないカードの数。 */
let sweepLeft = 0;

/**
 * 並べ替えの対象と、保存済みの日時をまとめて聞く。網には出ない。
 *
 * 対象 (sortable) を先に受け取るのが肝心。これが無いと、日時が届くまで
 * 「どのカードが動きうるか」が決まらず、届くたびに関係のないカードまで
 * 場所を変えてしまう。
 */
const NO_SORT_INFO = { sortable: [], dates: {} };

function requestSortInfo(urls) {
  if (!urls.length) return Promise.resolve(NO_SORT_INFO);
  return browser.runtime
    .sendMessage({ type: 'follient:updated-cached', urls })
    .then((info) => (info && Array.isArray(info.sortable) ? info : NO_SORT_INFO))
    .catch(() => NO_SORT_INFO);
}

/** 1 ページぶんの日時を聞く。無ければ背景が取りにいく。 */
function requestUpdated(url) {
  return browser.runtime
    .sendMessage({ type: 'follient:updated', url })
    .catch(() => null);
}

/**
 * 並べ替えを実際に当てる。
 *
 * **場所は増えも減りもしない。** 対象のカードが元から占めている場所を
 * そのまま使い、その中で中身だけを入れ替える。だからフォルダも、よその
 * ブックマークも、1 枚も動かない。混ざったフォルダでも、動くのは
 * rawkuma のカードだけになる。
 *
 * 日時の分からない対象は、対象の中の末尾へ回す。「分からない」を古い
 * 日付とみなして混ぜると、並びの意味が濁るため。
 */
function applySort() {
  const cards = Array.prototype.slice.call(grid.children);
  if (!settings.sortByUpdated) {
    for (const card of cards) card.style.order = '';
    return;
  }

  const movable = [];
  cards.forEach((card, index) => {
    // まず全員を元の場所に固定する。これをしないと、対象だけ order を
    // 持ち、持たないカードが既定値 0 のまま先頭へ寄ってしまう。
    card.style.order = String(index);
    if (card.dataset.sortable === 'true') {
      movable.push({ card, index, at: Number(card.dataset.updatedAt || 0) });
    }
  });
  if (movable.length < 2) return;

  const slots = movable.map((entry) => entry.index);
  movable.sort((a, b) => (a.at !== b.at ? b.at - a.at : a.index - b.index));
  movable.forEach((entry, rank) => {
    entry.card.style.order = String(slots[rank]);
  });
}

/** 今どういう状態かを上の帯に出す。何も起きていなければ隠す。 */
function updateSortStatus() {
  if (!sortStatus) return;
  if (!settings.sortByUpdated) {
    sortStatus.hidden = true;
    return;
  }
  if (sweepLeft > 0) {
    sortStatus.textContent = '更新日時を調べています… 残り ' + sweepLeft + ' 件';
    sortStatus.hidden = false;
    return;
  }
  if (sortPending) {
    sortStatus.textContent = '並べ替えを保留中 — 一番上に戻すと反映します';
    sortStatus.hidden = false;
    return;
  }
  sortStatus.hidden = true;
}

/**
 * 並べ替えを頼む。すぐには当てない。
 *
 * 読んでいる最中に足元のカードが動くのがいちばん困る。画面が一番上に
 * ある間だけ当て、下を見ているときは保留して、上に戻ったときに当てる。
 */
function requestSort() {
  if (!settings.sortByUpdated) return;
  clearTimeout(sortTimer);
  sortTimer = setTimeout(() => {
    if (window.scrollY > SORT_TOP_PX) {
      sortPending = true;
      updateSortStatus();
      return;
    }
    sortPending = false;
    applySort();
    updateSortStatus();
  }, SORT_SETTLE_MS);
}

window.addEventListener(
  'scroll',
  () => {
    if (sortPending && window.scrollY <= SORT_TOP_PX) requestSort();
  },
  { passive: true }
);

/** 経過時間の言い方。カードに小さく出して、並びの根拠を見えるようにする。 */
function relativeTime(ms) {
  const diff = Date.now() - ms;
  if (diff < 0) return 'たった今';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'たった今';
  if (minutes < 60) return minutes + '分前';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + '時間前';
  const days = Math.floor(hours / 24);
  if (days < 31) return days + '日前';
  const months = Math.floor(days / 30);
  if (months < 12) return months + 'か月前';
  return Math.floor(days / 365) + '年前';
}

/**
 * ホスト名の行に更新日時を添える。日時が無いときは元のホスト名だけ。
 * 並べ替えの根拠を見えるようにするためのもので、対象のカードにしか出ない。
 */
function renderUpdated(card) {
  const host = card.querySelector('.host');
  if (!host) return;
  const name = card.dataset.host || '';
  const at = Number(card.dataset.updatedAt || 0);

  if (!settings.sortByUpdated || !at) {
    host.textContent = name;
    host.removeAttribute('title');
    return;
  }
  host.textContent = name ? name + ' · ' + relativeTime(at) : relativeTime(at);
  host.title = new Date(at).toLocaleString();
}

/** カードに日時を持たせる。変わったときだけ並べ替えを頼む。 */
function setUpdatedAt(card, at) {
  const next = at ? String(at) : '';
  if ((card.dataset.updatedAt || '') === next) return false;
  if (next) {
    card.dataset.updatedAt = next;
  } else {
    delete card.dataset.updatedAt;
  }
  renderUpdated(card);
  return true;
}

/**
 * まだ日時の分からないカードを、順に埋めていく。
 *
 * **対象のカードしか見ない。** よそのブックマークしか無いフォルダでは
 * queue が空になり、1 件も取りにいかない (v23 までと通信量が変わらない)。
 *
 * 画面に入ったカードの取得 (hydrateCard) と同じ道を通るので、二度取りには
 * ならない。背景が同じ URL の取得を 1 本にまとめ、結果を保存するため。
 * 同時に投げる数を絞ってあるのは、見えているカードの取得を待たせないため。
 */
async function sweepDates(cards, myGeneration) {
  const queue = cards.filter(
    (card) => card.dataset.sortable === 'true' && !card.dataset.updatedAt
  );
  sweepLeft = queue.length;
  updateSortStatus();
  if (sweepLeft === 0) return;

  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const card = queue[next];
      next += 1;
      const result = await requestUpdated(card.dataset.url);
      if (myGeneration !== generation) return;
      if (card.isConnected && result && result.at) {
        if (setUpdatedAt(card, result.at)) requestSort();
      }
      sweepLeft -= 1;
      updateSortStatus();
    }
  };

  const workers = [];
  for (let i = 0; i < Math.min(SWEEP_WORKERS, queue.length); i += 1) workers.push(worker());
  await Promise.all(workers);
  if (myGeneration !== generation) return;
  sweepLeft = 0;
  updateSortStatus();
  requestSort();
}

/* ------------------------------------------------------------------ *
 * カード生成
 * ------------------------------------------------------------------ */

/** テンプレートを複製し、どのカードにも要る配線を済ませて返す。 */
function createCardShell(node) {
  const card = cardTemplate.content.firstElementChild.cloneNode(true);
  card.dataset.id = node.id;

  card.querySelector('.menu-button').addEventListener('click', (event) => {
    // カードの大部分はリンクなので、押した先へ移動させない
    event.preventDefault();
    event.stopPropagation();
    openMenu(card);
  });

  return card;
}

function createFolderCard(node, childCount) {
  const card = createCardShell(node);
  card.classList.add('is-folder');
  card.dataset.kind = 'folder';
  card.querySelector('.card-link').href = '#f/' + encodeURIComponent(node.id);

  const fallback = card.querySelector('.thumb-fallback');
  fallback.appendChild(createFolderIcon());
  applyFallbackColor(fallback, node.title || node.id);

  card.querySelector('.thumb-img').remove();
  card.querySelector('.thumb-state').remove();
  card.querySelector('.order-badge').remove();
  card.querySelector('.chapters-wrap').remove();
  // 出せる操作が無いので、ボタン自体を置かない
  card.querySelector('.menu-button').remove();

  const title = node.title || '(名称未設定のフォルダ)';
  card.querySelector('.title').textContent = title;
  card.querySelector('.link-label').textContent = title;
  card.querySelector('.host').textContent =
    childCount === 0 ? '空のフォルダ' : childCount + ' 件';
  card.title = title;

  return card;
}

/**
 * @param {number} order このフォルダで何番目のブックマークか (1 始まり)。
 *   フォルダは数に入れない。並べ替えたときに追える番号が欲しいだけなので、
 *   ブックマークだけを通しで数える。
 * @param {object} [sort] 並べ替えのための下ごしらえ。`sortable` が真の
 *   カードだけが動きうる。`updatedAt` は保存してあった日時で、あれば
 *   開いた瞬間から「新しい順」に並べられる。
 */
function createBookmarkCard(node, order, sort) {
  const card = createCardShell(node);
  card.dataset.kind = 'bookmark';
  card.dataset.url = node.url;
  card.querySelector('.card-link').href = node.url;
  card.querySelector('.order-badge').textContent = String(order);

  const host = hostOf(node.url);
  card.dataset.host = host;
  const fallback = card.querySelector('.thumb-fallback');
  applyFallbackColor(fallback, host || node.url);
  fallback.textContent = (host || '?').charAt(0).toUpperCase();

  // ブックマーク名が URL そのままなら OG タイトルで置き換える
  const hasOwnTitle = Boolean(node.title) && node.title !== node.url;
  card.dataset.useOgTitle = hasOwnTitle ? 'false' : 'true';

  const label = hasOwnTitle ? node.title : host || node.url;
  card.querySelector('.title').textContent = label;
  card.querySelector('.link-label').textContent = label;
  card.querySelector('.host').textContent = host;
  card.title = (node.title || node.url) + '\n' + node.url;

  if (sort && sort.sortable) {
    card.dataset.sortable = 'true';
    if (sort.updatedAt) {
      card.dataset.updatedAt = String(sort.updatedAt);
      renderUpdated(card);
    }
  }

  return card;
}

/* ------------------------------------------------------------------ *
 * ナビゲーション
 * ------------------------------------------------------------------ */

function folderIdFromHash() {
  const match = /^#f\/(.+)$/.exec(location.hash);
  return match ? decodeURIComponent(match[1]) : null;
}

/** ルートまで parentId を辿って、パンくず用の配列を作る。 */
async function buildPath(folderId) {
  const path = [];
  let id = folderId;
  const guard = new Set();

  while (id && !guard.has(id)) {
    guard.add(id);
    let node;
    try {
      node = (await browser.bookmarks.get(id))[0];
    } catch (e) {
      break;
    }
    if (!node) break;
    path.unshift(node);
    id = node.parentId;
  }
  return path;
}

function renderNavigation(path, rootId) {
  breadcrumb.textContent = '';

  const rootLink = document.createElement('a');
  rootLink.href = '#';
  rootLink.textContent = 'ブックマーク';
  breadcrumb.appendChild(rootLink);

  // path の先頭はルート自身なので落とす
  const visible = path.filter((node) => node.id !== rootId);

  visible.forEach((node, index) => {
    const separator = document.createElement('span');
    separator.className = 'sep';
    separator.textContent = '/';
    breadcrumb.appendChild(separator);

    const label = node.title || '(名称未設定)';
    if (index === visible.length - 1) {
      const current = document.createElement('span');
      current.className = 'current';
      current.textContent = label;
      breadcrumb.appendChild(current);
    } else {
      const link = document.createElement('a');
      link.href = '#f/' + encodeURIComponent(node.id);
      link.textContent = label;
      breadcrumb.appendChild(link);
    }
  });

  // 仮想フォルダ (= ルート以外) にいる時だけ「上層に戻る」を出す
  if (visible.length === 0) {
    upLink.hidden = true;
  } else {
    const parent = visible.length >= 2 ? visible[visible.length - 2] : null;
    upLink.href = parent ? '#f/' + encodeURIComponent(parent.id) : '#';
    upLink.hidden = false;
  }
}

/* ------------------------------------------------------------------ *
 * 描画
 * ------------------------------------------------------------------ */

async function render() {
  generation += 1;
  const myGeneration = generation;
  // 描き終えるまでは、どの変更も「関係あり」として扱う
  shownTree = null;

  closeMenu();
  viewportObserver.disconnect();
  cardResizeObserver.disconnect();
  grid.textContent = '';
  emptyMessage.hidden = true;

  // 前のフォルダの並べ替えは、ここで打ち切る。走っている sweepDates は
  // 世代が変わったことに気づいて自分から降りる。
  clearTimeout(sortTimer);
  sortPending = false;
  sweepLeft = 0;
  updateSortStatus();

  const treeRoot = (await browser.bookmarks.getTree())[0];
  const rootId = treeRoot.id;
  rootIdCache = rootId;
  const folderId = folderIdFromHash() || rootId;

  let children;
  try {
    children = await browser.bookmarks.getChildren(folderId);
  } catch (e) {
    // 消えたフォルダのハッシュが残っている場合はルートへ戻す
    location.hash = '';
    return;
  }
  if (myGeneration !== generation) return;

  const path = await buildPath(folderId);
  if (myGeneration !== generation) return;
  renderNavigation(path, rootId);

  shownTree = {
    folderId,
    pathIds: new Set(path.map((node) => node.id)),
    childIds: new Set(children.map((node) => node.id)),
    childFolderIds: new Set(children.filter((node) => !node.url).map((node) => node.id)),
  };

  const leaf = path.length ? path[path.length - 1] : null;
  document.title = leaf && leaf.id !== rootId && leaf.title ? leaf.title : 'follient';

  const visibleNodes = children.filter((node) => {
    if (node.type === 'separator') return false;
    return node.url ? /^(https?|ftp|file):/i.test(node.url) : true;
  });

  if (visibleNodes.length === 0) {
    emptyMessage.hidden = false;
    return;
  }

  // フォルダの件数表示のためだけに子を数える
  const counts = await Promise.all(
    visibleNodes.map((node) =>
      node.url
        ? Promise.resolve(0)
        : browser.bookmarks.getChildren(node.id).then(
            (kids) => kids.length,
            () => 0
          )
    )
  );
  if (myGeneration !== generation) return;

  /*
   * 「新しい順」のときは、どれが対象かと保存してある日時を先に聞いておく。
   * storage を 1 回読むだけで網には出ないので、開いた瞬間から前回の並びで
   * 出せる。知らない日時は後から sweepDates が埋める。
   */
  const sortInfo = settings.sortByUpdated
    ? await requestSortInfo(visibleNodes.filter((node) => node.url).map((node) => node.url))
    : NO_SORT_INFO;
  if (myGeneration !== generation) return;
  const sortable = new Set(sortInfo.sortable);

  const fragment = document.createDocumentFragment();
  const cards = [];
  let order = 0;

  visibleNodes.forEach((node, index) => {
    if (node.url) order += 1;
    const card = node.url
      ? createBookmarkCard(node, order, {
          sortable: sortable.has(node.url),
          updatedAt: sortInfo.dates[node.url],
        })
      : createFolderCard(node, counts[index]);
    card.style.animationDelay = Math.min(index, 24) * 18 + 'ms';
    fragment.appendChild(card);
    cards.push(card);
  });

  grid.appendChild(fragment);
  applySort();

  for (const card of cards) {
    layoutCard(card);
    cardResizeObserver.observe(card);
    if (card.dataset.url) viewportObserver.observe(card);
  }

  if (settings.sortByUpdated) sweepDates(cards, myGeneration);
}

/* ------------------------------------------------------------------ *
 * 起動
 * ------------------------------------------------------------------ */

window.addEventListener('hashchange', () => {
  render();
  window.scrollTo({ top: 0 });
});

/*
 * ブックマークが変更されたら表示を追随させる。ただし今の画面に関係する
 * 変更だけ。描き直しは全カードを作り直すので、別ウィンドウでよそのフォルダに
 * 登録しただけで、見ている画面が一瞬空になってしまう。
 */
const watchBookmarks = {
  onCreated: (_, node) => showsChildrenOf(node.parentId),
  onRemoved: (id, info) => showsChildrenOf(info.parentId) || shownTree.pathIds.has(id),
  onChanged: (id) => shownTree.childIds.has(id) || shownTree.pathIds.has(id),
  onMoved: (id, info) =>
    showsChildrenOf(info.parentId) ||
    showsChildrenOf(info.oldParentId) ||
    shownTree.pathIds.has(id),
};

for (const [eventName, affects] of Object.entries(watchBookmarks)) {
  const event = browser.bookmarks[eventName];
  if (!event) continue;
  event.addListener((...args) => {
    if (!shownTree || affects(...args)) render();
  });
}

readGridMetrics();
render();
