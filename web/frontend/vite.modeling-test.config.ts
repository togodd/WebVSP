import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Explicitly configured WASM source; this test server never replaces the deployed service.
const wasmOrigin = process.env.WEBVSP_TEST_WASM_ORIGIN
if (!wasmOrigin) throw new Error('Set WEBVSP_TEST_WASM_ORIGIN to a trusted WebVSP server')
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5178,
    strictPort: true,
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    proxy: { '/wasm': { target: wasmOrigin, changeOrigin: true } },
  },
})
