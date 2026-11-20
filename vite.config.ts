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
      // W AI Studio (DISABLE_HMR=true) wyłączamy TYLKO obserwowanie plików, żeby edycje agenta
      // nie wywoływały przeładowań/migotania podglądu. Połączenia HMR WebSocket NIE wyłączamy
      // przez `ws: false` — to odsyłało klienta @vite/client na nieosiągalny port 24678
      // („WebSocket closed without opened” w pętli). Sam socket HMR konfiguruje server.ts
      // (hmr.server = wspólny serwer HTTP, ten sam origin co strona — działa też przez proxy).
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
