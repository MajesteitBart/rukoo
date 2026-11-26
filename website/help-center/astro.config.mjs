import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import navigation from './navigation.json' with { type: 'json' };
import { satteri } from '@astrojs/markdown-satteri';
import { markdownKeys } from './scripts/markdown-keys.mjs';

// The help center at https://help.rukoo.io. `npm run build` writes it to ../site/help/, and the rukoo-site Worker,
// which also serves rukoo.io, answers help.rukoo.io from there (../cloudflare/help-center.js). Starlight writes
// sitemap-index.xml for this site; public/robots.txt points to it.
export default defineConfig({
  site: 'https://help.rukoo.io', output: 'static', trailingSlash: 'always',
  markdown: { processor: satteri({ hastPlugins: [markdownKeys()] }) },
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
