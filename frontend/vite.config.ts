import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(), 
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      // main.tsx owns registration so it can also surface update lifecycle events.
      injectRegister: false,
      workbox: {
        // A share link is opened by people who do not have the app installed,
        // and main.tsx never registers a worker on that route. Keeping /s/ out
        // of the navigation fallback stops an *already installed* worker from
        // answering it out of the app's precache as well.
        navigateFallbackDenylist: [/^\/s\//],
      },
      includeAssets: ['favicon.svg', 'favicon.ico', 'pwa-64x64.png', 'pwa-192x192.png', 'pwa-512x512.png', 'apple-touch-icon-180x180.png', 'maskable-icon-512x512.png'],
      manifest: {
        name: 'OrbitPane',
        short_name: 'OrbitPane',
        description: 'OrbitPane - Secure, self-hosted coding agent workspace',
        theme_color: '#0c0c0b',
        background_color: '#0c0c0b',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        id: '/',
        lang: 'zh-CN',
        dir: 'ltr',
        categories: ['developer', 'productivity', 'utilities'],
        orientation: 'any',
        share_target: {
          action: '/?action=share',
          method: 'GET',
          params: {
            title: 'title',
            text: 'text',
            url: 'url'
          }
        },
        shortcuts: [
          {
            name: '新建项目',
            short_name: '新建项目',
            url: '/?action=new-project',
            icons: [{ src: 'pwa-192x192.png', sizes: '192x192' }]
          },
          {
            name: '任务中心',
            short_name: '任务中心',
            url: '/?panel=tasks',
            icons: [{ src: 'pwa-192x192.png', sizes: '192x192' }]
          }
        ],
        screenshots: [
          {
            src: 'screenshots/orbitpane-wide.png',
            sizes: '1440x900',
            type: 'image/png',
            form_factor: 'wide',
            label: 'OrbitPane 桌面任务舱与上下文控制台'
          },
          {
            src: 'screenshots/orbitpane-mobile.png',
            sizes: '390x844',
            type: 'image/png',
            form_factor: 'narrow',
            label: 'OrbitPane 移动端任务中心'
          }
        ],
        icons: [
          {
            src: 'pwa-64x64.png',
            sizes: '64x64',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      }
    })
  ],
  base: '/',
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8005',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
