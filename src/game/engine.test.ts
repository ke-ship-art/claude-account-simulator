import { describe, expect, it } from 'vitest'
import { HOUR, PLAN_INFO } from './data'
import { addAccount, advanceTime, cancelSubscription, changeEnvironment, changeMode, changePlan, createAccount, createChat, emptyStore, injectEvent, messageCost, refundLatestInvoice, replaceAccount, riskScore, sendMessage, submitAppeal, updateRiskWeight } from './engine'
import { loadStore, saveStore } from './persistence'
import type { Account, SignupOptions } from './types'

const start = Date.UTC(2026, 0, 1)
const options: SignupOptions = { name: '测试者', region: '亚太', network: '家庭宽带', reputation: '良好', device: '笔记本电脑', browser: 'Chrome', emailProvider: 'postbox', signupMethod: '虚拟邮箱', persona: '普通用户', mode: 'lab', seed: 173 }
const account = (overrides: Partial<SignupOptions> = {}) => createAccount({ ...options, ...overrides }, start)

describe('risk engine', () => {
  it('decays old evidence while retaining account history', () => {
    const initial = account()
    const afterSignal = injectEvent(initial, 'automation', 2)
    const peak = riskScore(afterSignal)
    const later = advanceTime(afterSignal, 24 * 14)
    expect(peak).toBeGreaterThan(riskScore(initial))
    expect(riskScore(later)).toBeLessThan(peak)
    expect(later.riskEvents.some(e => e.code === 'automation')).toBe(true)
  })

  it('replays identical actions from the same seed', () => {
    function run() {
      let a = account()
      a = changeEnvironment(a, { region: '欧洲' })
      a = injectEvent(a, 'shared_session', 1.5)
      a = injectEvent(a, 'automation', 1.5)
      return { score: riskScore(a), status: a.status, rng: a.rng, events: a.riskEvents.map(e => e.weight) }
    }
    expect(run()).toEqual(run())
  })

  it('does not consume risk randomness to number ordinary records', () => {
    const a = account()
    expect(createChat(a).rng).toBe(a.rng)
  })

  it('runs delayed checks at their scheduled time during a long jump', () => {
    const changed = changeEnvironment(account(), { region: '欧洲', network: '数据中心网络', concurrentSessions: 4 })
    const dueAt = changed.pendingChecks![0].dueAt
    const later = advanceTime(changed, 24)
    expect(later.pendingChecks?.[0].completedAt).toBe(dueAt)
    expect(later.pendingChecks?.[0].status).toBe('completed')
  })

  it('transitions through escalating responses based on accumulated evidence', () => {
    let a = account()
    a = injectEvent(a, 'region_jump', 1.5)
    a = injectEvent(a, 'shared_session', 2)
    a = injectEvent(a, 'automation', 2)
    expect(riskScore(a)).toBeGreaterThan(70)
    expect(['throttled', 'review', 'frozen', 'banned']).toContain(a.status)
    expect(a.stats.restrictions).toBeGreaterThan(0)
    expect(a.lastTransition.length).toBeGreaterThan(10)
  })

  it('uses a separate quota window and model costs', () => {
    let a = account()
    expect(messageCost('你好', 'opus')).toBeGreaterThan(messageCost('你好', 'haiku'))
    a = sendMessage(a, '你好', 'sonnet', '模拟回答')
    expect(a.sessionUsed).toBeGreaterThan(0)
    expect(a.weeklyUsed).toBe(a.sessionUsed)
    const b = advanceTime(a, 5)
    expect(b.sessionUsed).toBe(0)
    expect(b.weeklyUsed).toBeGreaterThan(0)
  })

  it('changes actual capacity and virtual balance on upgrade', () => {
    const a = account()
    const pro = changePlan(a, 'pro')
    expect(pro.plan).toBe('pro')
    expect(pro.balance).toBe(a.balance - PLAN_INFO.pro.price)
    expect(PLAN_INFO[pro.plan].session).toBeGreaterThan(PLAN_INFO[a.plan].session)
    expect(pro.invoices[0].result).toBe('paid')
  })

  it('renews paid subscriptions and honors scheduled cancellation', () => {
    const pro = changePlan(account(), 'pro')
    const renewed = advanceTime(pro, 30 * 24)
    expect(renewed.plan).toBe('pro')
    expect(renewed.invoices.filter(i => i.result === 'paid')).toHaveLength(2)
    const scheduled = cancelSubscription(renewed)
    expect(scheduled.cancelAt).toBe(scheduled.nextBillingAt)
    const ended = advanceTime(scheduled, 30 * 24)
    expect(ended.plan).toBe('free')
    expect(ended.cancelAt).toBeUndefined()
  })

  it('does not force a renewal failure when the internal ledger runs out', () => {
    const pro = changePlan(account(), 'pro')
    pro.balance = 0
    const renewed = advanceTime(pro, 30 * 24)
    expect(renewed.invoices).toHaveLength(2)
    expect(renewed.invoices[0].result).toBe('paid')
    expect(renewed.plan).toBe('pro')
  })

  it('allows a single timely virtual refund and changes the plan', () => {
    const pro = changePlan(account(), 'pro')
    const refunded = refundLatestInvoice(pro)
    expect(refunded.plan).toBe('free')
    expect(refunded.invoices[0].result).toBe('refund')
    expect(refunded.invoices[0].refundOf).toBe(pro.invoices[0].id)
    expect(refunded.balance).toBe(pro.balance + PLAN_INFO.pro.price)
    expect(() => refundLatestInvoice(refunded)).toThrow()
    expect(() => refundLatestInvoice(advanceTime(pro, 8 * 24))).toThrow()
  })

  it('applies laboratory event multipliers to actual risk', () => {
    const base = injectEvent(account(), 'automation')
    const tuned = updateRiskWeight(base, 'automation', 2)
    expect(riskScore(tuned)).toBeGreaterThan(riskScore(base))
    expect(tuned.riskHistory.at(-1)?.score).toBe(riskScore(tuned))
    expect(riskScore(updateRiskWeight(base, 'automation', 0))).toBeLessThan(riskScore(base))
  })

  it('uses the selected difficulty in the same risk engine', () => {
    const a = injectEvent(account(), 'automation')
    expect(riskScore(changeMode(a, 'hard'))).toBeGreaterThan(riskScore(a))
    expect(changeMode(a, 'chaos').mode).toBe('chaos')
  })
})

