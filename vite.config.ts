import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  // O título do app mostra a versão do package.json, sem cópia manual.
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  // O repositório carrega .js compilados ao lado dos .ts (emit acidental).
  // Sem isto o Vite resolvia o .js antes do .ts e servia um motor velho.
  resolve: {
    extensions: ['.mts', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
  },
})
