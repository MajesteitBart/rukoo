import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import navigation from './navigation.json' with { type: 'json' };
import { satteri } from '@astrojs/markdown-satteri';
import { markdownBase } from './scripts/markdown-base.mjs';
import { markdownKeys } from './scripts/markdown-keys.mjs';

// The help center is part of rukoo.io. `npm run build` writes it to ../site/help/, and the rukoo-site Worker serves it
// at https://rukoo.io/help/ with the rest of the site. Page URLs in page-registry.json and in the Markdown stay
// relative to the help center (/mail/write/); the base is added at build time.
const base = '/help';

export default defineConfig({
  site: 'https://rukoo.io', base, output: 'static', trailingSlash: 'always',
  markdown: { processor: satteri({ hastPlugins: [markdownBase(base), markdownKeys()] }) },
  integrations: [starlight({
    title: 'Rukoo help', description: 'Help with Rukoo Mail, team chat and Rukoo Voice.',
    logo: { light: './public/rukoo-logo.svg', dark: './public/rukoo-logo-dark.svg', alt: 'Rukoo Mail', replacesTitle: false },
    sidebar: navigation, customCss: ['./src/styles/custom.css'],
    social: [{ icon: 'github', label: 'Rukoo on GitHub', href: 'https://github.com/MajesteitBart/rukoo' }],
    // The wordmark goes to the rukoo.io home page; "Help" next to it goes to the help home.
    components: { SiteTitle: './src/components/SiteTitle.astro' },
    head: [
      { tag: 'meta', attrs: { property: 'og:image', content: 'https://rukoo.io/img/og.png' } },
      { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
      { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
      { tag: 'link', attrs: { rel: 'preload', href: '/assets/fonts/inter-latin-opsz-normal.woff2', as: 'font', type: 'font/woff2', crossorigin: '' } },
    ],
    pagefind: true,
  })],
});
