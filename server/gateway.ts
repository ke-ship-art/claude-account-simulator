import type { IncomingMessage, ServerResponse } from 'node:http'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { providerConfigPath, readProviderConfig, writeProviderConfig } from './providerStore'

type Kind = 'offline' | 'anthropic' | 'openai' | 'ollama'
type Config = { kind: Kind; baseUrl: string; apiKey: string; modelMap: Record<string, string>; effort: 'low' | 'medium' | 'high'; trustedOllamaEndpoints: string[] }
type StreamResult = { outcome: 'normal' | 'model_refusal' | 'provider_block' | 'network_error' | 'service_error' | 'stream_interrupted'; message?: string }
const MAX_BODY = 1_000_000
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const DEFAULT: Config = { kind: 'offline', baseUrl: '', apiKey: '', modelMap: {}, effort: 'medium', trustedOllamaEndpoints: [] }

function restoredConfig(value: unknown): Config {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('本机模型配置内容无效。')
  const saved = value as Partial<Config>
  if (!saved.kind || !['offline','anthropic','openai','ollama'].includes(saved.kind) || typeof saved.baseUrl !== 'string' || typeof saved.apiKey !== 'string' || saved.apiKey.length > 4000
    || !saved.modelMap || typeof saved.modelMap !== 'object' || Array.isArray(saved.modelMap)
    || Object.entries(saved.modelMap).some(([key, model]) => !/^[a-z0-9-]{1,100}$/i.test(key) || typeof model !== 'string' || model.length > 150)
    || !['low','medium','high'].includes(String(saved.effort)) || !Array.isArray(saved.trustedOllamaEndpoints)
    || saved.trustedOllamaEndpoints.some(endpoint => typeof endpoint !== 'string' || endpoint.length > 300)) throw new Error('本机模型配置内容无效。')
  return saved as Config
}

function privateOllamaHost(host: string) {
  if (isIP(host) !== 4) return false
  const [a,b] = host.split('.').map(Number)
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
}

function publicAddress(address: string) {
  if (address.includes(':')) {
    const first = Number.parseInt(address.split(':')[0], 16)
    return first >= 0x2000 && first <= 0x3fff && !/^2001:(?:0:|db8:)/i.test(address)
  }
  const [a,b,c] = address.split('.').map(Number)
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 192 && b === 0 || a === 198 && (b === 18 || b === 19) || a === 100 && b >= 64 && b <= 127 || a === 192 && b === 0 && c === 0)
}

export async function validateBaseUrl(kind: Kind, input: string, trustedOllamaEndpoints: string[] = [], resolveHost: (host: string) => Promise<Array<{ address: string }>> = host => lookup(host, { all: true, verbatim: true })): Promise<string> {
  if (kind === 'offline') return ''
  const raw = input.trim() || (kind === 'anthropic' ? 'https://api.anthropic.com' : kind === 'ollama' ? 'http://127.0.0.1:11434' : '')
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('请输入有效的模型服务地址。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('模型服务地址只能包含协议、主机、端口和路径。')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (kind === 'anthropic' && host !== 'api.anthropic.com') throw new Error('Anthropic API 仅允许 api.anthropic.com。测试其他端点请使用 OpenAI 兼容模式。')
  if (kind === 'anthropic' && !['/', '/v1'].includes(url.pathname)) throw new Error('Anthropic API 地址应为 https://api.anthropic.com 或其 /v1 路径。')
  const local = LOOPBACK.has(host)
  if (kind === 'ollama' && url.pathname !== '/') throw new Error('Ollama 地址只需协议、主机和端口。')
  const trustedOllama = kind === 'ollama' && privateOllamaHost(host) && url.port === '11434' && url.pathname === '/' && trustedOllamaEndpoints.includes(url.origin)
  if (kind === 'ollama' && !local && !trustedOllama) throw new Error('WSL2 / 局域网 Ollama 仅允许显式信任的私有 IP:11434。')
  if (trustedOllama) return url.origin
  if (!local && url.protocol !== 'https:') throw new Error('远程模型服务必须使用 HTTPS。')
  if (!local) {
    const addresses = isIP(host) ? [{ address: host }] : await resolveHost(host)
    if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('模型服务地址解析到内网或保留地址，已拒绝连接。')
  }
  if (kind === 'anthropic') return url.origin
  return url.toString().replace(/\/$/, '')
}

async function bodyJson(req: IncomingMessage): Promise<unknown> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new Error('请求必须是 JSON。')
  let text = ''
  for await (const chunk of req) {
    text += chunk.toString()
    if (text.length > MAX_BODY) throw new Error('请求内容过大。')
  }
  try { return JSON.parse(text) } catch { throw new Error('请求 JSON 无效。') }
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}
function event(res: ServerResponse, value: object) { if (!res.destroyed) res.write(`${JSON.stringify(value)}\n`) }
function messageFromError(error: unknown): StreamResult {
  if (error instanceof Error && error.name === 'AbortError') return { outcome: 'network_error', message: '模型连接超时或已中断。' }
  return { outcome: 'network_error', message: '无法连接所配置的模型服务。请检查地址、网络和本机网关。' }
}

