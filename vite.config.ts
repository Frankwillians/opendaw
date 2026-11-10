import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  // O repositório carrega .js compilados ao lado dos .ts (emit acidental).
  // Sem isto o Vite resolvia o .js antes do .ts e servia um motor velho.
  resolve: {
    extensions: ['.mts', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
  },
})
