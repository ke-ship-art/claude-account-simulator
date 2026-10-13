import { ACHIEVEMENTS, DAY, EVENT_LABELS, HOUR, MODE_INFO, MODEL_INFO, PLAN_INFO } from './data'
import type { Account, AccountStatus, Appeal, Chat, Environment, EventCode, GameStore, Message, Model, Plan, RiskConfig, RiskEvent, SignupOptions } from './types'

const clamp = (n: number, min = 0, max = 100) => Math.min(max, Math.max(min, n))
const copy = <T,>(value: T): T => structuredClone(value)
const id = (account: Account, prefix: string) => `${prefix}-${account.now.toString(36)}-${Math.floor(nextRandom(account) * 1e8).toString(36)}`
export const emptyStore = (): GameStore => ({ version: 1, accounts: [], lifetime: { appealsWon: 0, discovered: [], achievements: [] } })

export function nextRandom(account: Account): number {
  let x = account.rng || 0x6d2b79f5
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5
  account.rng = x >>> 0
  return account.rng / 4294967296
}

function log(account: Account, category: Account['timeline'][number]['category'], title: string, body: string, visible = true) {
  account.timeline.unshift({ id: id(account, 'log'), at: account.now, category, title, body, visible })
  account.timeline = account.timeline.slice(0, 320)
}
function notify(account: Account, title: string, body: string, tone: Account['notifications'][number]['tone'] = 'info') {
  account.notifications.unshift({ id: id(account, 'note'), at: account.now, title, body, tone, read: false })
  account.notifications = account.notifications.slice(0, 80)
}

export function riskContributions(account: Account) {
  const sensitivity = (account.labConfig ?? MODE_INFO[account.mode].config).sensitivity
  const decay = (account.labConfig ?? MODE_INFO[account.mode].config).decayMultiplier
  return account.riskEvents.map(event => ({
    event,
    contribution: event.weight * sensitivity * (account.labWeights?.[event.code] ?? 1) * Math.pow(.5, Math.max(0, account.now - event.at) / (event.halfLifeHours * HOUR * decay)),
  })).filter(x => Math.abs(x.contribution) > .08)
}

export function riskScore(account: Account): number {
  const evidence = riskContributions(account).reduce((sum, item) => sum + item.contribution, 0)
  const history = account.stats.restrictions * 2.1
  return Math.round(clamp(17 + evidence + account.paymentRisk * .48 + (100 - account.stability) * .16 + history - account.trust * .29))
}

function snapshot(account: Account) {
  const point = { at: account.now, score: riskScore(account), trust: Math.round(account.trust), status: account.status }
  const last = account.riskHistory.at(-1)
  if (!last || last.at !== point.at || last.score !== point.score || last.status !== point.status) account.riskHistory.push(point)
  account.riskHistory = account.riskHistory.slice(-240)
  account.stats.peakRisk = Math.max(account.stats.peakRisk, point.score)
}

function unlock(account: Account, key: string) {
  if (account.achievements.includes(key)) return
  const achievement = ACHIEVEMENTS.find(a => a.id === key)
  if (!achievement) return
  account.achievements.push(key)
  notify(account, `成就解锁 · ${achievement.title}`, achievement.detail, 'success')
}

function checkAchievements(account: Account) {
  if (account.stats.messagesSent >= 1) unlock(account, 'first_chat')
  if (account.stats.safeDays >= 100) unlock(account, 'steady_100')
  if (account.stats.reviewsSurvived >= 2 && account.status === 'active') unlock(account, 'survivor')
  if (account.stats.upgradedAt && account.now - account.stats.upgradedAt <= 3 * DAY && ['review', 'frozen', 'banned'].includes(account.status)) unlock(account, 'paid_then_review')
  if (account.stats.appealsWon >= 1) unlock(account, 'comeback')
  if (account.stats.exploredEvents.length >= 8) unlock(account, 'researcher')
}

