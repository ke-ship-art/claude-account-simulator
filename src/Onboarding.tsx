import { useState } from 'react'
import { ArrowRight, ShieldAlert } from 'lucide-react'
import { assessSignup, type AccessResult } from './game/access'
import type { Region, SignupOptions } from './game/types'

type Stage = 'details' | 'verify' | 'blocked' | 'failed'
export default function Onboarding({ create }: { create: (options: SignupOptions) => boolean }) {
  const [name, setName] = useState('')
  const [region, setRegion] = useState<Region>('亚太')
  const [phone, setPhone] = useState('')
  const [method, setMethod] = useState('虚拟邮箱')
  const [stage, setStage] = useState<Stage>('details')
  const [reason, setReason] = useState<AccessResult>()
  const [pending, setPending] = useState<SignupOptions>()
  const [code, setCode] = useState('')
  const [entered, setEntered] = useState('')
  const [attempts, setAttempts] = useState(0)
  const [resends, setResends] = useState(0)
  const [error, setError] = useState('')
  function issueCode() { return String(100000 + Math.floor(Math.random() * 900000)) }
  function begin() {
    const options: SignupOptions = { name: name.trim(), region, virtualPhone: phone, network: '家庭宽带', reputation: '良好', device: '笔记本电脑', browser: 'Chrome', emailProvider: 'postbox', signupMethod: method, persona: '普通用户', mode: 'normal', seed: Math.floor(Math.random() * 2 ** 31) }
    const result = assessSignup(options)
    if (result.kind === 'region') { setReason(result); setStage('blocked'); return }
    if (result.kind !== 'allowed') { setError(result.detail); return }
    setError(''); setPending(options); setCode(issueCode()); setEntered(''); setAttempts(0); setResends(0); setStage('verify')
  }
  function verify() {
    if (!pending) return
    if (entered === code) {
      if (!create(pending)) setError('账号未能保存到此浏览器。请检查可用存储空间，或刷新页面后重试。')
      return
    }
    const next = attempts + 1
    setAttempts(next); setEntered('')
    if (next >= 3) { setStage('failed'); return }
    setError(`验证码不正确，还可尝试 ${3 - next} 次。`)
  }
  function resend() {
    if (resends >= 2) { setStage('failed'); return }
    setCode(issueCode()); setEntered(''); setAttempts(0); setResends(resends + 1); setError('')
  }
  return <main className="onboarding"><section>
    <div className="onboard-brand"><img className="brand-mark" src="/brand-icon.png" alt=""/> <span>Claude</span></div>
    {stage === 'details' && <><h1>开始一段新的对话</h1><p>创建一个仅保存在此浏览器中的虚拟身份。</p>
      <label>称呼<input value={name} onChange={e => setName(e.target.value)} placeholder="你的名字" autoFocus/></label>
      <label>所在地区<select value={region} onChange={e => setRegion(e.target.value as Region)}>{['亚太','北美','欧洲','其他地区','模拟不支持地区'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>注册方式<select value={method} onChange={e => setMethod(e.target.value)}><option>虚拟邮箱</option><option>模拟邀请</option><option>模拟工作账号</option></select></label>
      <label>虚构手机号尾号<input inputMode="numeric" maxLength={4} value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g,'').slice(0,4))} placeholder="任意四位数字；请勿填写真实号码"/></label>
      {error && <p className="onboard-error" role="alert">{error}</p>}
      <button className="solid" onClick={begin}>继续验证 <ArrowRight size={16}/></button>
      <small>非官方本地体验。不会发送真实短信，不收集真实手机号、密码或付款资料。</small>
    </>}
    {stage === 'verify' && <><h1>验证虚拟号码</h1><p>验证码仅在此页面生成，用于模拟短信确认。账号尚未创建。</p>
      <div className="simulation-code">SIM-••••-{phone} · 本地验证码 <strong>{code}</strong></div>
      <label>六位验证码<input inputMode="numeric" maxLength={6} value={entered} onChange={e => setEntered(e.target.value.replace(/\D/g,'').slice(0,6))} placeholder="输入上方验证码" autoFocus/></label>
      {error && <p className="onboard-error" role="alert">{error}</p>}
      <button className="solid" disabled={entered.length !== 6} onClick={verify}>完成验证</button>
      <button className="onboard-link" disabled={resends >= 2} onClick={resend}>重新发送本地验证码（剩余 {2 - resends} 次）</button>
      <button className="onboard-link" onClick={() => {setStage('details');setError('')}}>返回修改资料</button>
    </>}
    {stage === 'blocked' && <div className="onboard-blocked"><ShieldAlert size={28}/><h1>{reason?.title}</h1><p>{reason?.detail}</p><small>这是虚构的地区准入场景，不代表 Anthropic 或 Cloudflare 的实际拦截页面、路径或状态码。</small><button className="solid" onClick={() => setStage('details')}>返回修改地区</button></div>}
    {stage === 'failed' && <div className="onboard-blocked"><ShieldAlert size={28}/><h1>验证未完成</h1><p>本次虚拟号码验证超过尝试次数。账号没有创建。</p><button className="solid" onClick={() => {setStage('details');setError('');setAttempts(0)}}>重新开始注册</button></div>}
  </section></main>
}
