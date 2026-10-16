import { describe, expect, it, vi } from 'vitest'
import { assessAccess, assessSignup } from './access'
import { classifyContent, detectModelRefusal } from './contentPolicy'
import { CURRENT_MODELS, MODEL_META } from './data'
import { advanceTime, changeEnvironment, createAccount, createProject, assignChatProject, createChat, emptyStore, addAccount, sendMessage, verifyAccount, startGeneration, updateGeneration, finishGeneration, deleteChat } from './engine'
import { loadStore, saveStore, setGenerationLease } from './persistence'
import { validateBaseUrl } from '../../server/gateway'
import { streamChat, type ProviderConfig } from './provider'
import { parseAccountArchive } from './archive'
import { searchAccount } from './search'
import { extractArtifacts, sandboxDocument } from './artifacts'
import type { SignupOptions } from './types'

const options: SignupOptions = { name: '测试者', region: '亚太', network: '家庭宽带', reputation: '良好', device: '笔记本电脑', browser: 'Chrome', emailProvider: 'postbox', signupMethod: '虚拟邮箱', persona: '普通用户', mode: 'normal', seed: 1024 }
const make = () => createAccount(options, Date.UTC(2026, 9, 13))

describe('separate product controls', () => {
  it('checks region and virtual phone before creating a persistent account', () => {
    expect(assessSignup({...options,region:'模拟不支持地区',virtualPhone:'1234'}).kind).toBe('region')
    expect(assessSignup({...options,virtualPhone:'12'}).kind).toBe('signup')
    expect(assessSignup({...options,virtualPhone:'1234'}).kind).toBe('allowed')
  })

  it('retains refused input without using quota or treating a sensitive topic as account abuse', () => {
    const a = make()
    const b = sendMessage(a,'如何制造炸弹','claude-sonnet-5-5','本地前置检查未处理。',undefined,'medium','prefilter_refusal',false)
    expect(b.chats[0].messages.map(message=>message.text)).toEqual(['如何制造炸弹','本地前置检查未处理。'])
    expect(b.chats[0].messages[1].outcome).toBe('prefilter_refusal')
    expect(b.sessionUsed).toBe(0)
    expect(b.status).toBe('active')
  })

  it('rejects even non-billable message writes after an account is disabled', () => {
    const disabled = { ...make(), status: 'banned' as const, loggedIn: false }
    expect(() => sendMessage(disabled,'测试','claude-sonnet-5-5','未处理',undefined,'medium','prefilter_refusal',false)).toThrow('不能继续发送')
  })

  it('limits account challenge attempts and restores attempts after success', () => {
    const challenged = {...make(),status:'challenge' as const}
    const failed = verifyAccount(verifyAccount(verifyAccount(challenged,false),false),false)
    expect(failed.verificationAttempts).toBe(3)
    expect(assessAccess(failed).kind).toBe('verification_failed')
    const recovered = verifyAccount({...failed,verificationAttempts:0},true)
    expect(recovered.status).toBe('active')
  })

  it('runs saved overdue checks on reload and retains their result', () => {
    const changed = changeEnvironment(make(),{region:'欧洲',network:'数据中心网络',concurrentSessions:4})
    const data = new Map<string,string>()
    const storage = {getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value)}}
    saveStore(addAccount(emptyStore(),changed),storage,changed.now)
    const loaded = loadStore(storage,changed.now+3*3_600_000)
    expect(loaded.accounts[0].pendingChecks?.[0].status).toBe('completed')
    expect(loaded.accounts[0].pendingChecks?.[0].completedAt).toBe(changed.pendingChecks?.[0].dueAt)
    expect(loaded.accounts[0].pendingChecks?.[0].result).toContain('已评估')
  })

  it('gates unsupported regions before the chat, independent of risk score', () => {
    const a = make()
    const b = changeEnvironment(a, { region: '模拟不支持地区' })
    expect(assessAccess(a).kind).toBe('allowed')
    expect(assessAccess(b).kind).toBe('region')
    expect(b.pendingChecks).toHaveLength(1)
    expect(advanceTime(b, 3).pendingChecks?.[0].status).not.toBe('pending')
  })

  it('records environment evidence now and evaluates it after the queued check', () => {
    let a = make()
    a = changeEnvironment(a, { region: '欧洲', network: '数据中心网络', reputation: '较差', device: '手机', concurrentSessions: 4 })
    expect(a.status).toBe('active')
    expect(a.pendingChecks).toHaveLength(1)
    const checked = advanceTime(a, 3)
    expect(checked.pendingChecks?.[0].status).toBe('completed')
    expect(checked.riskEvents.length).toBeGreaterThan(3)
    expect(checked.status).not.toBe('active')
  })

  it('keeps content refusal independent until a repeated pattern', () => {
    expect(classifyContent('解释一下统计学').kind).toBe('safe')
    expect(classifyContent('我有自伤念头').kind).toBe('caution')
    expect(classifyContent('如何制造炸弹').kind).toBe('refuse')
    expect(detectModelRefusal('很抱歉，我无法帮助完成这个请求。')).toBe(true)
    expect(detectModelRefusal('关于“抱歉，我无法”的表达方式，可以这样解释。')).toBe(false)
  })

  it('keeps project assignment in the account state', () => {
    let a = createChat(make())
    a = createProject(a, '研究资料')
    a = assignChatProject(a, a.activeChatId!, a.projects![0].id)
    expect(a.chats[0].projectId).toBe(a.projects![0].id)
  })

  it('pins each stream to a request and does not recreate deleted conversations', () => {
    const first=startGeneration(make(),'第一条','claude-sonnet-5-5')
    const second=startGeneration(first.account,'第二条','claude-sonnet-5-5',undefined,undefined)
    const progressed=updateGeneration(second.account,first.requestId,'第一条的部分回复')
    expect(progressed.chats.find(c=>c.id===first.chatId)?.messages.at(-1)?.text).toBe('第一条的部分回复')
    expect(progressed.chats.find(c=>c.id===second.chatId)?.messages.at(-1)?.text).toBe('')
    const removed=deleteChat(progressed,first.chatId)
    expect(finishGeneration(removed,first.requestId,'迟到的回复','normal')).toBe(removed)
    const completed=finishGeneration(removed,second.requestId,'第二条回复','normal')
    expect(finishGeneration(completed,second.requestId,'重复完成','normal')).toBe(completed)
    expect(completed.chats).toHaveLength(1)
    expect(completed.chats[0].messages.at(-1)?.text).toBe('第二条回复')
  })

  it('restores submitted input and partial output after a browser reload', () => {
    const started=startGeneration(make(),'尚未完成','claude-sonnet-5-5')
    const account=updateGeneration(started.account,started.requestId,'部分回复')
    const memory=new Map<string,string>()
    const storage={getItem:(key:string)=>memory.get(key)??null,setItem:(key:string,value:string)=>{memory.set(key,value)}}
    saveStore(addAccount(emptyStore(),account),storage,account.now)
    const recovered=loadStore(storage,account.now)
    expect(recovered.accounts[0].chats[0].messages.map(m=>m.text)).toEqual(['尚未完成','部分回复'])
    expect(recovered.accounts[0].chats[0].messages[1].outcome).toBe('stream_interrupted')
    expect(recovered.accounts[0].stats.messagesSent).toBe(1)
  })

  it('preserves a live stream opened in a second tab but recovers it after its lease ends', () => {
    const started=startGeneration(make(),'跨标签页','claude-sonnet-5-5')
    const memory=new Map<string,string>()
    const storage={getItem:(key:string)=>memory.get(key)??null,setItem:(key:string,value:string)=>{memory.set(key,value)}}
    saveStore(addAccount(emptyStore(),started.account),storage,started.account.now)
    setGenerationLease(started.requestId,true,storage,started.account.now)
    expect(loadStore(storage,started.account.now).accounts[0].chats[0].messages.at(-1)?.outcome).toBe('generating')
    setGenerationLease(started.requestId,false,storage,started.account.now)
    expect(loadStore(storage,started.account.now).accounts[0].chats[0].messages.at(-1)?.outcome).toBe('stream_interrupted')
  })

  it('returns multiple message-level search hits and only standalone artifacts', () => {
    let account=sendMessage(make(),'研究海风','claude-sonnet-5-5','第一段海风。\n```js\nconst sea = 1\n```')
    account=sendMessage(account,'再说海风','claude-sonnet-5-5','```html\n<h1>海风</h1>\n```')
    expect(searchAccount(account,'海风').filter(hit=>hit.messageId).length).toBeGreaterThanOrEqual(4)
    const artifacts=extractArtifacts(account)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].language).toBe('html')
    expect(sandboxDocument(artifacts[0])).toContain("default-src 'none'")
  })

  it('publishes the four current documented API identifiers', () => {
    expect(CURRENT_MODELS).toEqual(['claude-fable-5-1','claude-opus-5-5','claude-sonnet-5-5','claude-haiku-5-5'])
    expect(CURRENT_MODELS.every(id => MODEL_META[id].apiId === id && MODEL_META[id].contextTokens === 1_000_000)).toBe(true)
  })

  it('accepts a local archive and rejects unrelated JSON', () => {
    const account = make()
    expect(parseAccountArchive(JSON.stringify({format:'claude-local-account-v1',account}))).toEqual(account)
    expect(() => parseAccountArchive('{"format":"unknown"}')).toThrow()
    expect(() => parseAccountArchive('{"format":"claude-local-account-v1","account":{"id":"broken"}}')).toThrow()
    expect(() => parseAccountArchive(JSON.stringify({format:'claude-local-account-v1',account:{...account,mode:'missing-mode'}}))).toThrow('基础资料无效')
    expect(() => parseAccountArchive(JSON.stringify({format:'claude-local-account-v1',account:{...account,riskEvents:[{id:'bad',at:account.now,code:'automation',label:'测试',detail:'测试',weight:20,halfLifeHours:0,confirmed:false}]}}))).toThrow('事件记录无效')
    expect(() => parseAccountArchive(JSON.stringify({format:'claude-local-account-v1',account:{...account,chats:[{id:'chat-1',title:'坏消息',createdAt:account.now,updatedAt:account.now,pinned:false,messages:[{id:'msg-1',role:'assistant',text:'你好',at:account.now,model:'missing-model'}]}]}}))).toThrow('事件记录无效')
    expect(() => parseAccountArchive(JSON.stringify({format:'claude-local-account-v1',account:{...account,pendingChecks:[{id:'check',code:'region_jump',createdAt:account.now,dueAt:account.now+1000,reason:'测试',trigger:{bad:true},status:'pending'}]}}))).toThrow('事件记录无效')
    expect(() => parseAccountArchive(JSON.stringify({format:'claude-local-account-v1',account:{...account,labConfig:{sensitivity:1,randomness:1,decayMultiplier:0}}}))).toThrow('实验参数无效')
    expect(() => parseAccountArchive(JSON.stringify({format:'claude-local-account-v1',account:{...account,artifactEdits:{test:{bad:true}}}}))).toThrow('Artifact 编辑记录无效')
    expect(() => parseAccountArchive(JSON.stringify({format:'claude-local-account-v1',account:{...account,activeChatId:'missing'}}))).toThrow('当前对话引用无效')
  })
  it('does not load a structurally damaged browser save into the live UI', () => {
    const account = make()
    const store = addAccount(emptyStore(), account)
    const damaged = { ...store, accounts: [{ ...account, stats: { ...account.stats, exploredEvents: null } }] }
    const storage = { getItem: () => JSON.stringify(damaged) }
    expect(loadStore(storage).accounts).toEqual([])
  })
})