function setStatus(account: Account, status: AccountStatus, reason: string, hours?: number) {
  if (account.status === status) return
  account.status = status
  account.statusSince = account.now
  account.lastTransition = reason
  account.restrictionUntil = hours ? account.now + hours * HOUR : undefined
  if (['throttled', 'review', 'frozen', 'banned'].includes(status)) {
    account.stats.restrictions++
    account.stats.safeDays = 0
  }
  if (['frozen', 'banned'].includes(status)) account.loggedIn = false
  const titles: Record<AccountStatus, string> = {
    active: '账号已恢复正常', challenge: '请完成额外验证', warned: '检测到异常活动', throttled: '部分功能暂时限流', review: '账号正在审核', frozen: '账号暂时冻结', banned: '账号已终止',
  }
  const tone = status === 'active' ? 'success' : status === 'banned' || status === 'frozen' ? 'danger' : 'warning'
  notify(account, titles[status], reason, tone)
  log(account, 'risk', titles[status], reason)
  checkAchievements(account)
  snapshot(account)
}

function evaluate(account: Account, code: EventCode) {
  if (account.status === 'banned') return
  const score = riskScore(account)
  const severe = account.riskEvents.filter(e => e.weight >= 18 && account.now - e.at < 7 * DAY).length
  const rand = nextRandom(account)
  const jitter = (rand - .5) * 16 * (account.labConfig ?? MODE_INFO[account.mode].config).randomness
  const pressure = score + jitter
  if (pressure >= 91 && severe >= 3 && account.stats.restrictions >= 1) {
    const result = score >= 98 && severe >= 4 ? 'banned' : 'frozen'
    setStatus(account, result, `多项近期证据叠加，系统将账号置于${result === 'banned' ? '终止' : '冻结'}状态。`, result === 'frozen' ? 48 : undefined)
  } else if (pressure >= 76 && severe >= 2) {
    setStatus(account, account.status === 'review' && score > 88 ? 'frozen' : 'review', '近期环境与行为信号需要进一步核查。', 36)
  } else if (pressure >= 61 && account.status !== 'review') {
    setStatus(account, 'throttled', '系统暂时降低使用速率，并继续观察后续行为。', 18)
  } else if (pressure >= 43 && !['challenge', 'throttled', 'review', 'frozen'].includes(account.status)) {
    setStatus(account, code === 'login_failure' || code === 'region_jump' ? 'challenge' : 'warned', '检测到与账号惯常使用方式不同的信号。', 12)
  } else if (score < 29 && ['warned', 'throttled'].includes(account.status) && account.restrictionUntil && account.now >= account.restrictionUntil) {
    setStatus(account, 'active', '持续稳定的使用使临时提醒自动解除。')
  }
}

function signal(account: Account, code: EventCode, weight: number, detail: string, halfLifeHours = 60, confirmed = false) {
  const event: RiskEvent = { id: id(account, 'risk'), at: account.now, code, label: EVENT_LABELS[code] ?? code, weight, halfLifeHours, detail, confirmed }
  account.riskEvents.push(event)
  account.riskEvents = account.riskEvents.slice(-300)
  if (!account.stats.exploredEvents.includes(code)) account.stats.exploredEvents.push(code)
  log(account, 'risk', event.label, detail, false)
  evaluate(account, code)
  checkAchievements(account)
  snapshot(account)
}

