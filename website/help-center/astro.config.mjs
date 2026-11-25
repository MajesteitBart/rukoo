import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import navigation from './navigation.json' with { type: 'json' };
export default defineConfig({
  site: 'https://help.rukoo.io', output: 'static', trailingSlash: 'always',
  integrations: [starlight({
    title: 'Rukoo help', description: 'Help with Rukoo Mail, team chat and Rukoo Voice.',
    logo: { light: './public/rukoo-logo.svg', dark: './public/rukoo-logo-dark.svg', replacesTitle: false },
    sidebar: navigation, customCss: ['./src/styles/custom.css'],
    social: [{ icon: 'github', label: 'Rukoo on GitHub', href: 'https://github.com/MajesteitBart/rukoo' }],
    pagefind: true,
  })],
});
