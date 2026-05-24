import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { WebSocketServer, WebSocket } from 'ws';

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

function ExtensionReloaderPlugin(isDev: boolean) {
  return {
    name: 'extension-reloader',
    buildStart() {
      // Gate on the actual vite `mode` rather than process.env.NODE_ENV —
      // `vite build --mode development` leaves NODE_ENV unset / production
      // depending on the toolchain, so reading mode directly is the only
      // reliable signal.
      if (!wss && isDev) {
        wss = new WebSocketServer({ port: 8080 });
        wss.on('connection', (ws) => {
          clients.add(ws);
          ws.on('close', () => clients.delete(ws));
          // Without an error listener a socket errored mid-handshake never
          // fires `close` and lingers in the set forever.
          ws.on('error', () => clients.delete(ws));
        });
        console.log('\n⚡ [Extension Reloader] WebSocket Server started on ws://localhost:8080');
      }
    },
    closeBundle() {
      if (wss && clients.size > 0) {
        console.log('⚡ [Extension Reloader] Sending reload signal to extension...');
        for (const client of clients) {
          client.send('reload');
        }
      }
    }
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), ExtensionReloaderPlugin(mode === 'development')],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'index.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      }
    }
  }
}));
