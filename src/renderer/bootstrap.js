import { setLanguage, t } from './i18n.js';

// Native window controls must have space before the first interface is drawn.
document.documentElement.dataset.platform = window.mail.platform;

// Set the persisted language before importing modules that construct interface labels.
try {
  const { settings } = await window.mail.call('state');
  setLanguage(settings.language);
  if (window.mail.platform === 'darwin') {
    document.documentElement.style.setProperty('--mac-titlebar-inset', `${86 / ((settings.zoomLevel || 100) / 100)}px`);
  }
  const composing = document.body.classList.contains('compose-window');
  if (composing) {
    document.title = t('composer.titles.new');
    document.getElementById('compose-title').textContent = document.title;
  }
  await import(composing ? './compose.js' : './app.js');
} catch (error) {
  const toast = document.getElementById('toast');
  toast.textContent = error.message;
  toast.classList.add('show');
}
