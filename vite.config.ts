import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { createGateway } from './server/gateway'

const gateway = createGateway()

export default defineConfig({
  plugins: [react(), { name: 'local-model-gateway', configureServer(server) { server.middlewares.use(gateway) }, configurePreviewServer(server) { server.middlewares.use(gateway) } }],
  test: { environment: 'node', include: ['src/**/*.test.ts'], maxWorkers: 1 },
})