export function createAccount(options: SignupOptions, now = Date.now()): Account {
  const env: Environment = { region: options.region, network: options.network, reputation: options.reputation, device: options.device, browser: options.browser, concurrentSessions: 1 }
  const acc: Account = {
    id: `acc-${now.toString(36)}-${(options.seed >>> 0).toString(36)}`, name: options.name.trim() || '旅行者',
    virtualEmail: `${(options.name.trim() || 'player').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'player'}-${Math.abs(options.seed) % 10000}@${options.emailProvider}.sim`,
    emailProvider: options.emailProvider, signupMethod: options.signupMethod, persona: options.persona,
    mode: options.mode, seed: options.seed >>> 0, rng: options.seed >>> 0 || 1, now, createdAt: now, lastDailyTick: now,
    plan: 'free', status: 'active', statusSince: now, loggedIn: true, balance: MODE_INFO[options.mode].startingBalance,
    sessionUsed: 0, sessionResetAt: now + 5 * HOUR, weeklyUsed: 0, weeklyResetAt: now + 7 * DAY,
    environment: env, initialEnvironment: copy(env), trust: 30 + (options.signupMethod === '模拟邀请' ? 4 : options.signupMethod === '模拟工作账号' ? 6 : 0) + (options.emailProvider === 'northstar' ? 2 : options.emailProvider === 'cloudmail' ? -1 : 0) + (options.persona === '谨慎观察者' ? 3 : options.persona === '高频用户' ? -2 : 0), stability: 86, paymentRisk: 0,
    riskEvents: [], timeline: [], riskHistory: [], lastTransition: '账号创建完成，开始正常观察。', chats: [], appeals: [], invoices: [], notifications: [],
    stats: { messagesSent: 0, daysActive: 0, reviewsSurvived: 0, appealsWon: 0, restrictions: 0, regionChanges: 0, exploredEvents: [], peakRisk: 0, rapidMessages: 0, safeDays: 0 }, achievements: [],
  }
  log(acc, 'system', '虚拟账号已创建', `使用 ${options.signupMethod} 注册，初始画像为${options.persona}。`)
  const signupWeight = (options.reputation === '较差' ? 11 : options.reputation === '一般' ? 4 : 0) + (options.network === '数据中心网络' ? 9 : options.network === '公共 Wi-Fi' ? 3 : 0) + (options.region === '模拟不支持地区' ? 22 : 0)
  if (signupWeight) signal(acc, 'signup', signupWeight, '注册环境被记入账号初始观察记录。', 96)
  snapshot(acc)
  notify(acc, '欢迎来到 Account Weather', '所有账号与风控规则都存在于本地模拟世界。', 'info')
  return acc
}

export function createChat(account: Account): Account {
  const a = copy(account)
  const chat: Chat = { id: id(a, 'chat'), title: '新对话', createdAt: a.now, updatedAt: a.now, pinned: false, messages: [] }
  a.chats.unshift(chat); a.activeChatId = chat.id
  return a
}

export function updateChat(account: Account, chatId: string, patch: Partial<Pick<Chat, 'title' | 'pinned'>>): Account {
  const a = copy(account), chat = a.chats.find(c => c.id === chatId)
  if (chat) Object.assign(chat, patch)
  return a
}

export function deleteChat(account: Account, chatId: string): Account {
  const a = copy(account)
  a.chats = a.chats.filter(c => c.id !== chatId)
  if (a.activeChatId === chatId) a.activeChatId = a.chats[0]?.id
  return a
}

function resetQuota(account: Account) {
  if (account.now >= account.sessionResetAt) {
    account.sessionUsed = 0
    account.sessionResetAt = account.now + 5 * HOUR
    log(account, 'usage', '会话额度已恢复', '新的模拟五小时使用窗口开始。')
  }
  if (account.now >= account.weeklyResetAt) {
    account.weeklyUsed = 0
    account.weeklyResetAt = account.now + 7 * DAY
    log(account, 'usage', '每周额度已恢复', '新的模拟七日窗口开始。')
  }
}

export function messageCost(text: string, model: Model, attachmentSize = 0, contextLength = 0) {
  return MODEL_INFO[model].cost + Math.ceil(text.length / 85) + Math.ceil(contextLength / 1400) + (attachmentSize ? 6 + Math.ceil(attachmentSize / 40_000) : 0)
}

export function canSend(account: Account, model: Model, cost: number): string | null {
  if (!account.loggedIn) return '请先重新登录虚拟账号。'
  if (['review', 'frozen', 'banned'].includes(account.status)) return '账号当前受到限制，请查看通知或提交申诉。'
  if (account.status === 'challenge') return '请先完成额外验证。'
  if (account.plan === 'free' && model === 'opus') return 'Opus 在本游戏中需要 Pro 或更高订阅。'
  if (account.status === 'throttled' && account.stats.lastMessageAt && account.now - account.stats.lastMessageAt < 15 * 60_000) return '临时限流中。请推进模拟时间后重试。'
  const plan = PLAN_INFO[account.plan]
  if (account.sessionUsed + cost > plan.session) return '本次模拟五小时额度已用尽。可等待恢复或升级虚拟订阅。'
  if (account.weeklyUsed + cost > plan.weekly) return '本周模拟额度已用尽。可推进时间等待恢复。'
  return null
}

