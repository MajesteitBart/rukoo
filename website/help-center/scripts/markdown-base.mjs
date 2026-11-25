// Pages link to each other as /mail/write/, the URL in page-registry.json. The help center is published under
// rukoo.io/help/, so this Sätteri hast plugin adds the base to every root-relative link and image in the rendered
// Markdown. Starlight already does this for the sidebar.
export function withBase(url, base) {
  const prefix = base.replace(/\/$/, '');
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return url;
  if (url === prefix || url.startsWith(prefix + '/')) return url;
  return prefix + url;
}

export function markdownBase(base) {
  return {
    name: 'rukoo-help-base',
    element: {
      filter: ['a', 'img'],
      visit(node, ctx) {
        const key = node.tagName === 'a' ? 'href' : 'src';
        const url = node.properties?.[key];
        const next = withBase(url, base);
        if (next !== url) ctx.setProperty(node, key, next);
      },
    },
  };
}
