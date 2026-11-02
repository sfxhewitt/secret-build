/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'single' ? [viteSingleFile()] : [],
  // Allow previewing through an HTTPS tunnel (needed for the mic on phones).
  preview: { host: true, allowedHosts: true },
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    target: 'es2022',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
}));
