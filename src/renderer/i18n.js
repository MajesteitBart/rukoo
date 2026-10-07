export const { languages, normalizeLanguage, getLanguage, getLocale, setLanguage, t } = globalThis.RukooI18n;

// Marks labels in persistent elements (especially open composers) with their catalog key.
// Updating textContent and attributes keeps translations out of HTML parsing.
export function localize(root = document) {
  for (const element of root.querySelectorAll('[data-i18n]')) {
    // Labels can also contain inputs, icons, or shortcuts. Preserve those children.
    const text = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    if (text) text.textContent = t(element.dataset.i18n);
  }
  for (const attribute of ['title', 'aria-label', 'placeholder', 'data-placeholder']) {
    for (const element of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
      element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
    }
  }
}
