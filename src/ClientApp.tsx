import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowLeft, ArrowRight, Bell, Check, ChevronDown, Copy, CreditCard, Ellipsis, FileText, Folder, LogOut, Menu, MessageSquare, PanelLeftClose, PanelLeftOpen, Paperclip, Plus, Search, Send, ShieldAlert, Sparkles, Square, Trash2, X } from 'lucide-react'
import DevTools from './DevTools'
import Onboarding from './Onboarding'
import { assessAccess } from './game/access'
import { extractArtifacts, sandboxDocument } from './game/artifacts'
import { classifyContent, detectModelRefusal } from './game/contentPolicy'
import { CURRENT_MODELS, DAY, HOUR, MODEL_INFO, MODEL_META, PLAN_INFO } from './game/data'
import { addAccount, advanceTime, assignChatProject, cancelSubscription, changePlan, createAccount, createProject, deleteChat, deleteProject, emptyStore, finishGeneration, login, logout, recordPolicyRefusal, refundLatestInvoice, removeAccount, replaceAccount, startGeneration, submitAppeal, supplementAppeal, updateChat, updateGeneration, verifyAccount } from './game/engine'
import { CLOCK_KEY, loadStore, saveStore, setGenerationLease, STORAGE_KEY } from './game/persistence'
import { DEFAULT_PROVIDER, loadProvider, streamChat, type ProviderConfig, type ProviderResponse } from './game/provider'
import { searchAccount, type SearchHit } from './game/search'
import type { Account, GameStore, Message, MessageOutcome, Model, Plan } from './game/types'
import './client.css'

type View = 'chat' | 'search' | 'projects' | 'artifacts' | 'usage' | 'billing' | 'settings' | 'notifications'
const views: View[] = ['chat','search','projects','artifacts','usage','billing','settings','notifications']
function viewFromHash(): View { const route = location.hash.slice(2); return views.includes(route as View) ? route as View : 'chat' }
type GenerationTask = { accountId: string; chatId: string; messageId: string; requestId: string; controller: AbortController; status: 'running' | 'stopping'; text: string; persistedText: string; storageFailed: boolean }
const MAX_STORED_REPLY = 250_000
function updateGenerationLease(requestId: string, active: boolean) {
  try { setGenerationLease(requestId, active); return true } catch { return false }
}
const date = (n: number) => new Date(n).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})
const modelName = (m: Model) => MODEL_INFO[m].name.replace('Claude ','')
const outcomeLabel: Record<MessageOutcome, string> = { generating:'正在生成', normal:'已完成', model_refusal:'模型拒答', prefilter_refusal:'本地前置检查', provider_block:'服务端拦截', network_error:'网络错误', service_error:'服务错误', cancelled:'已停止', stream_interrupted:'流中断' }
const codeTokens = /\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|def|print|True|False|null|undefined|interface|type|new|try|catch|throw)\b|\b\d+(?:\.\d+)?\b/g

function highlightedCode(source:string){
  const parts:React.ReactNode[]=[]
  let previous=0
  for(const match of source.matchAll(codeTokens)){
    if(match.index>previous)parts.push(source.slice(previous,match.index))
    const value=match[0]
    const kind=value.startsWith('//')||value.startsWith('#')?'comment':/^["'`]/.test(value)?'string':/^\d/.test(value)?'number':'keyword'
    parts.push(<span className={`code-${kind}`} key={match.index}>{value}</span>)
    previous=match.index+value.length
  }
  if(previous<source.length)parts.push(source.slice(previous))
  return parts
}

function nodeText(node:React.ReactNode):string{
  if(typeof node==='string'||typeof node==='number')return String(node)
  if(Array.isArray(node))return node.map(nodeText).join('')
  if(node&&typeof node==='object'&&'props' in node)return nodeText((node as React.ReactElement<{children?:React.ReactNode}>).props.children)
  return ''
}
function MarkdownView({text}:{text:string}){
  const [copied,setCopied]=useState('')
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{code({className,children}){
    const source=String(children)
    return <code className={className}>{className?.startsWith('language-')?highlightedCode(source):children}</code>
  },pre({children}){
    const source=nodeText(children)
    return <div className="code-shell"><button className="code-copy" title="复制代码" onClick={()=>{void navigator.clipboard.writeText(source).then(()=>setCopied(source)).catch(()=>setCopied('复制失败'))}}><Copy size={12}/> {copied===source?'已复制':copied==='复制失败'?'复制失败':'复制'}</button><pre>{children}</pre></div>
  }}}>{text}</ReactMarkdown>
}
function HitSnippet({hit}:{hit:SearchHit}){return <>{hit.snippet.slice(0,hit.matchStart)}<mark>{hit.snippet.slice(hit.matchStart,hit.matchEnd)}</mark>{hit.snippet.slice(hit.matchEnd)}</>}


function ModelMenu({model,plan,choose}: {model:Model;plan:Plan;choose:(m:Model)=>void}) {
  const [open,setOpen] = useState(false)
  const trigger=useRef<HTMLButtonElement>(null)
  useEffect(()=>{if(!open)return;const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();setOpen(false);trigger.current?.focus()}};window.addEventListener('keydown',key);requestAnimationFrame(()=>document.querySelector<HTMLButtonElement>('.model-pop button:not(:disabled)')?.focus());return()=>window.removeEventListener('keydown',key)},[open])
  return <div className="model-control"><button ref={trigger} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{modelName(model)} <ChevronDown size={13}/></button>{open && <><button className="pop-shield" aria-label="关闭模型菜单" onClick={() => {setOpen(false);trigger.current?.focus()}}/><div className="model-pop" role="menu"><small>选择模型</small>{CURRENT_MODELS.map(m => { const family = MODEL_META[m].family; const locked = plan === 'free' && ['Fable','Opus'].includes(family) || plan === 'pro' && family === 'Fable'; return <button role="menuitem" key={m} disabled={locked} onClick={() => {choose(m);setOpen(false);trigger.current?.focus()}}><span><strong>{modelName(m)}</strong><small>{MODEL_INFO[m].description}</small></span>{locked ? <em>{family === 'Fable' ? 'Max' : 'Pro'}</em> : model === m ? <Check size={15}/> : null}</button>})}<p>模型目录与套餐可用性分别参考官方公开资料。</p></div></>}</div>
}

