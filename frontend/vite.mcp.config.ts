import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: 'dist/mcp-app',
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL('./src/codex/main.tsx', import.meta.url)),
      name: 'FlowTestLiteWorkbench',
      formats: ['iife'],
      fileName: () => 'workbench.js',
    },
  },
})