export function sendMessage(account: Account, text: string, model: Model, reply: string, attachment?: { name: string; size: number }): Account {
  const a = copy(account)
  resetQuota(a)
  const trimmed = text.trim()
  if (!trimmed && !attachment) throw new Error('请输入消息或选择附件。')
  let chat = a.chats.find(c => c.id === a.activeChatId)
  if (!chat) { a.chats.unshift({ id: id(a, 'chat'), title: '新对话', createdAt: a.now, updatedAt: a.now, pinned: false, messages: [] }); chat = a.chats[0]; a.activeChatId = chat.id }
  const contextLength = chat.messages.reduce((n, m) => n + m.text.length, 0)
  if (contextLength + trimmed.length > MODEL_INFO[model].context) throw new Error('当前对话已接近上下文上限，请创建新对话。')
  const cost = messageCost(trimmed, model, attachment?.size, contextLength)
  const blocked = canSend(a, model, cost)
  if (blocked) throw new Error(blocked)
  const recent = a.stats.lastMessageAt ? a.now - a.stats.lastMessageAt : Infinity
  if (recent < 3 * 60_000) a.stats.rapidMessages++
  else a.stats.rapidMessages = Math.max(0, a.stats.rapidMessages - 1)
  const userMessage: Message = { id: id(a, 'msg'), role: 'user', text: trimmed, at: a.now, attachment }
  const aiMessage: Message = { id: id(a, 'msg'), role: 'assistant', text: reply, at: a.now, model }
  chat.messages.push(userMessage, aiMessage)
  chat.updatedAt = a.now
  if (chat.title === '新对话') chat.title = trimmed.slice(0, 26) || attachment?.name || '附件讨论'
  a.sessionUsed += cost; a.weeklyUsed += cost; a.stats.messagesSent++; a.stats.lastMessageAt = a.now
  a.trust = clamp(a.trust + .12)
  log(a, 'usage', `使用 ${MODEL_INFO[model].name}`, `消耗 ${cost} 游戏额度，五小时窗口已使用 ${a.sessionUsed}/${PLAN_INFO[a.plan].session}。`)
  if (a.stats.rapidMessages >= 4 && a.stats.rapidMessages % 3 === 1) signal(a, 'burst', (8 + a.stats.rapidMessages * 1.5) * (a.persona === '高频用户' ? .82 : a.persona === '开发者' ? .76 : a.persona === '谨慎观察者' ? 1.1 : 1), '连续消息间隔很短，系统记录了高频使用节奏。', 24)
  if (a.now - a.createdAt < 2 * HOUR && a.sessionUsed >= PLAN_INFO[a.plan].session * .65 && a.stats.messagesSent % 3 === 0) signal(a, 'new_account_load', 11, '新账号在短时间内消耗了较多额度。', 40)
  if (a.stats.messagesSent >= 8 && recent < 60_000 && a.stats.rapidMessages >= 7) signal(a, 'automation', a.persona === '开发者' ? 13 : 17, '连续、规律的高频调用与常见手动节奏差异较大。', 72)
  if (a.sessionUsed >= PLAN_INFO[a.plan].session) unlock(a, 'power_user')
  checkAchievements(a); snapshot(a)
  return a
}

export function changeEnvironment(account: Account, changes: Partial<Environment>): Account {
  const a = copy(account), previous = copy(a.environment)
  Object.assign(a.environment, changes)
  if (changes.region && changes.region !== previous.region) {
    a.stats.regionChanges++
    const recentJumps = a.riskEvents.filter(e => e.code === 'region_jump' && a.now - e.at < 24 * HOUR).length
    a.stability = clamp(a.stability - (recentJumps ? 11 : 5))
    signal(a, 'region_jump', 8 + recentJumps * 8 + (changes.region === '模拟不支持地区' ? 13 : 0), `登录地区从${previous.region}变化为${changes.region}。`, 72)
    if (changes.region === '模拟不支持地区') signal(a, 'unsupported_region', 24, '虚构服务区域规则要求额外审查。', 120, true)
  }
  if (changes.network && changes.network !== previous.network) {
    a.stability = clamp(a.stability - 5)
    signal(a, 'network_change', 6 + (changes.network === '数据中心网络' ? 11 : 0), `网络从${previous.network}变为${changes.network}。`, 54)
  }
  if (changes.reputation && changes.reputation !== previous.reputation) signal(a, 'network_change', changes.reputation === '较差' ? 13 : changes.reputation === '良好' ? -5 : 4, `虚拟 IP 声誉变为${changes.reputation}。`, 60)
  if ((changes.device && changes.device !== previous.device) || (changes.browser && changes.browser !== previous.browser)) {
    a.stability = clamp(a.stability - 4)
    signal(a, 'device_change', 7 + (a.riskEvents.filter(e => e.code === 'device_change' && a.now - e.at < DAY).length * 5), '设备或浏览器指纹发生变化。', 60)
  }
  if (changes.concurrentSessions && changes.concurrentSessions > 2 && changes.concurrentSessions !== previous.concurrentSessions) signal(a, 'shared_session', 12 + changes.concurrentSessions * 4, `${changes.concurrentSessions} 个虚拟会话同时在线。`, 84)
  log(a, 'system', '使用环境已更新', '当前设备与网络参数已经写入账号历史。')
  snapshot(a)
  return a
}

