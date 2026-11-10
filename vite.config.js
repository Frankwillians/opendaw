import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
// https://vite.dev/config/
export default defineConfig({
    plugins: [react()],
    base: './',
    // Espelha vite.config.ts: prioriza .ts sobre os .js compilados ao lado.
    resolve: {
        extensions: ['.mts', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
    },
});
