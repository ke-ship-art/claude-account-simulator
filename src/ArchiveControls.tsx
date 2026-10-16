import { useRef, useState } from 'react'
import { parseAccountArchive } from './game/archive'
import { EVENT_LABELS, MODE_INFO } from './game/data'
import { changeMode, updateRiskWeight } from './game/engine'
import type { Account, EventCode, Mode } from './game/types'

const RULES: EventCode[] = ['region_jump','network_change','device_change','login_failure','automation','shared_session','payment_issue','behavior_shift','policy_pattern']

type Props = {
  account: Account
  apply: (fn: (account: Account) => Account) => void
  fork: (seed: number) => void
  restore: (account: Account) => void
}

export default function ArchiveControls({ account, apply, fork, restore }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [notice,setNotice] = useState('')

  function exportArchive() {
    const content = JSON.stringify({ format:'claude-local-account-v1', account }, null, 2)
    const url = URL.createObjectURL(new Blob([content], { type:'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `claude-local-${account.id.replace(/[^a-z0-9-]/gi,'')}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setNotice('账号档案已下载到本机。')
  }

  async function importArchive(file?: File) {
    if (!file) return
    try {
      if (file.size > 5_000_000) throw new Error('档案文件不能超过 5 MB。')
      restore(parseAccountArchive(await file.text()))
      setNotice('档案已作为新账号导入；原档案仍保留。')
    } catch (error) { setNotice(error instanceof Error ? error.message : '无法读取档案。') }
  }

  return <section className="dev-card archive-settings">
    <h2>实验档案与规则</h2>
    <p>规则开关立即影响当前账号的风险计算。同种子新档案会保留原档案，便于重复执行相同操作。</p>
    <label>实验模式<select value={account.mode} onChange={e => apply(a => changeMode(a,e.target.value as Mode))}>{(Object.keys(MODE_INFO) as Mode[]).map(mode => <option key={mode} value={mode}>{MODE_INFO[mode].name} · {MODE_INFO[mode].description}</option>)}</select></label>
    <div className="rule-grid">{RULES.map(code => <label key={code}><input type="checkbox" checked={(account.labWeights?.[code] ?? 1) > 0} onChange={e => apply(a => updateRiskWeight(a, code, e.target.checked ? 1 : 0))}/>{EVENT_LABELS[code] ?? code}</label>)}</div>
    <div className="archive-actions"><button onClick={() => fork(account.seed)}>同种子新档案</button><button onClick={() => fork(Math.floor(Math.random()*2**31))}>随机种子新档案</button><button onClick={exportArchive}>导出账号档案</button><button onClick={() => input.current?.click()}>导入账号档案</button><input ref={input} type="file" accept=".json,application/json" hidden onChange={e => { void importArchive(e.target.files?.[0]); e.target.value='' }}/></div>
    {notice && <p role="status" className="archive-notice">{notice}</p>}
  </section>
}