export function recordLoginFailure(account: Account): Account {
  const a = copy(account)
  const recent = a.riskEvents.filter(e => e.code === 'login_failure' && a.now - e.at < 6 * HOUR).length
  signal(a, 'login_failure', 7 + recent * 5, '虚拟登录凭据校验未通过。', 36)
  if (recent >= 2 && a.status === 'active') setStatus(a, 'challenge', '连续登录失败，需要完成额外验证。', 6)
  return a
}

export function verifyAccount(account: Account, success: boolean): Account {
  const a = copy(account)
  if (!success) { signal(a, 'verification_failure', 12, '安全确认未通过。', 72); return a }
  signal(a, 'verification_passed', -18, '完成了本地模拟安全确认。', 48, true)
  a.trust = clamp(a.trust + 4)
  if (a.status === 'challenge' || a.status === 'warned') setStatus(a, 'active', '安全确认通过，正常使用已恢复。')
  a.loggedIn = true
  return a
}

export function login(account: Account): Account {
  const a = copy(account)
  if (['frozen', 'banned'].includes(a.status)) { notify(a, '登录受限', '当前状态下无法进入聊天。请查看申诉入口。', 'danger'); return a }
  a.loggedIn = true
  log(a, 'system', '虚拟账号登录', '本次登录只发生在浏览器本地。')
  return a
}
export function logout(account: Account): Account { const a = copy(account); a.loggedIn = false; log(a, 'system', '已退出虚拟账号', '可随时重新进入本地存档。'); return a }

export function changePlan(account: Account, plan: Plan, paymentFails = false): Account {
  const a = copy(account)
  if (plan === a.plan) return a
  const old = a.plan, price = PLAN_INFO[plan].price
  if (paymentFails) {
    a.paymentRisk = clamp(a.paymentRisk + 17)
    a.invoices.unshift({ id: id(a, 'invoice'), at: a.now, plan, amount: price, result: 'failed', note: '手动模拟的支付异常，没有发生真实交易。' })
    signal(a, 'payment_issue', 20, '虚拟付款状态异常，订单未生效。', 96)
    notify(a, '虚拟支付未完成', '订阅没有变更，游戏币未扣除。', 'warning')
    return a
  }
  if (price > a.balance) throw new Error(`游戏币不足：需要 ${price}，当前 ${a.balance}。`)
  if (price) a.balance -= price
  a.plan = plan
  a.cancelAt = undefined
  a.nextBillingAt = price ? a.now + 30 * DAY : undefined
  a.invoices.unshift({ id: id(a, 'invoice'), at: a.now, plan, amount: price, result: 'paid', note: '游戏内虚拟订阅，不涉及真实支付。' })
  if (price > PLAN_INFO[old].price) a.stats.upgradedAt = a.now
  log(a, 'billing', `订阅已变更为 ${PLAN_INFO[plan].name}`, `${price} 游戏币已记入虚拟账单。`)
  notify(a, '订阅变更完成', `现在使用 ${PLAN_INFO[plan].name}，五小时额度上限为 ${PLAN_INFO[plan].session}。`, 'success')
  signal(a, 'subscription_change', 0, `从 ${PLAN_INFO[old].name} 调整为 ${PLAN_INFO[plan].name}。`, 12)
  return a
}

