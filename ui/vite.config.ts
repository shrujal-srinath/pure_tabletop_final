import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // shared/wire-contract.js lives one level up (box-pi/shared/), outside
    // this project's own root — it's deliberately imported directly rather
    // than duplicated, so Vite's dev server needs to be allowed to serve it.
    fs: { allow: [path.resolve(__dirname, '..')] },
  },
})
