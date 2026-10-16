import { ACHIEVEMENTS } from './game/data'
import type { Account, GameStore } from './game/types'

export default function CareerPanel({ account, store }: { account: Account; store: GameStore }) {
  const stats = [
    ['已发送消息', account.stats.messagesSent],
    ['账号模拟天数', account.stats.daysActive],
    ['连续平稳日', account.stats.safeDays],
    ['历史限制', account.stats.restrictions],
    ['审核后恢复', account.stats.reviewsSurvived],
    ['申诉成功', account.stats.appealsWon],
    ['地区变化', account.stats.regionChanges],
    ['事件种类', account.stats.exploredEvents.length],
  ]
  return <section className="dev-card career-panel">
    <h2>账号生涯与成就</h2>
    <div className="career-stats">{stats.map(([label,value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <div className="career-badges">{ACHIEVEMENTS.map(item => {
      const unlocked = account.achievements.includes(item.id) || (item.id === 'appeal_master' && store.lifetime.achievements.includes(item.id))
      return <div className={unlocked ? 'unlocked' : ''} key={item.id}><b>{item.icon.startsWith('/') ? <img className="achievement-mark" src={item.icon} alt="" /> : item.icon}</b><span><strong>{item.title}</strong><small>{item.detail}</small></span><em>{unlocked ? '已解锁' : '未解锁'}</em></div>
    })}</div>
    <p>所有账号累计申诉成功 {store.lifetime.appealsWon} 次，发现 {store.lifetime.discovered.length} 种风险事件。</p>
    <details><summary>查看当前账号原始状态 JSON</summary><pre>{JSON.stringify(account,null,2)}</pre></details>
  </section>
}