export function cancelSubscription(account: Account): Account {
  const a = copy(account)
  if (a.plan === 'free' || !a.nextBillingAt) throw new Error('当前没有可取消的虚拟订阅。')
  if (a.cancelAt) throw new Error('已经安排在本周期结束时取消。')
  a.cancelAt = a.nextBillingAt
  log(a, 'billing', '已安排取消虚拟订阅', `当前计划可使用至 ${new Date(a.cancelAt).toLocaleString('zh-CN')}。`)
  notify(a, '订阅已安排取消', '本模拟周期结束后自动回到 Free。', 'info')
  return a
}

export function addVirtualFunds(account: Account): Account {
  const a = copy(account)
  a.balance += 200
  log(a, 'billing', '补充游戏币', '领取 200 游戏币；这是本地游戏资源。')
  notify(a, '游戏币已补充', '获得 200 枚游戏币。', 'success')
  return a
}

export function submitAppeal(account: Account, text: string): Account {
  const a = copy(account)
  if (!['review', 'frozen', 'banned', 'throttled'].includes(a.status)) throw new Error('当前状态无需申诉。')
  if (a.appeals.some(x => ['pending', 'needs_info'].includes(x.stage))) throw new Error('已有正在处理的申诉。')
  if (a.appeals.filter(x => x.stage === 'denied').length >= 3) throw new Error('此账号已达到模拟申诉次数上限。')
  if (text.trim().length < 20) throw new Error('请至少写 20 个字，说明时间、环境和希望复核的内容。')
  const appeal: Appeal = { id: id(a, 'appeal'), submittedAt: a.now, dueAt: a.now + (12 + Math.floor(nextRandom(a) * 37)) * HOUR, text: text.trim(), stage: 'pending' }
  a.appeals.unshift(appeal)
  log(a, 'appeal', '申诉已提交', `预计在 ${new Date(appeal.dueAt).toLocaleString('zh-CN')}（模拟时间）完成复核。`)
  notify(a, '已收到申诉', '可以推进模拟时间查看结果。', 'info')
  signal(a, 'appeal_submitted', 0, '账号提交了复核说明。', 12)
  return a
}

export function supplementAppeal(account: Account, text: string): Account {
  const a = copy(account), appeal = a.appeals.find(x => x.stage === 'needs_info')
  if (!appeal) throw new Error('当前没有需要补充的申诉。')
  if (text.trim().length < 12) throw new Error('请补充至少 12 个字的说明。')
  appeal.supplement = text.trim(); appeal.stage = 'pending'; appeal.dueAt = a.now + (8 + Math.floor(nextRandom(a) * 17)) * HOUR
  log(a, 'appeal', '补充材料已收到', '申诉重新进入模拟审核队列。')
  return a
}

function resolveAppeal(a: Account, appeal: Appeal) {
  const severe = a.riskEvents.filter(e => e.confirmed && e.weight >= 18 && a.now - e.at < 14 * DAY).length
  const detailed = Math.min(16, Math.floor((appeal.text.length + (appeal.supplement?.length ?? 0)) / 25))
  const history = a.appeals.filter(x => x.stage === 'denied').length
  const score = riskScore(a)
  const chance = clamp(48 + a.trust * .29 + detailed - score * .58 - severe * 12 - history * 14 + (a.status === 'review' ? 10 : 0), 4, 86)
  const roll = nextRandom(a) * 100
  if (roll < chance) {
    appeal.stage = 'granted'; appeal.resolution = severe ? '复核后认为限制可以解除，但部分历史信号仍保留。' : '复核发现证据不足，账号恢复使用。'
    a.trust = clamp(a.trust + 9); a.stats.appealsWon++; a.stats.reviewsSurvived++
    signal(a, 'appeal_granted', -24, appeal.resolution, 120, true)
    setStatus(a, 'active', appeal.resolution)
    a.loggedIn = true
    notify(a, '申诉成功', appeal.resolution, 'success')
    unlock(a, 'comeback')
  } else if (roll < chance + 17 && !appeal.supplement && appeal.text.length < 70) {
    appeal.stage = 'needs_info'; appeal.resolution = '请补充具体使用时间、设备变化及可能的误报原因。'
    notify(a, '需要补充申诉信息', appeal.resolution, 'warning')
    log(a, 'appeal', '审核需要补充材料', appeal.resolution)
  } else {
    appeal.stage = 'denied'; appeal.resolution = `复核仍发现 ${severe ? '多项已确认' : '较多'}异常信号，暂无法解除限制。`
    signal(a, 'appeal_denied', 5, appeal.resolution, 96, true)
    notify(a, '申诉未通过', appeal.resolution, 'danger')
    if (a.status === 'review') setStatus(a, 'frozen', '审核后维持限制，可稍后再次申诉。', 48)
    if (history >= 1 && a.status === 'frozen' && score > 72) setStatus(a, 'banned', '多次申诉后仍有高强度证据，账号终止。')
  }
  log(a, 'appeal', '申诉复核结果', appeal.resolution ?? '等待更多信息。')
  snapshot(a); checkAchievements(a)
}