describe('appeals and persistence', () => {
  const restricted = (): Account => {
    let a = account({ reputation: '较差', network: '数据中心网络' })
    for (let n = 0; n < 4; n++) a = injectEvent(a, 'automation', 2)
    return a
  }

  it('resolves a submitted appeal using game time and keeps the record', () => {
    let a = restricted()
    expect(['review', 'frozen', 'banned']).toContain(a.status)
    a = submitAppeal(a, '我在今天切换了虚拟网络与设备，愿意提供具体使用时间供复核。')
    expect(a.appeals[0].stage).toBe('pending')
    const dueAt = a.appeals[0].dueAt
    a = advanceTime(a, 49)
    expect(['granted', 'denied', 'needs_info']).toContain(a.appeals[0].stage)
    expect(a.timeline.some(e => e.category === 'appeal')).toBe(true)
    expect(a.timeline.find(e => e.title === '申诉复核结果')?.at).toBe(dueAt)
  })

  it('can grant or deny appeals under different reproducible seeds', () => {
    const outcomes = new Set<string>()
    for (let seed = 1; seed <= 100; seed++) {
      let a = account({ seed })
      a = injectEvent(a, 'shared_session', 1.3)
      a = injectEvent(a, 'automation', 1.4)
      if (!['review', 'frozen', 'banned', 'throttled'].includes(a.status)) continue
      a = submitAppeal(a, '我在同一天同时使用了手机和电脑，网络也因通勤发生变化。请复核这些信号是否代表真正异常，我可以提供完整的模拟使用时间记录。')
      a = advanceTime(a, 49)
      outcomes.add(a.appeals[0].stage)
      if (a.appeals[0].stage === 'granted') {
        expect(a.status).toBe('active')
        expect(a.stats.appealsWon).toBe(1)
      }
      if (outcomes.has('granted') && outcomes.has('denied')) break
    }
    expect(outcomes.has('granted')).toBe(true)
    expect(outcomes.has('denied')).toBe(true)
  })

  it('rejects invalid time and short appeal text', () => {
    expect(() => advanceTime(account(), -1)).toThrow()
    expect(() => advanceTime(account(), Infinity)).toThrow()
    expect(() => submitAppeal(restricted(), '太短')).toThrow()
  })

  it('persists the account lifecycle and falls back safely on corrupt data', () => {
    const storage = new Map<string, string>()
    const adapter = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } }
    let store = addAccount(emptyStore(), account())
    store = replaceAccount(store, injectEvent(store.accounts[0], 'automation'))
    saveStore(store, adapter)
    expect(loadStore(adapter)).toEqual(store)
    storage.set('account-weather-save-v1', '{bad')
    expect(loadStore(adapter).accounts).toEqual([])
  })

  it('advances virtual time after reopening a saved browser session', () => {
    const storage = new Map<string, string>()
    const adapter = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } }
    const original = account()
    saveStore(addAccount(emptyStore(), original), adapter, 1_000_000_000_000)
    const reopened = loadStore(adapter, 1_000_000_000_000 + 6 * 3600_000)
    expect(reopened.accounts[0].now).toBe(original.now + 6 * 3600_000)
    expect(reopened.accounts[0].sessionResetAt).toBeGreaterThan(reopened.accounts[0].now)
  })

  it('saves the real-time checkpoint atomically with the account archive', () => {
    const storage = new Map<string, string>()
    const writes: string[] = []
    const adapter = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { writes.push(key); if (key === 'account-weather-wall-clock-v1') throw new Error('second write failed'); storage.set(key, value) },
    }
    const original = addAccount(emptyStore(), account())
    const savedAt = 1_000_000_000_000
    saveStore(original, adapter, savedAt)
    expect(writes).toEqual(['account-weather-save-v1'])
    expect(JSON.parse(storage.get('account-weather-save-v1')!).savedAtWall).toBe(savedAt)
    expect(loadStore(adapter, savedAt + HOUR).accounts[0].now).toBe(original.accounts[0].now + HOUR)
  })

  it('migrates an existing paid save to a billing schedule', () => {
    const storage = new Map<string, string>()
    const adapter = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } }
    const paid = changePlan(account(), 'pro')
    delete paid.nextBillingAt
    saveStore(addAccount(emptyStore(), paid), adapter)
    const loaded = loadStore(adapter)
    expect(loaded.accounts[0].nextBillingAt).toBeGreaterThan(loaded.accounts[0].now)
    expect(cancelSubscription(loaded.accounts[0]).cancelAt).toBe(loaded.accounts[0].nextBillingAt)
  })
})
