// Every pill state side by side, each in a real 384x100 pill window. Development only.
//   gallery.html?theme=light|dark&lang=en|nl&edge=bottom|top
import { STATES } from '../mock/pill.js';

const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const lang = params.get('lang') === 'nl' ? 'nl' : 'en';
const edge = params.get('edge') === 'top' ? 'top' : 'bottom';
document.documentElement.classList.toggle('light', theme === 'light');

const link = (label, patch) => {
  const next = new URLSearchParams({ theme, lang, edge, ...patch });
  return `<a href="?${next}">${label}</a>`;
};
document.getElementById('switches').innerHTML = [
  link(theme === 'light' ? 'Dark' : 'Light', { theme: theme === 'light' ? 'dark' : 'light' }),
  link(lang === 'nl' ? 'English' : 'Nederlands', { lang: lang === 'nl' ? 'en' : 'nl' }),
  link('Dictation timeline', {}).replace('href="?', `href="../pill.html?mock=dictation&backdrop=1&theme=${theme}&lang=${lang}&`),
  link('Meeting timeline', {}).replace('href="?', `href="../pill.html?mock=meeting&backdrop=1&hit=1&theme=${theme}&lang=${lang}&`)
].join(' · ');

const grid = document.getElementById('grid');
for (const name of Object.keys(STATES).filter((state) => state !== 'hidden')) {
  const figure = document.createElement('figure');
  const caption = document.createElement('figcaption');
  caption.textContent = name;
  const frame = document.createElement('iframe');
  frame.title = name;
  frame.src = `../pill.html?${new URLSearchParams({ mock: name, theme, lang, edge, backdrop: '1' })}`;
  figure.append(caption, frame);
  grid.append(figure);
}