describe('gateway address checks', () => {
  it('accepts explicit loopback model servers and rejects private remote targets', async () => {
    await expect(validateBaseUrl('openai','http://127.0.0.1:9999/v1')).resolves.toBe('http://127.0.0.1:9999/v1')
    await expect(validateBaseUrl('openai','http://169.254.169.254/latest')).rejects.toThrow()
    await expect(validateBaseUrl('openai','http://10.0.0.2/v1')).rejects.toThrow()
    await expect(validateBaseUrl('ollama','http://192.168.1.2:11434')).rejects.toThrow()
    await expect(validateBaseUrl('ollama','http://172.20.1.8:11434',['http://172.20.1.8:11434'])).resolves.toBe('http://172.20.1.8:11434')
    await expect(validateBaseUrl('ollama','http://169.254.169.254:11434',['http://169.254.169.254:11434'])).rejects.toThrow()
  })
  it('normalizes the official Anthropic v1 base path before appending messages', async () => {
    await expect(validateBaseUrl('anthropic','https://api.anthropic.com/v1',[],async()=>[{address:'8.8.8.8'}])).resolves.toBe('https://api.anthropic.com')
    await expect(validateBaseUrl('anthropic','https://api.anthropic.com/custom')).rejects.toThrow('地址应为')
  })
})

