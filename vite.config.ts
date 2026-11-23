import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import {defineConfig, type Plugin} from 'vite';

const hmrDisabled =
  process.env.DISABLE_HMR === 'true' ||
  process.env.CODESPACES === 'true' ||
  process.env.AI_STUDIO === 'true';

/**
 * Podgląd AI Studio (DISABLE_HMR=true): klient Vite nie otwiera WebSocketu.
 * Proxy podglądu zrywa bezczynne WebSockety, a klient Vite po każdym zerwaniu czeka na serwer
 * i robi location.reload() — podgląd przeładowywał się w kółko. Bez HMR to połączenie nic nie
 * daje, więc usuwamy tylko jego otwarcie (style i reszta klienta działają bez zmian).
 */
function noViteClientSocket(): Plugin {
  const CONNECT_CALLS = [
    'transport.connect(createHMRHandler(handleMessage));',
    'setupForwardConsoleHandler(transport, forwardConsole);',
  ];
  return {
    name: 'svl-no-vite-client-socket',
    apply: 'serve',
    enforce: 'post',
    transform(code, id) {
      if (!/vite\/dist\/client\/client\.mjs/.test(id.replace(/\\/g, '/'))) return null;
      if (!CONNECT_CALLS.every((call) => code.includes(call))) {
        this.warn('Nie rozpoznano klienta Vite — WebSocket Vite pozostaje włączony (możliwe przeładowania podglądu).');
        return null;
      }
      return CONNECT_CALLS.reduce((out, call) => out.replace(call, '/* SVL: DISABLE_HMR — bez WebSocketu Vite */'), code);
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), ...(hmrDisabled ? [noViteClientSocket()] : [])],
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
      allowedHosts: true as const,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      ws: hmrDisabled ? false : {},
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: hmrDisabled ? null : {},
    },
  };
});
