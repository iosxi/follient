/**
 * follient の設定画面。
 * チェックを変えたその場で保存する。保存ボタンは置かない。
 */
(() => {
  const savedNote = document.getElementById('saved');
  const boxes = Array.from(document.querySelectorAll('input[type="checkbox"][data-key]'));

  let noticeTimer = null;
  function showSaved() {
    savedNote.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      savedNote.hidden = true;
    }, 1600);
  }

  async function save() {
    const settings = {};
    for (const box of boxes) settings[box.dataset.key] = box.checked;
    await browser.storage.local.set({ settings });
    showSaved();
  }

  /**
   * 取得済みの画像 (OGP の結果とスクリーンショット) を消す。
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
        (key) => key.indexOf('og:') === 0 || key.indexOf('shot:') === 0
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
    for (const box of boxes) {
      box.checked = settings[box.dataset.key] !== false;
      box.addEventListener('change', save);
    }
  })();
})();
