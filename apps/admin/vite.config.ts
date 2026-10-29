import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
  server: {
    port: 5730,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
  preview: {
    port: 5730,
    strictPort: true,
  },
  build: {
    assetsInlineLimit: 0,
    sourcemap: false,
    rollupOptions: {
      // The team connect page is a second page of the same build. The gateway serves it under /__ankka/connect.
      input: {
        admin: fileURLToPath(new URL('index.html', import.meta.url)),
        connect: fileURLToPath(new URL('team-connect.html', import.meta.url)),
      },
      output: {
        assetFileNames: 'assets/admin-[hash:8][extname]',
        chunkFileNames: 'assets/admin-[hash:8].js',
        entryFileNames: 'assets/admin-[hash:8].js',
        hashCharacters: 'hex',
        manualChunks(id) {
          if (id.includes('/@cloudflare/kumo/')) return 'kumo'
          if (id.includes('/@phosphor-icons/')) return 'icons'
          if (id.includes('/@tanstack/')) return 'router'
          if (id.includes('/react-dom/') || id.includes('/react/')) return 'react'
          return undefined
        },
      },
    },
  },
  experimental: {
    // Files the connect page loads live under /__ankka/connect/assets as well as /assets, so scripts and
    // styles find their images and chunks next to themselves. The gateway rewrites the page's own links.
    renderBuiltUrl(_filename, { hostType }) {
      return hostType === 'html' ? undefined : { relative: true }
    },
  },
})
