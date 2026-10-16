import { test, expect } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import { createServer as createSocket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

async function freePort() {
  const socket = createSocket()
  socket.listen(0,'127.0.0.1')
  await once(socket,'listening')
  const port = (socket.address() as {port:number}).port
  await new Promise<void>(done => socket.close(() => done()))
  return port
}
async function startGateway(port: number, configPath: string) {
  const child = spawn(process.execPath,[resolve('node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(port),'--strictPort'],{
    cwd:process.cwd(), env:{...process.env,CLAUDE_SIM_CONFIG_PATH:configPath},stdio:'ignore',windowsHide:true,
  })
  const url = `http://127.0.0.1:${port}`
  for (let attempt=0;attempt<120;attempt++) {
    if (child.exitCode !== null) throw new Error('测试网关在就绪前退出。')
    try { if ((await fetch(`${url}/api/provider`,{signal:AbortSignal.timeout(500)})).ok) return {child,url} } catch { /* wait for Vite */ }
    await new Promise(done => setTimeout(done,100))
  }
  child.kill()
  throw new Error('测试网关未在 12 秒内就绪。')
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null) return
  const exited = once(child,'exit')
  child.kill()
  await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(new Error('测试网关未能关闭。')),5000))])
}

test('a full Node gateway restart restores protected model configuration and credential', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(),'claude-provider-restart-'))
  const file = join(directory,'provider-config.dat')
  const port = await freePort()
  let first: ChildProcess | undefined, second: ChildProcess | undefined
  let receivedAuthorization = ''
  const model = createServer(async (req,res) => {
    receivedAuthorization = String(req.headers.authorization ?? '')
    for await (const _chunk of req) { /* consume */ }
    res.writeHead(200,{'content-type':'text/event-stream'})
    res.end('data: {"choices":[{"delta":{"content":"重启恢复成功"}}]}\n\ndata: [DONE]\n\n')
  })
  model.listen(0,'127.0.0.1')
  await once(model,'listening')
  const modelPort = (model.address() as {port:number}).port
  try {
    const running = await startGateway(port,file)
    first = running.child
    const saved = await fetch(`${running.url}/api/provider`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'openai',baseUrl:`http://127.0.0.1:${modelPort}/v1`,apiKey:'restart-test-key',modelMap:{'claude-sonnet-5-5':'mock'},effort:'medium'})})
    expect(saved.status).toBe(200)
    expect((await saved.json()).storedOnDisk).toBe(true)
    await stop(first); first = undefined
    const restored = await startGateway(port,file)
    second = restored.child
    const settings = await fetch(`${restored.url}/api/provider`).then(response=>response.json())
    expect(settings).toMatchObject({kind:'openai',hasKey:true,storedOnDisk:true,modelMap:{'claude-sonnet-5-5':'mock'}})
    expect(JSON.stringify(settings)).not.toContain('restart-test-key')
    const answer = await fetch(`${restored.url}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'claude-sonnet-5-5',messages:[{role:'user',content:'测试'}]})})
    expect(await answer.text()).toContain('重启恢复成功')
    expect(receivedAuthorization).toBe('Bearer restart-test-key')
  } finally {
    await stop(first); await stop(second)
    model.closeAllConnections(); await new Promise<void>(done=>model.close(()=>done()))
    if (!resolve(directory).startsWith(resolve(tmpdir())+sep)) throw new Error('临时目录不在系统临时文件夹内。')
    await fs.rm(directory,{recursive:true,force:true})
  }
})