function Composer({draft,setDraft,model,setModel,plan,offline,attachment,setAttachment,send,stop,busy,fileRef,contextKey}: {draft:string;setDraft:(s:string)=>void;model:Model;setModel:(m:Model)=>void;plan:Plan;offline:boolean;attachment?:{name:string;size:number;text?:string};setAttachment:(a?:{name:string;size:number;text?:string})=>void;send:()=>void;stop:()=>void;busy:boolean;fileRef:React.RefObject<HTMLInputElement|null>;contextKey:string}) {
  const [fileError,setFileError]=useState('')
  const [dragging,setDragging]=useState(false)
  const textareaRef=useRef<HTMLTextAreaElement>(null)
  const contextRef=useRef(contextKey)
  const mountedRef=useRef(true)
  contextRef.current=contextKey
  useEffect(()=>{mountedRef.current=true;return()=>{mountedRef.current=false}},[])
  useLayoutEffect(()=>{const el=textareaRef.current;if(el){el.style.height='auto';el.style.height=`${Math.min(240,Math.max(51,el.scrollHeight))}px`}},[draft])
  async function pickFile(file?:File){
    if(!file)return
    const selectedContext=contextKey
    if(!/\.(txt|md|csv|json|js|jsx|ts|tsx|py|html|css|xml|ya?ml)$/i.test(file.name)){setFileError('目前仅支持常见文本文件。');return}
    if(file.size>256_000){setFileError('文本附件最大为 256 KB。');return}
    try{
      const content=await file.text()
      if(!mountedRef.current||contextRef.current!==selectedContext)return
      setAttachment({name:file.name,size:file.size,text:content});setFileError('')
    }
    catch{if(mountedRef.current&&contextRef.current===selectedContext)setFileError('无法读取此文件，请重新选择。')}
  }
  return <div className={`composer ${dragging?'drag-over':''}`} onDragOver={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();setDragging(true)}}} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setDragging(false)}} onDrop={e=>{e.preventDefault();e.stopPropagation();setDragging(false);if(e.dataTransfer.files.length)void pickFile(e.dataTransfer.files[0]);else if(e.dataTransfer.getData('text/plain'))setDraft(draft+e.dataTransfer.getData('text/plain'))}}><div className="composer-input">{attachment && <span className="file-pill"><FileText size={14}/>{attachment.name}<button title="移除附件" onClick={() => setAttachment(undefined)}><X size={13}/></button></span>}<textarea ref={textareaRef} value={draft} onChange={e => setDraft(e.target.value)} onPaste={e=>{if(e.clipboardData.files.length){e.preventDefault();void pickFile(e.clipboardData.files[0])}}} onKeyDown={e => {if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&e.keyCode!==229){e.preventDefault();if(!busy)send()}}} placeholder="向 Claude 提问..." rows={2}/></div><div className="composer-tools"><span><button title="添加文本附件" onClick={() => fileRef.current?.click()}><Plus size={19}/></button><input ref={fileRef} hidden type="file" accept=".txt,.md,.csv,.json,.js,.jsx,.ts,.tsx,.py,.html,.css,.xml,.yaml,.yml" onChange={e => {void pickFile(e.target.files?.[0]);e.target.value=''}}/><ModelMenu model={model} plan={plan} choose={setModel}/>{offline && <small className="offline-label">离线体验</small>}</span><button className="send" onClick={busy?stop:send} disabled={!busy&&!draft.trim()&&!attachment} title={busy?'停止生成':'发送'}>{busy?<Square size={14} fill="currentColor"/>:<ArrowRight size={18}/>}</button></div>{fileError&&<small className="file-error" role="alert">{fileError}</small>}{attachment&&!offline&&<small className="file-disclosure">文本内容将随消息发送给所配置的模型服务。</small>}</div>
}