function dailyEvent(a: Account) {
  const frequency = a.mode === 'chaos' ? .48 : a.mode === 'hard' ? .24 : a.mode === 'lab' ? .16 : .15
  if (nextRandom(a) > frequency) return
  const roll = nextRandom(a)
  if (roll < .28) {
    signal(a, 'false_positive', 5, '一次普通的会话波动被暂时记录，后续复核可能将其排除。', 16)
    if (nextRandom(a) < .48) signal(a, 'false_positive', -10, '自动复核认定先前的会话波动属于误报。', 20, true)
  } else if (roll < .52) {
    a.balance += 25
    log(a, 'billing', '虚拟体验赠额', '获得 25 游戏币。')
    notify(a, '获得体验赠额', '25 游戏币已加入本地钱包。', 'success')
  } else if (roll < .78) {
    signal(a, 'behavior_shift', 7 + Math.floor(nextRandom(a) * 8), '后台观察到与近期行为基线不同的使用峰值。', 32)
  } else {
    a.trust = clamp(a.trust + 3)
    log(a, 'system', '稳定使用记录', '连续的正常活动提高了账号信誉。')
  }
}

function processBilling(a: Account) {
  while (a.nextBillingAt && a.now >= a.nextBillingAt && a.plan !== 'free') {
    const dueAt = a.nextBillingAt
    if (a.cancelAt && dueAt >= a.cancelAt) {
      a.plan = 'free'; a.nextBillingAt = undefined; a.cancelAt = undefined
      log(a, 'billing', '订阅已取消', '模拟账期结束，账号已回到 Free。')
      notify(a, '已回到 Free', '虚拟订阅按计划结束。', 'info')
      break
    }
    const price = PLAN_INFO[a.plan].price
    if (a.balance < price) {
      a.invoices.unshift({ id: id(a, 'invoice'), at: dueAt, plan: a.plan, amount: price, result: 'failed', note: '游戏币不足，虚拟续费失败。' })
      a.paymentRisk = clamp(a.paymentRisk + 12)
      signal(a, 'payment_issue', 14, '虚拟续费时游戏币不足。', 96)
      a.plan = 'free'; a.nextBillingAt = undefined; a.cancelAt = undefined
      notify(a, '虚拟订阅续费失败', '已回到 Free；没有任何真实扣款。', 'warning')
      break
    }
    a.balance -= price
    a.invoices.unshift({ id: id(a, 'invoice'), at: dueAt, plan: a.plan, amount: price, result: 'paid', note: '30 天模拟账期自动续费。' })
    a.nextBillingAt += 30 * DAY
    log(a, 'billing', '虚拟订阅已续费', `扣除 ${price} 游戏币，下一账期开始。`)
  }
}

