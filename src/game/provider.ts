import type { Message, MessageOutcome, Model } from './types'

export type ProviderKind = 'offline' | 'anthropic' | 'openai' | 'ollama'
export interface ProviderConfig { kind: ProviderKind; baseUrl: string; modelMap: Partial<Record<Model, string>>; effort?: 'low' | 'medium' | 'high'; hasKey?: boolean; storedOnDisk?: boolean; trustCurrentOllamaEndpoint?: boolean; trustedOllamaEndpoints?: string[] }
export type ProviderResponse = { text: string; outcome: MessageOutcome; message?: string }
export const DEFAULT_PROVIDER: ProviderConfig = { kind: 'offline', baseUrl: '', modelMap: {}, effort: 'medium', hasKey: false }

export async function loadProvider(): Promise<ProviderConfig> {
  // Remove credentials left by older versions. Credentials now live only in the Node gateway process.
  try { sessionStorage.removeItem('claude-simulator-provider-session') } catch { /* storage can be disabled */ }
  const response = await fetch('/api/provider', { cache: 'no-store' })
  if (!response.ok) {
    const result = await response.json().catch(() => null)
    throw new Error(result?.error ?? '本机模型网关不可用。请通过项目启动脚本重新打开网站。')
  }
  return { ...DEFAULT_PROVIDER, ...await response.json() }
}

export async function saveProvider(config: ProviderConfig, apiKey = ''): Promise<ProviderConfig> {
  const response = await fetch('/api/provider', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...config, apiKey }) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? '无法保存模型服务配置。')
  return { ...DEFAULT_PROVIDER, ...result }
}

function asOutcome(value: unknown): MessageOutcome {
  return ['normal','model_refusal','provider_block','network_error','service_error','cancelled','stream_interrupted'].includes(String(value)) ? value as MessageOutcome : 'service_error'
}

export async function streamChat(config: ProviderConfig, model: Model, history: Message[], onDelta: (text: string) => void, signal: AbortSignal): Promise<ProviderResponse> {
  if (config.kind === 'offline') {
    const reply = '离线体验模式已记录你的消息和用量。要获得真正的智能回复，请在本地开发者工具中配置 Anthropic、OpenAI 兼容服务或 Ollama。'
    for (const part of reply.match(/.{1,12}/gu) ?? []) {
      if (signal.aborted) throw new DOMException('已停止生成', 'AbortError')
      onDelta(part)
      await new Promise(resolve => setTimeout(resolve, 24))
    }
    return { text: reply, outcome: 'normal' }
  }
  const messages = history.filter(m => m.text.trim() || m.attachment?.text).map(m => ({
    role: m.role,
    content: m.attachment?.text ? `${m.text}\n\n[文本附件：${m.attachment.name}]\n${m.attachment.text}`.trim() : m.text,
  }))
  let response: Response
  try {
    response = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages }), signal })
  } catch (error) {
    if (signal.aborted) throw new DOMException('已停止生成', 'AbortError')
    return { text: '', outcome: 'network_error', message: error instanceof Error ? error.message : '本机网关连接失败。' }
  }
  if (!response.ok) return { text: '', outcome: 'service_error', message: `本机网关返回 HTTP ${response.status}。` }
  if (response.headers.get('content-type')?.includes('application/json')) {
    const result = await response.json()
    return { text: '', outcome: asOutcome(result.outcome), message: String(result.message ?? result.error ?? '模型服务未返回内容。') }
  }
  if (!response.body) return { text: '', outcome: 'service_error', message: '模型网关没有返回可读取的流。' }
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', text = '', outcome: MessageOutcome = 'stream_interrupted', message: string | undefined
  function consume(line: string) {
    if (!line.trim()) return
    let event: { type?: string; text?: string; outcome?: unknown; message?: string }
    try { event = JSON.parse(line) } catch { return }
    if (event.type === 'delta' && typeof event.text === 'string') { text += event.text; onDelta(event.text) }
    if (event.type === 'done') { outcome = asOutcome(event.outcome); message = event.message }
  }
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('已停止生成', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      lines.forEach(consume)
    }
    consume(buffer)
  } catch (error) {
    if (signal.aborted) throw new DOMException('已停止生成', 'AbortError')
    return { text, outcome: 'network_error', message: error instanceof Error ? error.message : '模型流连接失败。' }
  } finally { reader.releaseLock() }
  return { text, outcome, message }
}
