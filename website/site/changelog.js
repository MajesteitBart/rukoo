// Click a screenshot, see it at full resolution. The frames are plain
// links to the full-size file; this script turns the click into a modal
// that fills the viewport. The full file loads only when clicked.
const dialog = document.getElementById('log-dialog');
if (dialog) {
  const full = dialog.querySelector('img');
  const close = dialog.querySelector('.log-close');
  let opener = null;

  for (const link of document.querySelectorAll('a.log-zoom')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      opener = link;
      full.src = link.href;
      full.alt = link.querySelector('img')?.alt || '';
      dialog.showModal();
      close.focus();
    });
  }

  close.addEventListener('click', () => dialog.close());
  // A click on the backdrop lands on the dialog itself, outside the image.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    full.removeAttribute('src');
    opener?.focus();
    opener = null;
  });
}
