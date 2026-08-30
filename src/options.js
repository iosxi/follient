/**
 * follient の設定画面。
 * チェックを変えたその場で保存する。保存ボタンは置かない。
 */
(() => {
  const savedNote = document.getElementById('saved');
  const fields = Array.from(document.querySelectorAll('input[data-key]'));

  let noticeTimer = null;
  function showSaved() {
    savedNote.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      savedNote.hidden = true;
    }, 1600);
  }

  /**
   * 入力の中身を、保存する形にして返す。
   * 数値は空欄や範囲外がありうるので、直したうえで画面にも書き戻す。
   * 黙って別の値で保存すると、見えているものと動きが食い違う。
   */
  function readField(field) {
    if (field.type === 'checkbox') return field.checked;

    let value = parseInt(field.value, 10);
    if (!Number.isFinite(value)) value = FOLLIENT_DEFAULTS[field.dataset.key];
    value = Math.min(Number(field.max), Math.max(Number(field.min), value));
    field.value = String(value);
    return value;
  }

  async function save() {
    const settings = {};
    for (const field of fields) settings[field.dataset.key] = readField(field);
    await browser.storage.local.set({ settings });
    showSaved();
  }

  /**
   * 取得済みのものを消す。og: の判定結果、img: の実体、
   * それに撮影時代に残った shot: が対象。
   * 設定 (settings) と、テスト用の目印は残す。
   */
  const clearButton = document.getElementById('clear');
  const clearResult = document.getElementById('clear-result');

  clearButton.addEventListener('click', async () => {
    clearButton.disabled = true;
    clearResult.textContent = '消しています…';
    try {
      const all = await browser.storage.local.get(null);
      const keys = Object.keys(all).filter(
        (key) =>
          key.indexOf('og:') === 0 ||
          key.indexOf('img:') === 0 ||
          key.indexOf('shot:') === 0
      );
      if (keys.length > 0) await browser.storage.local.remove(keys);
      clearResult.textContent = keys.length + ' 件を消しました';
    } catch (e) {
      clearResult.textContent = '消せませんでした: ' + (e && e.message ? e.message : e);
    } finally {
      clearButton.disabled = false;
    }
  });

  (async () => {
    const settings = await follientLoadSettings();
    for (const field of fields) {
      const value = settings[field.dataset.key];
      if (field.type === 'checkbox') field.checked = value !== false;
      else field.value = String(value);
      field.addEventListener('change', save);
    }
  })();
})();
