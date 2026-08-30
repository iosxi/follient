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
    settings = Object.assign({}, FOLLIENT_DEFAULTS, changes.settings.newValue || {});
  }
});

/** grid-auto-rows / gap の実測値。masonry の span 計算に使う。 */
let rowUnit = 4;
let gapUnit = 18;

/** 描画世代。非同期処理が古い画面に書き込むのを防ぐ。 */
let generation = 0;

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
    card.title = data.title + '\n' + url;
  }

  // 2xx で返らなかったページは、番号と意味を出して終わる。
  // 保存してある絵より先に見る。消えたブックマークだと分かるほうが、
  // 昔の絵が出続けるより役に立つ。
  if (data && typeof data.httpStatus === 'number') {
    showStatusTile(card, data.httpStatus, data.netKind);
    return;
  }

  // 一度読めた絵は手元にある。相手の機嫌に左右されず、網にも出ない。
  if (!force) {
    const stored = await requestStoredThumb(url);
    if (myGeneration !== generation || !card.isConnected) return;
    if (stored && stored.image) {
      showImage(card, [stored.image]);
      return;
    }
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
  if (!menuCard) return;
  const button = menuCard.querySelector('.menu-button');
  if (button) button.setAttribute('aria-expanded', 'false');
  menuCard = null;
  cardMenu.hidden = true;
  cardMenu.textContent = '';
}

function addMenuItem(label, danger, onChoose) {
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

  const isFolder = card.dataset.kind === 'folder';

  // フォルダには撮るものが無いので、更新はブックマークにだけ出す
  if (!isFolder) addMenuItem('サムネイル更新', false, () => refreshThumbnail(card));
  addMenuItem(isFolder ? 'フォルダ削除' : 'ブックマーク削除', true, () => removeNode(card));

  const button = card.querySelector('.menu-button');
  menuCard = card;
  cardMenu.hidden = false;
  placeMenu(button);
  button.setAttribute('aria-expanded', 'true');

  const first = cardMenu.querySelector('.menu-item');
  if (first) first.focus();
}

/**
 * ブックマークを消す。
 *
 * フォルダは中身ごと消えて元に戻せないため、空でなければ必ず確認を取る。
 * 1 件のブックマークはブラウザ本体の操作と同じく、そのまま消す。
 */
async function removeNode(card) {
  const id = card.dataset.id;
  if (!id) return;

  try {
    if (card.dataset.kind === 'folder') {
      let count = 0;
      try {
        count = (await browser.bookmarks.getChildren(id)).length;
      } catch (e) {
        count = 0;
      }
      const name = card.dataset.name || 'このフォルダ';
      const ask = '「' + name + '」を中身 ' + count + ' 件ごと削除します。元に戻せません。';
      if (count > 0 && !window.confirm(ask)) return;
      await browser.bookmarks.removeTree(id);
    } else {
      await browser.bookmarks.remove(id);
    }
  } catch (e) {
    console.warn('follient: 削除できませんでした', e);
  }
  // 消えた結果の描画は bookmarks.onRemoved が受け持つ
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

  const title = node.title || '(名称未設定のフォルダ)';
  card.dataset.name = title;
  card.querySelector('.title').textContent = title;
  card.querySelector('.host').textContent =
    childCount === 0 ? '空のフォルダ' : childCount + ' 件';
  card.title = title;

  return card;
}

/**
 * @param {number} order このフォルダで何番目のブックマークか (1 始まり)。
 *   フォルダは数に入れない。並べ替えたときに追える番号が欲しいだけなので、
 *   ブックマークだけを通しで数える。
 */
function createBookmarkCard(node, order) {
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
  card.dataset.name = label;
  card.querySelector('.title').textContent = label;
  card.querySelector('.host').textContent = host;
  card.title = (node.title || node.url) + '\n' + node.url;

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

  closeMenu();
  viewportObserver.disconnect();
  cardResizeObserver.disconnect();
  grid.textContent = '';
  emptyMessage.hidden = true;

  const treeRoot = (await browser.bookmarks.getTree())[0];
  const rootId = treeRoot.id;
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

  const fragment = document.createDocumentFragment();
  const cards = [];
  let order = 0;

  visibleNodes.forEach((node, index) => {
    if (node.url) order += 1;
    const card = node.url
      ? createBookmarkCard(node, order)
      : createFolderCard(node, counts[index]);
    card.style.animationDelay = Math.min(index, 24) * 18 + 'ms';
    fragment.appendChild(card);
    cards.push(card);
  });

  grid.appendChild(fragment);

  for (const card of cards) {
    layoutCard(card);
    cardResizeObserver.observe(card);
    if (card.dataset.url) viewportObserver.observe(card);
  }
}

/* ------------------------------------------------------------------ *
 * 起動
 * ------------------------------------------------------------------ */

window.addEventListener('hashchange', () => {
  render();
  window.scrollTo({ top: 0 });
});

// ブックマークが変更されたら表示を追随させる
for (const eventName of ['onCreated', 'onRemoved', 'onChanged', 'onMoved']) {
  const event = browser.bookmarks[eventName];
  if (event) event.addListener(() => render());
}

readGridMetrics();
render();
