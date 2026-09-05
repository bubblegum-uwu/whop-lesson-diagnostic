/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
//
// `base` must match your GitHub Pages repo name, e.g. '/whop-lesson-diagnostic/'.
// Set it via the VITE_BASE_PATH env var at build time (see the GitHub Actions
// workflow and README for details). Defaults to '/' for local dev.
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    exclude: ['**/node_modules/**', '**/backend/**'],
  },
})
