import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/odds': {
        target: 'https://api.the-odds-api.com',
        changeOrigin: true,
        rewrite: (path) => {
          const url = new URL('http://localhost' + path);
          const apiPath = url.searchParams.get('path') || '';
          url.searchParams.delete('path');
          // Add API key for local dev (set VITE_ODDS_API_KEY in .env.local)
          const key = process.env.VITE_ODDS_API_KEY || '';
          if (key) url.searchParams.set('apiKey', key);
          return `/v4/${apiPath}?${url.searchParams.toString()}`;
        },
      },
      '/api/mlb': {
        target: 'https://statsapi.mlb.com',
        changeOrigin: true,
        rewrite: (path) => {
          const url = new URL('http://localhost' + path);
          const apiPath = url.searchParams.get('path') || '';
          url.searchParams.delete('path');
          return `/${apiPath}?${url.searchParams.toString()}`;
        },
      },
    },
  },
})