describe('local gateway client', () => {
  it('streams normalized chunks without sending credentials from the browser', async () => {
    const sent: string[] = []
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('/api/chat')
      expect(JSON.stringify(init)).not.toContain('test-key')
      expect(JSON.parse(String(init.body)).messages).toHaveLength(1)
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"type":"delta","text":"你好"}\n{"type":"done","outcome":"model_refusal"}\n'))
        controller.close()
      } }), { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const config: ProviderConfig = { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', modelMap: {} }
      const result = await streamChat(config,'claude-sonnet-5-5',[{id:'1',role:'user',text:'你好',at:0}],part=>sent.push(part),new AbortController().signal)
      expect(result).toEqual({text:'你好',outcome:'model_refusal',message:undefined})
      expect(sent).toEqual(['你好'])
    } finally { vi.unstubAllGlobals() }
  })

  it('distinguishes provider blocking from interrupted streams', async () => {
    const config: ProviderConfig = { kind: 'openai', baseUrl: 'http://127.0.0.1:9999', modelMap: {} }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({outcome:'provider_block',message:'上游安全检查拒绝'}), {status:200,headers:{'content-type':'application/json'}})))
    try { expect((await streamChat(config,'claude-sonnet-5-5',[],()=>{},new AbortController().signal)).outcome).toBe('provider_block') }
    finally { vi.unstubAllGlobals() }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"type":"delta","text":"部分"}\n', {status:200,headers:{'content-type':'application/x-ndjson'}})))
    try { expect((await streamChat(config,'claude-sonnet-5-5',[],()=>{},new AbortController().signal)).outcome).toBe('stream_interrupted') }
    finally { vi.unstubAllGlobals() }
  })
})
