import { resolve } from 'path'
import { defineConfig } from 'vite'
import checker from 'vite-plugin-checker'
import dts from 'vite-plugin-dts'

export default defineConfig({
  plugins: [checker({ typescript: true }), dts()],
  build: {
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'Signals',
      fileName: 'signals',
    },
  },
  test: {
    globals: true,
    include: ['src/**/*.test.ts?(x)'],
  },
})
