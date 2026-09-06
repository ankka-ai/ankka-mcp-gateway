import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { installerPreviewApi } from './preview/mock-api'

const installerRoot = fileURLToPath(new URL('../../payload/installer', import.meta.url))

function installerPreviewPlugin(): Plugin {
  return {
    name: 'ankka-installer-preview',
    configureServer(server) {
      server.middlewares.use(installerPreviewApi())
    },
    handleHotUpdate(context) {
      if (!context.file.startsWith(installerRoot)) return
      context.server.ws.send({ type: 'full-reload' })
      return []
    },
    transformIndexHtml: {
      order: 'pre',
      handler() {
        return [{
          tag: 'script',
          injectTo: 'head-prepend',
          children: `
            document.documentElement.dataset.oauthPreview = 'inert';
            const artwork = new URLSearchParams(location.search).get('artwork');
            document.documentElement.dataset.artwork = ['kuro-fault', 'kuro-assemblage', 'kuro-fold', 'kuro-quintet', 'giger', 'ikeda', 'nicolai', 'kurokawa', 'quayola', 'reas', 'lia', 'akten', 'lemercier', 'mead', 'confluence', 'eclipse', 'resonance', 'palimpsest', 'silt', 'vellum', 'anna', 'licia', 'iskra'].includes(artwork) ? artwork : 'kuro-fault';
            document.addEventListener('DOMContentLoaded', () => {
              const picker = document.querySelector('.artwork-picker');
              const update = () => picker.querySelectorAll('[data-study]').forEach(link => {
                if (link.dataset.study === document.documentElement.dataset.artwork) link.setAttribute('aria-current', 'true');
                else link.removeAttribute('aria-current');
              });
              update();
              picker.addEventListener('click', event => {
                const link = event.target.closest('[data-study]');
                if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                document.documentElement.dataset.artwork = link.dataset.study;
                const url = new URL(location.href);
                url.searchParams.set('artwork', link.dataset.study);
                history.replaceState(null, '', url);
                update();
                window.dispatchEvent(new Event('ankka:artwork'));
              });
            });
          `,
        }, {
          tag: 'nav',
          injectTo: 'body-prepend',
          attrs: { class: 'artwork-picker', 'aria-label': 'Background studies' },
          children: '<details><summary>Studies</summary><div class="artwork-options"><span>Kurokawa</span><a href="?artwork=kuro-fault" data-study="kuro-fault">01 · Fault</a><a href="?artwork=kuro-assemblage" data-study="kuro-assemblage">02 · Assemblage</a><a href="?artwork=kuro-fold" data-study="kuro-fold">03 · Fold</a><a href="?artwork=kuro-quintet" data-study="kuro-quintet">04 · Quintet</a><details class="artwork-archive"><summary>Earlier studies</summary><div><a href="?artwork=giger" data-study="giger">H. R. Giger</a><a href="?artwork=ikeda" data-study="ikeda">Ryoji Ikeda</a><a href="?artwork=nicolai" data-study="nicolai">Carsten Nicolai</a><a href="?artwork=kurokawa" data-study="kurokawa">Ryoichi Kurokawa</a><a href="?artwork=quayola" data-study="quayola">Quayola</a><a href="?artwork=reas" data-study="reas">Casey Reas</a><a href="?artwork=lia" data-study="lia">LIA</a><a href="?artwork=akten" data-study="akten">Memo Akten</a><a href="?artwork=lemercier" data-study="lemercier">Joanie Lemercier</a><a href="?artwork=mead" data-study="mead">Syd Mead</a><a href="?artwork=anna" data-study="anna">Anna Lucia</a><a href="?artwork=licia" data-study="licia">Licia He</a><a href="?artwork=iskra" data-study="iskra">Iskra Velitchkova</a></div></details></div></details>',
        }]
      },
    },
  }
}

export default defineConfig({
  root: installerRoot,
  appType: 'spa',
  plugins: [installerPreviewPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5731,
    strictPort: true,
  },
})
