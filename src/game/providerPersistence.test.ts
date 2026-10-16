import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createGateway } from '../../server/gateway'
import { writeProviderConfig } from '../../server/providerStore'

const servers: Server[] = []
async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  servers.push(server)
  return `http://127.0.0.1:${(server.address() as {port:number}).port}`
}
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()) })
})

describe('durable local provider configuration', () => {
  it('reports a damaged protected configuration instead of silently accepting malformed mappings', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'claude-provider-damage-'))
    const file = join(directory, 'provider-config.dat')
    try {
      await writeProviderConfig({kind:'openai',baseUrl:'http://127.0.0.1:1234/v1',apiKey:'test',modelMap:{'claude-sonnet-5-5':42},effort:'medium',trustedOllamaEndpoints:[]},file)
      const gateway = createGateway(file)
      const url = await listen(createServer((req,res) => { void gateway(req,res,()=>{res.writeHead(404);res.end()}) }))
      const response = await fetch(`${url}/api/provider`)
      expect(response.status).toBe(500)
      expect((await response.json()).error).toContain('配置内容无效')
    } finally {
      if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('临时目录不在系统临时文件夹内。')
      await fs.rm(directory,{recursive:true,force:true})
    }
  }, 30_000)
  it('restores a protected key and model mapping in a new gateway instance', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'claude-provider-test-'))
    const file = join(directory, 'provider-config.dat')
    try {
      await writeProviderConfig({probe:true},join(directory,'probe.dat'))
      let receivedAuthorization = ''
      const modelUrl = await listen(createServer(async (req,res) => {
        receivedAuthorization = String(req.headers.authorization ?? '')
        for await (const _chunk of req) { /* consume request */ }
        res.writeHead(200, {'content-type':'text/event-stream'})
        res.end('data: {"choices":[{"delta":{"content":"重启后可用"}}]}\n\ndata: [DONE]\n\n')
      }))
      async function gatewayUrl() {
        const gateway = createGateway(file)
        return listen(createServer((req,res) => { void gateway(req,res,()=>{res.writeHead(404);res.end()}) }))
      }
      const first = await gatewayUrl()
      const credential = 'local-persistence-test-secret'
      const saved = await fetch(`${first}/api/provider`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'openai',baseUrl:`${modelUrl}/v1`,apiKey:credential,modelMap:{'claude-sonnet-5-5':'mock'},effort:'high'})})
      const savedBody = await saved.json()
      expect(saved.status, JSON.stringify(savedBody)).toBe(200)
      expect(savedBody).toMatchObject({kind:'openai',hasKey:true,storedOnDisk:true})
      const raw = await fs.readFile(file,'utf8')
      if (process.platform === 'win32') { expect(raw).toContain('windows-dpapi'); expect(raw).not.toContain(credential) }

      const second = await gatewayUrl()
      const restored = await fetch(`${second}/api/provider`)
      expect(await restored.json()).toMatchObject({kind:'openai',baseUrl:`${modelUrl}/v1`,hasKey:true,storedOnDisk:true,effort:'high',modelMap:{'claude-sonnet-5-5':'mock'}})
      const answer = await fetch(`${second}/api/chat`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'claude-sonnet-5-5',messages:[{role:'user',content:'验证重启'}]})})
      expect(await answer.text()).toContain('重启后可用')
      expect(receivedAuthorization).toBe(`Bearer ${credential}`)
    } finally {
      if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('临时目录不在系统临时文件夹内。')
      await fs.rm(directory,{recursive:true,force:true})
    }
  }, 30_000)
})