export function advanceTime(account: Account, hours: number): Account {
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 365) throw new Error('推进时间必须在 0 到 8760 小时之间。')
  const a = copy(account), target = a.now + hours * HOUR
  while (a.lastDailyTick + DAY <= target) {
    a.lastDailyTick += DAY; a.now = a.lastDailyTick; a.stats.daysActive++
    if (['active', 'warned'].includes(a.status)) { a.stats.safeDays++; a.trust = clamp(a.trust + .55); a.stability = clamp(a.stability + 1.1) }
    else a.stats.safeDays = 0
    a.paymentRisk = clamp(a.paymentRisk - 1.2)
    dailyEvent(a)
    processBilling(a)
    if (a.stats.daysActive % 7 === 0) a.balance += 10
  }
  a.now = target
  processBilling(a)
  resetQuota(a)
  for (const appeal of a.appeals) if (appeal.stage === 'pending' && appeal.dueAt <= a.now) resolveAppeal(a, appeal)
  if (a.restrictionUntil && a.now >= a.restrictionUntil && !a.appeals.some(x => x.stage === 'pending')) {
    if (a.status === 'review') {
      if (riskScore(a) < 58) { a.stats.reviewsSurvived++; setStatus(a, 'active', '观察期结束，证据随时间衰减，账号恢复。') }
      else setStatus(a, 'frozen', '观察期结束，仍需申诉或等待进一步复核。', 48)
    } else if (a.status === 'frozen' && riskScore(a) < 43) { setStatus(a, 'active', '临时冻结期结束，账号恢复使用。'); a.loggedIn = true }
    else if (['throttled', 'warned', 'challenge'].includes(a.status)) setStatus(a, 'active', '临时安全措施已到期。')
  }
  log(a, 'system', '模拟时间已推进', `${hours} 小时已过去。`)
  checkAchievements(a); snapshot(a)
  return a
}

export function injectEvent(account: Account, code: EventCode, intensity = 1): Account {
  const a = copy(account)
  const weights: Partial<Record<EventCode, number>> = { burst: 18, region_jump: 19, network_change: 13, device_change: 13, unsupported_region: 26, login_failure: 12, verification_failure: 17, automation: 28, payment_issue: 25, shared_session: 27, behavior_shift: 16, false_positive: -17, stable_day: -11, manual_probe: 15 }
  const base = weights[code]
  if (base === undefined) throw new Error('这个事件不可手动注入。')
  signal(a, code, base * clamp(intensity, .25, 3), `实验室注入：${EVENT_LABELS[code] ?? code}（强度 ${intensity.toFixed(1)}）。`, code === 'unsupported_region' ? 120 : 72, code === 'unsupported_region' || code === 'payment_issue')
  if (code === 'stable_day') a.trust = clamp(a.trust + 3)
  if (code === 'payment_issue') a.paymentRisk = clamp(a.paymentRisk + 15)
  if (code === 'false_positive' && ['review', 'frozen'].includes(a.status) && riskScore(a) < 38) setStatus(a, 'active', '复核识别到误报，账号恢复。')
  snapshot(a)
  return a
}

export function updateRiskConfig(account: Account, config?: RiskConfig): Account {
  const a = copy(account)
  a.labConfig = config
  log(a, 'system', '实验参数已更新', config ? '风险敏感度、波动或衰减周期已调整。' : '恢复当前模式的默认参数。', false)
  snapshot(a)
  return a
}

export function updateRiskWeight(account: Account, code: EventCode, multiplier: number): Account {
  const a = copy(account)
  a.labWeights = { ...a.labWeights, [code]: clamp(multiplier, .25, 2.5) }
  log(a, 'system', '事件权重已更新', `${EVENT_LABELS[code] ?? code} 的实验权重设为 ${multiplier.toFixed(2)} 倍。`, false)
  snapshot(a)
  return a
}

export function addAccount(store: GameStore, account: Account): GameStore {
  const s = copy(store)
  s.accounts.unshift(account); s.currentId = account.id
  return s
}
export function replaceAccount(store: GameStore, account: Account): GameStore {
  const s = copy(store), index = s.accounts.findIndex(a => a.id === account.id)
  if (index < 0) throw new Error('找不到当前账号。')
  const prior = s.accounts[index]
  s.accounts[index] = account
  s.lifetime.appealsWon += Math.max(0, account.stats.appealsWon - prior.stats.appealsWon)
  for (const code of account.stats.exploredEvents) if (!s.lifetime.discovered.includes(code)) s.lifetime.discovered.push(code)
  for (const key of account.achievements) if (!s.lifetime.achievements.includes(key)) s.lifetime.achievements.push(key)
  if (s.lifetime.appealsWon >= 2 && !s.lifetime.achievements.includes('appeal_master')) s.lifetime.achievements.push('appeal_master')
  return s
}