export default function ClientApp() {
  const [store,setStore] = useState<GameStore>(() => {try{return loadStore()}catch{return emptyStore()}})
  const storeRef = useRef(store)
  const [storageUnavailable] = useState(()=>{try{localStorage.getItem(STORAGE_KEY);return false}catch{return true}})
  const savedRef = useRef<string|null>((()=>{try{return localStorage.getItem(STORAGE_KEY)}catch{return null}})())
  const [loadError] = useState(()=>{
    if(storageUnavailable)return true
    try{
      const raw=localStorage.getItem(STORAGE_KEY)
      if(!raw)return false
      const value=JSON.parse(raw)
      return value?.version!==1||!Array.isArray(value.accounts)||value.accounts.length>0&&store.accounts.length===0
    }catch{return true}
  })
  const [storageConflict,setStorageConflict] = useState(false)
  const wallTickRef = useRef(Date.now())
  const [view,setView] = useState<View>(viewFromHash)
  const [dev,setDev] = useState(location.hash==='#/devtools')
  const [provider,setProvider] = useState<ProviderConfig>(DEFAULT_PROVIDER)
  const providerRevisionRef = useRef(0)
  const [model,setModel] = useState<Model>('claude-sonnet-5-5')
  const [draft,setDraft] = useState('')
  const draftCacheRef=useRef(new Map<string,{text:string;attachment?:{name:string;size:number;text?:string}}>())
  const [search,setSearch] = useState('')
  const [attachment,setAttachment] = useState<{name:string;size:number;text?:string}>()
  const [draftOpen,setDraftOpen] = useState(false)
  const [toast,setToast] = useState('')
  const [sideOpen,setSideOpen] = useState(false)
  const [collapsed,setCollapsed] = useState(false)
  const [appealText,setAppealText] = useState('')
  const [verifyCode,setVerifyCode] = useState('')
  const [checkout,setCheckout] = useState<Plan>()
  const [billCode,setBillCode] = useState('')
  const [payBusy,setPayBusy] = useState(false)
  const payLockRef=useRef(false)
  const [refundPending,setRefundPending] = useState(false)
  const [newProject,setNewProject] = useState(false)
  const [projectDraft,setProjectDraft] = useState('')
  const [chatMenu,setChatMenu] = useState<string>()
  const [menuPosition,setMenuPosition] = useState<{top:number;left:number}>()
  const menuTriggerRef=useRef<HTMLButtonElement|null>(null)
  const [renameChat,setRenameChat] = useState<string>()
  const [renameDraft,setRenameDraft] = useState('')
  const renameLockRef=useRef(false)
  const [targetMessageId,setTargetMessageId] = useState<string>()
  const [visibleCount,setVisibleCount] = useState(80)
  const [selectedArtifactId,setSelectedArtifactId] = useState<string>()
  const [artifactDraft,setArtifactDraft] = useState('')
  const tasksRef=useRef(new Map<string,GenerationTask>())
  const sendLockRef=useRef(false)
  const fileRef=useRef<HTMLInputElement>(null)
  const endRef=useRef<HTMLDivElement>(null)
  const scrollRef=useRef<HTMLDivElement>(null)
  const autoScrollRef=useRef(true)
  const account=store.accounts.find(a=>a.id===store.currentId)
  const active=draftOpen?undefined:account?.chats.find(c=>c.id===account.activeChatId)
  const composerContext=draftOpen?`${account?.id??'none'}:new`:`${account?.id??'none'}:${active?.id??'new'}`
  const activeTask=active?.messages.find(m=>m.outcome==='generating')
  const access=account?assessAccess(account):null
  function rememberDraft(){
    if(account&&!draftOpen&&active)draftCacheRef.current.set(`${account.id}:${active.id}`,{text:draft,attachment})
  }
  function showDraft(key?:string){
    const remembered=key?draftCacheRef.current.get(key):undefined
    setDraft(remembered?.text??'')
    setAttachment(remembered?.attachment)
  }
  function startNewChat(){rememberDraft();setDraftOpen(true);showDraft();go('chat')}
  useEffect(()=>{
    if(!account)return
    const family=MODEL_META[model].family
    if(account.plan==='free' && (family==='Opus'||family==='Fable') || account.plan==='pro' && family==='Fable')setModel('claude-sonnet-5-5')
  },[account?.plan,model])
  useEffect(()=>{
    let active = true
    const revisionAtStart = providerRevisionRef.current
    loadProvider().then(config=>{
      if(active && providerRevisionRef.current===revisionAtStart)setProvider(config)
    }).catch(error=>{
      if(active && providerRevisionRef.current===revisionAtStart)setToast(error instanceof Error?error.message:'本机模型网关不可用')
    })
    return()=>{active=false}
  },[])
  function acceptProvider(config: ProviderConfig){
    providerRevisionRef.current++
    setProvider(config)
  }
  useEffect(()=>{
    if(loadError)return
    try{
      if(localStorage.getItem(STORAGE_KEY)!==savedRef.current){setStorageConflict(true);return}
      const hasLiveGeneration=storeRef.current.accounts.some(account=>account.chats.some(chat=>chat.messages.some(message=>message.outcome==='generating')))
      if(!hasLiveGeneration&&savedRef.current!==JSON.stringify(storeRef.current)){
        saveStore(storeRef.current);savedRef.current=JSON.stringify(storeRef.current)
      }
    }catch{setToast('浏览器存储不可写。请检查隐私设置或可用空间。')}
    const onStorage=(event:StorageEvent)=>{if(event.key===STORAGE_KEY&&event.newValue!==savedRef.current)setStorageConflict(true)}
    window.addEventListener('storage',onStorage)
    return()=>window.removeEventListener('storage',onStorage)
  },[loadError])
  useEffect(()=>{if(toast){const t=setTimeout(()=>setToast(''),5000);return()=>clearTimeout(t)}},[toast])
  useEffect(()=>{sendLockRef.current=false},[draft])
  useLayoutEffect(()=>{
    if(view!=='chat')return
    if(targetMessageId){
      const index=active?.messages.findIndex(message=>message.id===targetMessageId)??-1
      if(index>=0&&active&&index<active.messages.length-visibleCount){setVisibleCount(active.messages.length-index+10);return}
      document.getElementById(`message-${targetMessageId}`)?.scrollIntoView({block:'center'})
      setTargetMessageId(undefined)
    }else if(autoScrollRef.current)endRef.current?.scrollIntoView({block:'end'})
  },[view,active?.id,active?.messages.length,active?.messages.at(-1)?.text,targetMessageId,visibleCount])
  useEffect(()=>{const h=()=>{setDev(location.hash==='#/devtools');setView(viewFromHash())};window.addEventListener('hashchange',h);return()=>window.removeEventListener('hashchange',h)},[])
  useEffect(()=>{
    const over=(event:DragEvent)=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault()}
    const drop=(event:DragEvent)=>{if(event.dataTransfer?.files.length){event.preventDefault();setToast('文件未添加。请将文件拖入聊天输入框。')}}
    window.addEventListener('dragover',over)
    window.addEventListener('drop',drop)
    return()=>{window.removeEventListener('dragover',over);window.removeEventListener('drop',drop)}
  },[])
  useEffect(()=>{
    const viewport=window.visualViewport
    const resize=()=>document.documentElement.style.setProperty('--app-height',`${Math.round(viewport?.height??window.innerHeight)}px`)
    resize();viewport?.addEventListener('resize',resize);window.addEventListener('resize',resize)
    return()=>{viewport?.removeEventListener('resize',resize);window.removeEventListener('resize',resize);document.documentElement.style.removeProperty('--app-height')}
  },[])
  useEffect(()=>{
    if(!chatMenu)return
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setChatMenu(undefined);menuTriggerRef.current?.focus()}}
    const dismiss=()=>setChatMenu(undefined)
    window.addEventListener('keydown',key)
    window.addEventListener('resize',dismiss)
    window.addEventListener('scroll',dismiss,true)
    requestAnimationFrame(()=>document.querySelector<HTMLButtonElement>('.floating-chat-menu button')?.focus())
    return()=>{window.removeEventListener('keydown',key);window.removeEventListener('resize',dismiss);window.removeEventListener('scroll',dismiss,true)}
  },[chatMenu])
  useEffect(()=>{
    if(!renameChat&&!newProject&&!checkout&&!refundPending)return
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setRenameChat(undefined);setNewProject(false);if(!payBusy)setCheckout(undefined);setRefundPending(false)}}
    window.addEventListener('keydown',key)
    return()=>window.removeEventListener('keydown',key)
  },[renameChat,newProject,checkout,refundPending,payBusy])
  useEffect(()=>{
    const abandon=()=>{
      // A page unload leaves a persisted generating message for loadStore to mark interrupted.
      // Removing task identity first prevents a late fetch rejection from writing over it.
      const tasks=[...tasksRef.current.values()]
      tasksRef.current.clear()
      for(const task of tasks){updateGenerationLease(task.requestId,false);task.controller.abort()}
    }
    window.addEventListener('pagehide',abandon)
    const heartbeat=setInterval(()=>{for(const task of tasksRef.current.values())updateGenerationLease(task.requestId,true)},3000)
    return()=>{clearInterval(heartbeat);window.removeEventListener('pagehide',abandon);abandon()}
  },[])
  useEffect(()=>{if(account&&['review','frozen','banned','challenge'].includes(account.status))for(const task of tasksRef.current.values())if(task.accountId===account.id)task.controller.abort()},[account?.status,account?.id])
  function commitStore(update:(current:GameStore)=>GameStore):boolean{
    if(loadError){setToast('存档读取失败。请先下载原始数据，再选择恢复方式。');return false}
    try{
      if(storageConflict||localStorage.getItem(STORAGE_KEY)!==savedRef.current){setStorageConflict(true);setToast('另一个标签页修改了存档。请刷新并读取最新版本；当前页面不会覆盖它。');return false}
      const next=update(storeRef.current)
      if(next===storeRef.current)return true
      saveStore(next)
      savedRef.current=JSON.stringify(next)
      storeRef.current=next
      setStore(next)
      return true
    }catch(error){setToast(error instanceof Error?error.message:'无法保存状态。');return false}
  }
  useEffect(()=>{
    let timer:ReturnType<typeof setTimeout>
    function catchUp(){
      const now=Date.now(),elapsed=(now-wallTickRef.current)/HOUR
      if(elapsed<1/600)return
      wallTickRef.current=now
      commitStore(prev=>prev.accounts.reduce((next,a)=>replaceAccount(next,advanceTime(a,Math.min(elapsed,8760),true)),prev))
    }
    function schedule(){timer=setTimeout(()=>{catchUp();schedule()},60000)}
    const onFocus=()=>catchUp()
    const onVisible=()=>{if(document.visibilityState==='visible')catchUp()}
    window.addEventListener('focus',onFocus)
    document.addEventListener('visibilitychange',onVisible)
    schedule()
    return()=>{clearTimeout(timer);window.removeEventListener('focus',onFocus);document.removeEventListener('visibilitychange',onVisible)}
  },[])
  function apply(fn:(a:Account)=>Account){return commitStore(prev=>{const a=prev.accounts.find(x=>x.id===prev.currentId);if(!a)throw new Error('找不到当前账号。');return replaceAccount(prev,fn(a))})}
  function go(v:View){location.hash=`/${v}`;setView(v);setSideOpen(false)}
  function closeDev(){go('chat');setDev(false)}
  function selectChat(id:string,messageId?:string){if(!account?.chats.some(c=>c.id===id))return;if(apply(a=>({...a,activeChatId:id}))){rememberDraft();showDraft(`${account.id}:${id}`);setDraftOpen(false);setVisibleCount(80);autoScrollRef.current=!messageId;setTargetMessageId(messageId);go('chat')}}
  function openChatMenu(id:string,button:HTMLButtonElement){
    if(chatMenu===id){setChatMenu(undefined);return}
    const rect=button.getBoundingClientRect()
    menuTriggerRef.current=button
    setMenuPosition({top:Math.max(8,Math.min(window.innerHeight-130,rect.bottom+4)),left:Math.max(8,rect.right+150>window.innerWidth?rect.left-150:rect.right+4)})
    setChatMenu(id)
  }
  function deleteSelectedChat(id:string){
    if(!confirm('删除此对话？'))return
    if(apply(a=>deleteChat(a,id))){
      for(const task of tasksRef.current.values())if(task.chatId===id){task.controller.abort();tasksRef.current.delete(task.requestId);updateGenerationLease(task.requestId,false)}
      draftCacheRef.current.delete(`${account!.id}:${id}`)
      if(active?.id===id){setDraftOpen(true);showDraft()}
      setChatMenu(undefined)
    }
  }
  function saveRename(){
    const id=renameChat,title=renameDraft.trim()
    if(!id||!title||renameLockRef.current)return
    renameLockRef.current=true
    if(apply(a=>updateChat(a,id,{title})))setRenameChat(undefined)
    queueMicrotask(()=>{renameLockRef.current=false})
  }
  async function send(){
    if(sendLockRef.current)return
    const text=draft.trim(),currentAttachment=attachment,currentModel=model
    if(!text&&!currentAttachment)return
    sendLockRef.current=true
    const policy=classifyContent(text)
    let started:ReturnType<typeof startGeneration>|undefined
    let history:Message[]=[]
    const accepted=commitStore(prev=>{
      const current=prev.accounts.find(a=>a.id===prev.currentId)
      if(!current)throw new Error('找不到当前账号。')
      const sourceChat=draftOpen?undefined:current.chats.find(c=>c.id===current.activeChatId)
      history=[...(sourceChat?.messages??[]),{id:'pending',role:'user',text,at:current.now,attachment:currentAttachment}]
      started=startGeneration(current,text,currentModel,currentAttachment,sourceChat?.id,policy.kind!=='refuse',provider.effort)
      return replaceAccount(prev,started.account)
    })
    if(!accepted||!started){sendLockRef.current=false;return}
    const taskStart=started
    if(account&&!draftOpen&&active)draftCacheRef.current.delete(`${account.id}:${active.id}`)
    setDraft('');setAttachment(undefined);setDraftOpen(false);go('chat')
    if(policy.kind==='refuse'){
      commitStore(prev=>{
        const current=prev.accounts.find(a=>a.id===prev.currentId)
        if(!current)return prev
        const finished=finishGeneration(current,taskStart.requestId,policy.reason||'本地前置内容检查未处理此请求。','prefilter_refusal',provider.effort)
        return replaceAccount(prev,recordPolicyRefusal(finished))
      })
      return
    }
    if(policy.kind==='caution')setToast(policy.reason||'')
    const task:GenerationTask={accountId:taskStart.account.id,chatId:taskStart.chatId,messageId:taskStart.messageId,requestId:taskStart.requestId,controller:new AbortController(),status:'running',text:'',persistedText:'',storageFailed:false}
    tasksRef.current.set(task.requestId,task)
    if(!updateGenerationLease(task.requestId,true))setToast('浏览器暂时无法记录生成状态；刷新页面可能将这次回复标为中断。')
    let result:ProviderResponse
    try{
      result=await streamChat(provider,currentModel,history,part=>{
        if(tasksRef.current.get(task.requestId)!==task)return
        task.text+=part
        if(task.text.length>MAX_STORED_REPLY){task.storageFailed=true;task.controller.abort();setToast('模型回复超过本地保存上限，已停止生成并保留可保存的部分。');return}
        if(commitStore(prev=>{
          const current=prev.accounts.find(a=>a.id===task.accountId)
          return current?replaceAccount(prev,updateGeneration(current,task.requestId,task.text)):prev
        }))task.persistedText=task.text
        else {task.storageFailed=true;task.controller.abort()}
      },task.controller.signal)
    }catch(error){
      const cancelled=task.controller.signal.aborted
      result={text:task.text,outcome:cancelled?'cancelled':'network_error',message:cancelled?'已停止生成。':error instanceof Error?error.message:'模型连接失败。'}
    }
    if(tasksRef.current.get(task.requestId)!==task)return
    tasksRef.current.delete(task.requestId)
    updateGenerationLease(task.requestId,false)
    const outcome:MessageOutcome=task.storageFailed?'stream_interrupted':result.outcome==='normal'&&!result.text?'service_error':result.outcome==='normal'&&detectModelRefusal(result.text)?'model_refusal':result.outcome
    const reply=task.storageFailed?(task.persistedText||'回复因浏览器存储空间不足而中断。'):(result.text||task.text||result.message||'模型没有返回可显示的内容。')
    commitStore(prev=>{
      const current=prev.accounts.find(a=>a.id===task.accountId)
      return current?replaceAccount(prev,finishGeneration(current,task.requestId,reply,outcome,provider.effort)):prev
    })
  }
  function stopCurrent(){const task=tasksRef.current.get(activeTask?.requestId??'');if(task){task.status='stopping';task.controller.abort()}else if(activeTask)setToast('此回复正在另一个标签页生成，请在原标签页停止。')}
  function beginCheckout(p:Plan){setCheckout(p);setBillCode('')}
  function pay(failed=false){
    if(!checkout||!account||payLockRef.current)return
    const plan=checkout,accountId=account.id
    payLockRef.current=true;setPayBusy(true)
    setTimeout(()=>{
      let didFail=failed
      const saved=commitStore(prev=>{
        const target=prev.accounts.find(a=>a.id===accountId)
        if(!target)throw new Error('结算期间账号已删除，未生成账单。')
        didFail=failed||target.sandboxPaymentOutcome==='failure'
        return replaceAccount(prev,changePlan(target,plan,didFail))
      })
      if(saved){setToast(didFail?'虚拟付款未完成，请重试。':'订阅已更新。');if(!didFail)setCheckout(undefined)}
      payLockRef.current=false;setPayBusy(false)
    },400)
  }
  function forkArchive(seed:number){
    if(!account)return
    const start=Math.max(Date.now(),...storeRef.current.accounts.map(a=>a.createdAt+1))
    const env=account.initialEnvironment
    const next=createAccount({name:account.name,region:env.region,network:env.network,reputation:env.reputation,device:env.device,browser:env.browser,emailProvider:account.emailProvider,signupMethod:account.signupMethod,persona:account.persona,mode:account.mode,seed},start)
    if(commitStore(prev=>addAccount(prev,next))){showDraft();setDraftOpen(false)}
  }
  function restoreArchive(saved:Account){
    const uniqueId=`${saved.id}-import-${Date.now().toString(36)}-${Math.floor(Math.random()*1000)}`
    if(commitStore(prev=>addAccount(prev,{...saved,id:uniqueId}))){showDraft();setDraftOpen(false)}
  }
  function exportAccount(){
    if(!account)return
    const url=URL.createObjectURL(new Blob([JSON.stringify({format:'claude-local-account-v1',account},null,2)],{type:'application/json'}))
    const link=document.createElement('a');link.href=url;link.download=`claude-local-${account.id}.json`;link.click()
    setTimeout(()=>URL.revokeObjectURL(url),1000)
  }
  function deleteCurrentAccount(){
    if(!account||!confirm(`永久删除本地虚拟账号“${account.name}”及其全部对话？此操作无法撤销，请先导出需要保留的数据。`))return
    if(commitStore(prev=>removeAccount(prev,account.id))){
      for(const task of tasksRef.current.values())if(task.accountId===account.id){task.controller.abort();tasksRef.current.delete(task.requestId);updateGenerationLease(task.requestId,false)}
      showDraft();setDraftOpen(false);go('chat')
    }
  }

  if(storageUnavailable)return <main className="access-gate access-full"><div className="gate-icon"><ShieldAlert size={28}/></div><h1>浏览器存储不可用</h1><p>当前浏览器阻止读取本地存档，无法安全创建或使用虚拟账号。请检查站点数据与隐私设置，然后刷新页面。</p><small>现有存档没有被清除。</small></main>
  if(loadError)return <main className="access-gate access-full"><div className="gate-icon"><ShieldAlert size={28}/></div><h1>本地存档需要恢复</h1><p>现有数据无法安全读取，应用没有覆盖它。请先下载原始数据，再决定是否新建存档。</p><div className="gate-actions"><button onClick={()=>{const raw=localStorage.getItem(STORAGE_KEY)??'';const url=URL.createObjectURL(new Blob([raw],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='claude-local-recovery.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}}>下载原始存档</button><button onClick={()=>{if(confirm('确认清除当前无法读取的本地存档？请先下载备份。')){localStorage.removeItem(STORAGE_KEY);localStorage.removeItem(CLOCK_KEY);location.reload()}}}>清除并重新开始</button></div></main>
  if(!account)return <Onboarding create={o=>commitStore(prev=>addAccount(prev,createAccount(o)))}/>
  if(dev)return <DevTools account={account} store={store} provider={provider} setProvider={acceptProvider} apply={apply} switchAccount={id=>{rememberDraft();if(commitStore(prev=>({...prev,currentId:id}))){const next=storeRef.current.accounts.find(a=>a.id===id);showDraft(next?.activeChatId?`${id}:${next.activeChatId}`:undefined);setDraftOpen(false)}}} reset={()=>{if(commitStore(prev=>({...prev,currentId:undefined}))){showDraft();setDraftOpen(false);closeDev()}}} fork={forkArchive} restore={restoreArchive} close={closeDev}/>
  const gateBlocked=access?.kind!=='allowed'&&(access?.kind!=='restricted'||!['notifications','settings','usage'].includes(view))
  if(access&&gateBlocked)return <main className="access-gate access-full"><div className="gate-brand"><img className="brand-mark" src="/brand-icon.png" alt=""/> Claude</div><div className="gate-icon"><ShieldAlert size={28}/></div><h1>{access.title}</h1><p>{access.detail}</p>{access.kind==='verification'&&<div className="verify"><small>本地确认码：246810</small><input value={verifyCode} onChange={e=>setVerifyCode(e.target.value)} placeholder="输入确认码"/><button className="solid" onClick={()=>{apply(a=>verifyAccount(a,verifyCode.trim()==='246810'));setVerifyCode('')}}>继续</button></div>}{access.kind==='session'&&<button className="solid" onClick={()=>apply(login)}>重新进入</button>}{access.kind==='restricted'&&<button className="solid" onClick={()=>go('notifications')}>查看通知与申诉</button>}{['verification_failed','region','signup','network','service'].includes(access.kind)&&<button className="solid" onClick={()=>{location.hash='/devtools';setDev(true)}}>打开开发者工具</button>}{['restricted','verification_failed','region','signup','network','service'].includes(access.kind)&&<div className="gate-actions"><button onClick={exportAccount}>导出账号档案</button><button onClick={deleteCurrentAccount}>删除本地账号</button></div>}<small>非官方本地模拟。可在设置中打开开发者工具。</small></main>
  const plan=PLAN_INFO[account.plan], usage=Math.min(100,Math.round(account.sessionUsed/plan.session*100)), weekly=Number.isFinite(plan.weekly)?Math.min(100,Math.round(account.weeklyUsed/plan.weekly*100)):0
  const found=searchAccount(account,search)
  const artifacts=extractArtifacts(account)
  const selectedArtifact=artifacts.find(item=>item.id===selectedArtifactId)
  const shownMessages=active?.messages.slice(-visibleCount)??[]
  const appeal=account.appeals[0]
  const latestPaid=account.invoices.find(i=>i.result==='paid'&&i.amount>0)
  const refundable=latestPaid&&account.now-latestPaid.at<=7*DAY&&!account.invoices.some(i=>i.refundOf===latestPaid.id)
  return <div className={`client-shell ${collapsed?'collapsed':''}`}>
    {sideOpen&&<button className="mobile-shade" onClick={()=>setSideOpen(false)}/>}
    <aside className={`client-side ${sideOpen?'open':''}`}><div className="side-head"><button className="client-brand" onClick={()=>go('chat')}><img className="brand-mark side-brand-mark" src="/brand-icon.png" alt=""/> Claude</button><button className="icon-button collapse" title={collapsed?"展开侧栏":"折叠侧栏"} onClick={()=>setCollapsed(!collapsed)}>{collapsed?<PanelLeftOpen size={17}/>:<PanelLeftClose size={17}/>}</button></div><nav><button className="new-chat" onClick={startNewChat}><Plus size={18}/><span>新对话</span></button><button onClick={()=>go('search')}><Search size={17}/><span>搜索</span></button><button onClick={()=>go('projects')}><Folder size={17}/><span>项目</span></button><button onClick={()=>go('artifacts')}><Sparkles size={17}/><span>Artifacts</span></button></nav><div className="recent-title">最近对话</div><div className="recent-scroll">{[...account.chats].sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updatedAt-a.updatedAt).map(c=><div className={`recent ${active?.id===c.id&&view==='chat'?'current':''}`} key={c.id}><button onClick={()=>selectChat(c.id)}><MessageSquare size={14}/><span>{c.title}</span></button><button className="more" title="对话操作" aria-haspopup="menu" aria-expanded={chatMenu===c.id} onClick={e=>openChatMenu(c.id,e.currentTarget)}><Ellipsis size={15}/></button></div>)}</div><div className="side-foot"><button className="profile" onClick={()=>go('settings')}><b>{account.name.slice(0,1)}</b><span><strong>{account.name}</strong><small>{plan.name} 计划</small></span><Ellipsis size={16}/></button></div></aside>
    <div className="client-workspace"><header className="client-top"><div><button className="icon-button mobile-menu" title="打开侧栏" onClick={()=>setSideOpen(true)}><Menu size={20}/></button><button className="icon-button desktop-toggle" title={collapsed?"展开侧栏":"折叠侧栏"} onClick={()=>setCollapsed(!collapsed)}>{collapsed?<PanelLeftOpen size={18}/>:<PanelLeftClose size={18}/>}</button>{view!=="chat"&&<button className="back-chat" onClick={()=>go("chat")}><ArrowLeft size={15}/> 返回聊天</button>}<span>{view==='chat'?active?.title||'新对话':({search:'搜索',projects:'项目',artifacts:'Artifacts',usage:'用量',billing:'订阅与账单',settings:'设置',notifications:'通知'} as Record<View,string>)[view]}</span></div><div><button className="top-notifications" title="通知" onClick={()=>go('notifications')}><Bell size={17}/>{account.notifications.some(n=>!n.read)&&<i/>}</button><button onClick={()=>go('billing')}>{plan.name}</button><button className="top-avatar" onClick={()=>go('settings')}>{account.name.slice(0,1)}</button></div></header>
      {view==='chat'?<main className="chat-workspace">{active?.messages.length?<div className="messages-scroll" ref={scrollRef} onScroll={e=>{const el=e.currentTarget;autoScrollRef.current=el.scrollHeight-el.scrollTop-el.clientHeight<100}}><div className="messages">{active&&active.messages.length>visibleCount&&<button className="older-messages" onClick={()=>{autoScrollRef.current=false;setVisibleCount(visibleCount+80)}}>显示更早消息</button>}{shownMessages.map(m=><div id={`message-${m.id}`} className={`message ${m.role}`} key={m.id}>{m.role==='assistant'&&<img className="assistant-symbol" src="/brand-icon.png" alt=""/>}<div>{m.attachment&&<span className="file-pill"><Paperclip size={14}/>{m.attachment.name}</span>}<div className="markdown">{m.outcome==="generating"&&!m.text?<span className="thinking">正在思考 <i/></span>:<MarkdownView text={m.text}/>}</div>{m.role==='assistant'&&<small>{modelName(m.model||model)} · {outcomeLabel[m.outcome??'normal']}</small>}</div></div>)}<div ref={endRef}/></div></div>:<div className="welcome"><div><img className="welcome-mark" src="/brand-icon.png" alt=""/><h1>有什么可以帮你，{account.name}？</h1><p>从一个问题开始，或继续之前的思路。</p><Composer draft={draft} setDraft={setDraft} model={model} setModel={setModel} plan={account.plan} offline={provider.kind==='offline'} attachment={attachment} setAttachment={setAttachment} send={send} stop={stopCurrent} busy={!!activeTask} fileRef={fileRef} contextKey={composerContext}/><div className="suggestions">{['帮我梳理一个复杂想法','一起写一封邮件','解释一个新概念','为项目制定计划'].map(s=><button key={s} onClick={()=>setDraft(s)}>{s} <ArrowRight size={14}/></button>)}</div></div></div>}{!!active?.messages.length&&<div className="composer-dock"><Composer draft={draft} setDraft={setDraft} model={model} setModel={setModel} plan={account.plan} offline={provider.kind==='offline'} attachment={attachment} setAttachment={setAttachment} send={send} stop={stopCurrent} busy={!!activeTask} fileRef={fileRef} contextKey={composerContext}/><small>AI 可能出错。请核实重要信息。</small></div>}</main>:<main className="page-scroll"><div className="page-width">
        {view==='search'&&<><div className="page-heading"><h1>搜索对话</h1><p>查找标题或消息中的内容。</p></div><div className="search-box"><Search size={18}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="搜索对话" autoFocus/></div><div className="items">{found.map(hit=><button className="search-hit" key={hit.id} onClick={()=>selectChat(hit.chatId,hit.messageId)}><MessageSquare size={18}/><span><strong>{hit.chatTitle}</strong><small className="snippet"><HitSnippet hit={hit}/></small><small>{date(hit.at)} · {hit.messageId?'对话消息':'对话标题'}</small></span><ArrowRight size={15}/></button>)}{!search.trim()&&<p className="empty">输入词语以搜索对话标题和消息内容。</p>}{search.trim()&&!found.length&&<p className="empty">没有找到匹配的对话。</p>}</div></>}
        {view==='projects'&&<><div className="page-heading row"><div><h1>项目</h1><p>将相关对话放在一起。</p></div><button className="solid" onClick={()=>account.plan==='free'?go('billing'):setNewProject(true)}><Plus size={17}/> {account.plan==='free'?'升级以使用项目':'新建项目'}</button></div><div className="project-grid">{(account.projects??[]).map(p=><section className="project-card" key={p.id}><div><Folder size={21}/><button title="删除项目" onClick={()=>{if(confirm(`删除项目“${p.name}”？对话会保留。`))apply(a=>deleteProject(a,p.id))}}><Trash2 size={15}/></button></div><h2>{p.name}</h2><small>{account.chats.filter(c=>c.projectId===p.id).length} 个对话</small>{account.chats.filter(c=>c.projectId===p.id).map(c=><button className="project-chat" key={c.id} onClick={()=>selectChat(c.id)}>{c.title} <ArrowRight size={14}/></button>)}</section>)}{!account.projects?.length&&<div className="empty-card"><Folder size={27}/><h2>给工作一个空间</h2><p>创建项目后，可将对话归入项目。</p></div>}</div>{active&&!!account.projects?.length&&<div className="assign"><span>当前对话：{active.title}</span><select value={active.projectId??''} onChange={e=>apply(a=>assignChatProject(a,active.id,e.target.value||undefined))}><option value="">不属于项目</option>{account.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></div>}</>}
        {view==='artifacts'&&<><div className="page-heading"><h1>Artifacts</h1><p>可独立查看的 HTML、SVG 与界面代码。普通代码片段保留在对话中。</p></div><div className="artifact-layout"><div className="items">{artifacts.map(item=><button key={item.id} onClick={()=>{setSelectedArtifactId(item.id);setArtifactDraft(item.content)}}><FileText size={19}/><span><strong>{item.chatTitle} · {item.language.toUpperCase()}</strong><small>{item.content.slice(0,90).replace(/[`#]/g,'')}…</small><small>{date(item.at)}</small></span><ArrowRight size={15}/></button>)}{!artifacts.length&&<div className="empty-card"><Sparkles size={27}/><h2>还没有 Artifacts</h2><p>可独立查看的 HTML、SVG 或 JSX 回复会出现在这里。</p></div>}</div>{selectedArtifact&&<aside className="artifact-detail"><h2>{selectedArtifact.chatTitle} · {selectedArtifact.language.toUpperCase()}</h2><div className="artifact-actions"><button onClick={()=>{void navigator.clipboard.writeText(artifactDraft).then(()=>setToast('Artifact 内容已复制。')).catch(()=>setToast('复制失败，请检查浏览器权限。'))}}><Copy size={14}/> 复制内容</button><button onClick={()=>{if(apply(a=>({...a,artifactEdits:{...a.artifactEdits,[selectedArtifact.id]:artifactDraft}})))setToast('Artifact 编辑已保存在本地。')}}>保存编辑</button><button onClick={()=>selectChat(selectedArtifact.chatId,selectedArtifact.messageId)}>返回原对话</button></div><textarea aria-label="Artifact 内容" value={artifactDraft} onChange={e=>setArtifactDraft(e.target.value)} spellCheck={false}/>{selectedArtifact.previewable?<><h3>隔离预览</h3><iframe title="Artifact 沙盒预览" sandbox="" srcDoc={sandboxDocument({...selectedArtifact,content:artifactDraft})}/><small>预览禁用脚本、网络请求和表单提交。</small></>:<p>此类型可编辑和复制；当前版本不执行 JSX/React，也不提供运行预览。</p>}</aside>}</div></>}
        {view==='usage'&&<><div className="page-heading"><h1>用量</h1><p>查看当前计划的使用情况与恢复时间。</p></div><section className="settings-card"><div className="card-head"><h2>当前会话</h2><span>{usage>=100?'已达到限制':usage>=80?'接近限制':'可继续使用'}</span></div><div className="meter"><i style={{width:`${usage}%`}}/></div><div className="meter-label"><span>已使用约 {usage}%</span><span>约于 {date(account.sessionResetAt)} 恢复</span></div><p>用量随模型、对话长度、附件和回复规模变化。百分比是本地估算。</p></section>{account.plan!=='free'&&<section className="settings-card"><div className="card-head"><h2>每周用量</h2><span>{weekly}%</span></div><div className="meter"><i style={{width:`${weekly}%`}}/></div><div className="meter-label"><span>本周使用情况</span><span>{date(account.weeklyResetAt)} 恢复</span></div></section>}<section className="settings-card"><h2>了解用量</h2><p>公开资料确认存在滚动五小时会话额度及付费计划的每周额度。实际产品没有固定消息数量；本地应用使用估算单位。</p><button onClick={()=>go('billing')}>查看计划 <ArrowRight size={15}/></button></section></>}
        {view==='billing'&&<><div className="page-heading"><h1>订阅与账单</h1><p>此页面中的结算都是虚构流程，不会产生真实扣款。</p></div><div className="plan-grid">{(['free','pro','max5','max20'] as Plan[]).map(p=><section className={`plan-card ${account.plan===p?'chosen':''}`} key={p}><div><h2>{PLAN_INFO[p].name}</h2>{account.plan===p&&<small>当前计划</small>}</div><strong>{p==='free'?'免费':`$${PLAN_INFO[p].price}`}<small>{p==='free'?'':' / 月 · 虚拟'}</small></strong><p>{p==='free'?'适合偶尔提问':p==='pro'?'更多用量与模型选择':p==='max5'?'适合长时间使用':'更充裕的连续工作空间'}</p><button disabled={account.plan===p} onClick={()=>beginCheckout(p)}>{account.plan===p?'正在使用':p==='free'?'降级到 Free':'选择计划'}</button></section>)}</div><section className="settings-card"><div className="card-head"><h2>账单记录</h2>{account.plan!=='free'&&<button onClick={()=>apply(cancelSubscription)}>周期结束时取消</button>}</div>{account.cancelAt&&<p>订阅将于 {date(account.cancelAt)} 结束。</p>}{account.invoices.length?account.invoices.map(i=><div className="invoice" key={i.id}><CreditCard size={17}/><span>{PLAN_INFO[i.plan].name}<small>{date(i.at)} · {i.result==='paid'?'已完成':i.result==='failed'?'未完成':'已退款'}</small></span><strong>${i.amount}</strong></div>):<p>还没有账单。</p>}</section></>}
        {view==='billing'&&refundable&&<section className="settings-card"><h2>虚拟退款</h2><p>最近一笔虚拟账单可在生成后 7 个模拟日内退款。退款后计划切换到 Free。</p><button onClick={()=>setRefundPending(true)}>申请退款 <ArrowRight size={15}/></button></section>}
        {view==='settings'&&<><div className="page-heading"><h1>设置</h1><p>管理此浏览器中的虚拟账号。</p></div><section className="settings-card"><h2>个人资料</h2><div className="setting"><span>显示名称</span><strong>{account.name}</strong></div><div className="setting"><span>虚拟邮箱</span><strong>{account.virtualEmail}</strong></div><div className="setting"><span>计划</span><button onClick={()=>go('billing')}>{plan.name} <ArrowRight size={15}/></button></div><div className="setting"><span>使用情况</span><button onClick={()=>go('usage')}>查看用量 <ArrowRight size={15}/></button></div></section><section className="settings-card"><h2>账号与隐私</h2><p>对话、账号事件及文本附件保存在当前浏览器。使用外部模型时，文本附件正文会随消息发送给所配置的服务。</p><div className="account-actions"><button onClick={()=>go('notifications')}><Bell size={16}/> 查看通知与申诉</button><button onClick={exportAccount}>导出账号档案</button><button onClick={deleteCurrentAccount}><Trash2 size={16}/> 删除本地账号</button><button onClick={()=>apply(logout)}><LogOut size={16}/> 退出此虚拟账号</button></div></section><section className="settings-card"><h2>开发者设置</h2><p>配置模型服务、环境参数和高级实验选项。此入口仅用于非官方本地模拟。</p><button onClick={()=>{location.hash="/devtools";setDev(true)}}>打开开发者设置 <ArrowRight size={15}/></button></section><section className="settings-card"><h2>关于此体验</h2><p>这是非官方本地模拟项目，与 Anthropic 无关联。离线体验只用于界面和风控测试；真实回答需配置模型服务。</p></section></>}
        {view==='notifications'&&<><div className="page-heading"><h1>通知</h1><p>账号活动与安全信息。</p></div><div className="notices">{account.notifications.map(n=><div className={`notice ${n.tone}`} key={n.id}><Bell size={17}/><div><strong>{n.title}</strong><p>{n.body}</p><small>{date(n.at)}</small></div></div>)}</div>{['review','frozen','banned','throttled'].includes(account.status)&&<section className="settings-card appeal"><h2>申请复核</h2><p>说明你认为需要复核的账号活动。审核使用本地模拟时钟。</p>{appeal&&<div className="appeal-result">{appeal.stage==='pending'?`正在审核 · 预计 ${date(appeal.dueAt)}`:appeal.resolution}</div>}{(!appeal||['needs_info','granted','denied'].includes(appeal.stage))&&<><textarea rows={5} value={appealText} onChange={e=>setAppealText(e.target.value)} placeholder="描述相关活动与时间..."/><button className="solid" onClick={()=>{if(apply(a=>appeal?.stage==='needs_info'?supplementAppeal(a,appealText):submitAppeal(a,appealText)))setAppealText('')}}>提交说明 <Send size={15}/></button></>}</section>}</>}
      </div></main>}
    </div>
    {newProject&&<div className="dialog-backdrop"><section className="checkout" role="dialog" aria-modal="true" aria-label="新建项目"><button className="dialog-close" aria-label="关闭对话框" onClick={()=>setNewProject(false)}><X size={18}/></button><h2>新建项目</h2><p>整理相关对话，保持工作上下文。</p><label>项目名称<input autoFocus value={projectDraft} onChange={e=>setProjectDraft(e.target.value)} placeholder="例如：研究计划"/></label><button className="solid" disabled={!projectDraft.trim()} onClick={()=>{if(apply(a=>createProject(a,projectDraft))){setProjectDraft('');setNewProject(false)}}}>创建项目</button></section></div>}
    {renameChat&&<div className="dialog-backdrop"><section className="checkout" role="dialog" aria-modal="true" aria-label="重命名对话"><button className="dialog-close" aria-label="关闭对话框" onClick={()=>setRenameChat(undefined)}><X size={18}/></button><h2>重命名对话</h2><label>标题<input autoFocus value={renameDraft} onChange={e=>setRenameDraft(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();saveRename()}if(e.key==="Escape"){e.preventDefault();setRenameChat(undefined)}}}/></label><button className="solid" disabled={!renameDraft.trim()} onClick={saveRename}>保存标题</button></section></div>}
    {refundPending&&<div className="dialog-backdrop"><section className="checkout" role="dialog" aria-modal="true" aria-label="确认虚拟退款"><button className="dialog-close" aria-label="关闭对话框" onClick={()=>setRefundPending(false)}><X size={18}/></button><h2>确认虚拟退款</h2><p>退回最近一笔 ${latestPaid?.amount??0} 的游戏内账单，并切换到 Free。不会产生真实资金流动。</p><button className="solid" onClick={()=>{if(apply(refundLatestInvoice)){setRefundPending(false);setToast('虚拟退款已完成。')}}}>确认退款</button></section></div>}
    {checkout&&<div className="dialog-backdrop"><section className="checkout" role="dialog" aria-modal="true" aria-label="本地沙盒结算"><button className="dialog-close" aria-label="关闭对话框" onClick={()=>setCheckout(undefined)}><X size={18}/></button><small>LOCAL SANDBOX CHECKOUT</small><h2>{checkout==='free'?'切换到 Free':`订阅 ${PLAN_INFO[checkout].name}`}</h2><p>完全本地的虚构结算，不收集银行卡、地址或真实身份资料。</p>{checkout==='free'?<button className="solid" onClick={()=>pay()}>确认降级</button>:<><label>本地沙盒确认码<input value={billCode} onChange={e=>setBillCode(e.target.value.replace(/\D/g,'').slice(0,6))} placeholder="输入 123456" inputMode="numeric"/></label><button className="solid" disabled={payBusy||billCode.length!==6} onClick={()=>pay(billCode!=='123456')}>{payBusy?'处理中…':'确认虚拟付款'}</button><small>测试代码：123456。其他代码产生验证失败记录。付款故障场景可在开发者设置中配置。</small></>}</section></div>}
    {chatMenu&&menuPosition&&createPortal(<div className="menu-layer"><button className="menu-shield" aria-label="关闭对话菜单" onClick={()=>{setChatMenu(undefined);menuTriggerRef.current?.focus()}}/><div className="floating-chat-menu" role="menu" style={menuPosition}><button role="menuitem" onClick={()=>{const selected=account.chats.find(c=>c.id===chatMenu);if(selected){setRenameChat(selected.id);setRenameDraft(selected.title)}setChatMenu(undefined)}}>重命名</button><button role="menuitem" onClick={()=>{const selected=account.chats.find(c=>c.id===chatMenu);if(selected)apply(a=>updateChat(a,selected.id,{pinned:!selected.pinned}));setChatMenu(undefined)}}>{account.chats.find(c=>c.id===chatMenu)?.pinned?'取消置顶':'置顶'}</button><button role="menuitem" onClick={()=>deleteSelectedChat(chatMenu)}>删除</button></div></div>,document.body)}
    {storageConflict&&<div className="storage-conflict" role="alert">另一个标签页已更新存档。当前页面停止写入，刷新后可读取最新进度。<button onClick={()=>location.reload()}>读取最新存档</button></div>}
    {toast&&<div className="toast" role="status">{toast}<button onClick={()=>setToast('')}><X size={15}/></button></div>}
  </div>
}
