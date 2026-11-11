import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
// https://vite.dev/config/
export default defineConfig({
    plugins: [react()],
    base: './',
    // Espelha vite.config.ts: o título do app lê a versão do package.json.
    define: {
        __APP_VERSION__: JSON.stringify(version),
    },
    // Espelha vite.config.ts: prioriza .ts sobre os .js compilados ao lado.
    resolve: {
        extensions: ['.mts', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
    },
});
