import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: { sourcemap: true },
  server: {
    // Dev hits the same serverless handlers shape as production. Run
    // `vercel dev` for the real functions; this proxy is a thin stand-in.
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
  },
})