async function errorExcerpt(response: Response, controller: AbortController): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader(), decoder = new TextDecoder()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  let excerpt = ''
  try {
    while (excerpt.length < 1000) {
      const { done, value } = await reader.read()
      if (done) break
      excerpt += decoder.decode(value, { stream: true })
    }
    return excerpt.slice(0, 1000)
  } finally {
    clearTimeout(timeout)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function parseLine(kind: Kind, raw: string, push: (text: string) => void): { done?: boolean; outcome?: StreamResult['outcome']; error?: string } {
  if (raw === '[DONE]') return { done: true }
  let value: any
  try { value = JSON.parse(raw) } catch { return {} }
  if (value.type === 'error' || value.error) return { error: typeof value.error?.message === 'string' ? value.error.message : '模型服务返回流错误。' }
  if (kind === 'anthropic') {
    if (value.type === 'content_block_delta' && value.delta?.type === 'text_delta' && typeof value.delta.text === 'string') push(value.delta.text)
    if (value.type === 'message_delta' && value.delta?.stop_reason === 'refusal') return { outcome: 'model_refusal' }
    if (value.type === 'message_stop') return { done: true }
  } else if (kind === 'openai') {
    const choice = value.choices?.[0]
    if (typeof choice?.delta?.content === 'string') push(choice.delta.content)
    if (choice?.finish_reason === 'content_filter') return { done: true, outcome: 'provider_block' }
    if (choice?.finish_reason) return { done: true }
  } else if (kind === 'ollama') {
    if (typeof value.message?.content === 'string') push(value.message.content)
    if (value.done === true) return { done: true }
  }
  return {}
}

async function forward(config: Config, payload: any, res: ServerResponse, controller: AbortController): Promise<void> {
  const model = String(payload.model ?? '')
  const actualModel = (Object.hasOwn(config.modelMap, model) ? config.modelMap[model] : '') || (config.kind === 'anthropic' && /^[a-z0-9-]{1,100}$/i.test(model) ? model : '')
  if (typeof actualModel !== 'string' || !actualModel || actualModel.length > 150) throw new Error('当前模型尚未配置实际调用 ID。')
  if (config.kind !== 'ollama' && !config.apiKey) throw new Error('请先在 DevTools 配置 API 密钥。')
  if (!Array.isArray(payload.messages) || payload.messages.length > 80) throw new Error('对话历史格式无效。')
  const messages = payload.messages.map((m: any) => {
    if (!m || !['user','assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 300_000) throw new Error('消息内容格式无效。')
    return { role: m.role, content: m.content }
  })
  const root = await validateBaseUrl(config.kind, config.baseUrl, config.trustedOllamaEndpoints)
  const url = root + (config.kind === 'anthropic' ? '/v1/messages' : config.kind === 'ollama' ? '/api/chat' : '/chat/completions')
  const headers: Record<string,string> = { 'content-type': 'application/json' }
  let requestBody: object = { model: actualModel, messages, stream: true }
  if (config.kind === 'anthropic') {
    headers['x-api-key'] = config.apiKey
    headers['anthropic-version'] = '2023-06-01'
    requestBody = { ...requestBody, max_tokens: 4096, output_config: { effort: config.effort } }
  } else if (config.kind === 'openai') headers.authorization = `Bearer ${config.apiKey}`
  const timeout = setTimeout(() => controller.abort(), 30_000)
  let upstream: Response
  try { upstream = await fetch(url, { method: 'POST', headers, body: JSON.stringify(requestBody), signal: controller.signal, redirect: 'error' }) }
  finally { clearTimeout(timeout) }
  if (!upstream.ok) {
    const body = await errorExcerpt(upstream, controller)
    const blocked = /content[_ -]?filter|safety|policy/i.test(body)
    const outcome = blocked ? 'provider_block' : 'service_error'
    const message = blocked ? '模型服务拒绝了这次请求。' : `模型服务返回 HTTP ${upstream.status}。`
    json(res, 200, { outcome, message, status: upstream.status })
    return
  }
  if (!upstream.body) { json(res, 200, { outcome: 'service_error', message: '模型服务没有返回可读取的流。' }); return }
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = '', completed = false, outcome: StreamResult['outcome'] = 'normal', streamed = false
  let idleTimeout: ReturnType<typeof setTimeout>
  const refreshTimeout = () => { clearTimeout(idleTimeout); idleTimeout = setTimeout(() => controller.abort(), 30_000) }
  const push = (text: string) => { if (text) { streamed = true; event(res, { type: 'delta', text }) } }
  try {
    refreshTimeout()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      refreshTimeout()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const raw = line.startsWith('data:') ? line.slice(5).trim() : config.kind === 'ollama' ? line.trim() : ''
        if (!raw) continue
        const result = parseLine(config.kind, raw, push)
        if (result.outcome) outcome = result.outcome
        if (result.error) { event(res, { type: 'done', outcome: 'service_error', message: result.error }); res.end(); return }
        if (result.done) completed = true
      }
    }
    if (buffer.trim()) {
      const raw = buffer.startsWith('data:') ? buffer.slice(5).trim() : config.kind === 'ollama' ? buffer.trim() : ''
      if (raw) { const result = parseLine(config.kind, raw, push); if (result.outcome) outcome = result.outcome; if (result.done) completed = true }
    }
    event(res, { type: 'done', outcome: completed ? outcome : 'stream_interrupted', message: completed ? undefined : streamed ? '模型流提前中断，已保留收到的内容。' : '模型流未完整结束。' })
  } catch (error) {
    if (!res.destroyed) event(res, { type: 'done', ...messageFromError(error) })
  } finally { clearTimeout(idleTimeout!); reader.releaseLock(); if (!res.destroyed) res.end() }
}

export function createGateway(configPath = providerConfigPath()) {
  let config: Config = { ...DEFAULT }
  let persisted = false
  let loadFailure = ''
  const ready = readProviderConfig(configPath).then(saved => { if (saved) { config = restoredConfig(saved); persisted = true } }).catch(error => { loadFailure = error instanceof Error ? error.message : '无法读取本机模型配置。' })
  return async (req: IncomingMessage, res: ServerResponse, next: (error?: Error) => void) => {
    if (!req.url?.startsWith('/api/')) return next()
    const host = String(req.headers.host ?? '')
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host) || req.headers.origin && req.headers.origin !== `http://${host}`) { json(res, 403, { error: '仅允许从本机应用访问。' }); return }
    await ready
    try {
      if (req.method === 'GET' && req.url === '/api/provider') {
        if (loadFailure) { json(res, 500, { error: `读取本机模型配置失败：${loadFailure} 可重新保存配置以覆盖损坏文件。` }); return }
        const { apiKey: _key, ...safe } = config
        json(res, 200, { ...safe, hasKey: Boolean(config.apiKey), storedOnDisk: persisted, trustCurrentOllamaEndpoint: config.trustedOllamaEndpoints.includes(config.baseUrl) })
      } else if (req.method === 'POST' && req.url === '/api/provider') {
        const input = await bodyJson(req) as any
        if (!input || !['offline','anthropic','openai','ollama'].includes(input.kind)) throw new Error('提供方类型无效。')
        const requested = String(input.baseUrl ?? '')
        const requestedUrl = (()=>{try{return new URL(requested)}catch{return undefined}})()
        const trustedOllamaEndpoints = input.kind === 'ollama' && input.trustCurrentOllamaEndpoint === true && requestedUrl && privateOllamaHost(requestedUrl.hostname) && requestedUrl.port === '11434' && requestedUrl.pathname === '/' ? [requestedUrl.origin] : []
        const baseUrl = await validateBaseUrl(input.kind, requested, trustedOllamaEndpoints)
        const modelMap = Object.fromEntries(Object.entries(input.modelMap ?? {}).filter(([key,value]) => /^[a-z0-9-]{1,100}$/i.test(key) && typeof value === 'string' && value.length <= 150)) as Record<string,string>
        const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : config.kind === input.kind && config.baseUrl === baseUrl ? config.apiKey : ''
        if (apiKey.length > 4000) throw new Error('API 密钥过长。')
        const next: Config = { kind: input.kind, baseUrl, apiKey, modelMap, effort: ['low','medium','high'].includes(input.effort) ? input.effort : 'medium', trustedOllamaEndpoints }
        try { await writeProviderConfig(next, configPath) }
        catch { json(res, 500, { error: '无法将模型配置保存到当前系统用户的数据目录。请检查磁盘空间和文件访问权限。' }); return }
        config = next
        persisted = true
        loadFailure = ''
        const { apiKey: _key, ...safe } = config
        json(res, 200, { ...safe, hasKey: Boolean(config.apiKey), storedOnDisk: true, trustCurrentOllamaEndpoint: config.trustedOllamaEndpoints.includes(config.baseUrl) })
      } else if (req.method === 'POST' && req.url === '/api/chat') {
        if (config.kind === 'offline') throw new Error('网关尚未配置模型服务。')
        const payload = await bodyJson(req)
        const controller = new AbortController()
        res.on('close', () => { if (!res.writableEnded) controller.abort() })
        try { await forward(config, payload, res, controller) }
        catch (error) { if (!res.headersSent) { const network = error instanceof TypeError || error instanceof Error && error.name === 'AbortError'; json(res, 200, network ? messageFromError(error) : { outcome: 'service_error', message: error instanceof Error ? error.message : '模型服务请求失败。' }) } else { event(res, { type: 'done', ...messageFromError(error) }); res.end() } }
      } else json(res, 404, { error: '未找到接口。' })
    } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : '请求无效。' }) }
  }
}
