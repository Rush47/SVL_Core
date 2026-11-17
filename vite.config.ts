import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('.', import.meta.url)),
      },
      // Jedna kopia Reacta — dwie kopie dają „Cannot read properties of null (reading 'useState')”.
      dedupe: ['react', 'react-dom'],
    },
    optimizeDeps: {
      // Wszystkie zależności frontendu optymalizowane od razu przy starcie. Bez tego Vite
      // dobudowuje je w trakcie sesji (np. przy leniwie ładowanej zakładce), a przy wyłączonym
      // HMR (AI Studio) przeglądarka miesza stare i nowe kopie Reacta.
      entries: ['index.html', 'src/**/*.tsx', '!src/**/*.test.tsx'],
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'lucide-react',
        '@vector-im/compound-web',
      ],
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      ws: process.env.DISABLE_HMR === 'true' ? false : {},
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
