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

  (async () => {
    const settings = await follientLoadSettings();
    for (const box of boxes) {
      box.checked = settings[box.dataset.key] !== false;
      box.addEventListener('change', save);
    }
  })();
})();
