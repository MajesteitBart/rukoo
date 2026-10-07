import { setLanguage, t } from './i18n.js';

// Set the persisted language before importing modules that construct interface labels.
try {
  const { settings } = await window.mail.call('state');
  setLanguage(settings.language);
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
