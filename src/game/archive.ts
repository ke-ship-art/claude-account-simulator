import { EVENT_LABELS, MODE_INFO, MODEL_INFO, PLAN_INFO } from './data'
import type { Account } from './types'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max = 300_000) => typeof value === 'string' && value.length <= max
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
const time = (value: unknown) => number(value) && Math.abs(value as number) <= 8.64e15
const list = (value: unknown, max: number, valid: (item: unknown) => boolean) => Array.isArray(value) && value.length <= max && value.every(valid)
const oneOf = (value: unknown, choices: readonly string[]) => typeof value === 'string' && choices.includes(value)
const regions = ['北美', '欧洲', '亚太', '其他地区', '模拟不支持地区']
const networks = ['家庭宽带', '移动网络', '公司网络', '数据中心网络', '公共 Wi-Fi']
const reputations = ['良好', '一般', '较差']
const devices = ['桌面电脑', '笔记本电脑', '平板', '手机']
const statuses = ['active', 'challenge', 'warned', 'throttled', 'review', 'frozen', 'banned']
const outcomes = ['generating', 'normal', 'model_refusal', 'prefilter_refusal', 'provider_block', 'network_error', 'service_error', 'cancelled', 'stream_interrupted']

function environment(value: unknown) {
  return record(value) && oneOf(value.region, regions) && oneOf(value.network, networks) && oneOf(value.reputation, reputations)
    && oneOf(value.device, devices) && text(value.browser, 100) && number(value.concurrentSessions)
    && (value.concurrentSessions as number) >= 1 && (value.concurrentSessions as number) <= 100
}

function message(value: unknown) {
  return record(value) && text(value.id, 150) && oneOf(value.role, ['user', 'assistant']) && text(value.text)
    && time(value.at) && (value.model === undefined || oneOf(value.model, Object.keys(MODEL_INFO)))
    && (value.outcome === undefined || oneOf(value.outcome, outcomes))
    && (value.requestId === undefined || text(value.requestId, 150))
    && (value.attachment === undefined || record(value.attachment) && text(value.attachment.name, 255)
      && number(value.attachment.size) && (value.attachment.size as number) >= 0
      && (value.attachment.text === undefined || text(value.attachment.text)))
}

function chat(value: unknown) {
  return record(value) && text(value.id, 150) && text(value.title, 500) && time(value.createdAt)
    && time(value.updatedAt) && typeof value.pinned === 'boolean' && list(value.messages, 5000, message)
    && (value.projectId === undefined || text(value.projectId, 150))
}

function riskEvent(value: unknown) {
  return record(value) && text(value.id, 150) && time(value.at) && oneOf(value.code, Object.keys(EVENT_LABELS))
    && text(value.label, 200) && text(value.detail, 2000) && number(value.weight)
    && number(value.halfLifeHours) && (value.halfLifeHours as number) > 0
    && typeof value.confirmed === 'boolean'
}

function pendingCheck(value: unknown) {
  return record(value) && text(value.id, 150) && time(value.dueAt) && oneOf(value.code, Object.keys(EVENT_LABELS))
    && text(value.reason, 2000) && oneOf(value.status, ['pending', 'completed', 'skipped'])
    && text(value.trigger, 2000) && (value.result === undefined || text(value.result, 2000))
    && (value.scoreAtRun === undefined || number(value.scoreAtRun))
    && (value.createdAt === undefined || time(value.createdAt))
    && (value.completedAt === undefined || time(value.completedAt))
}

export function parseAccountArchive(raw: string): Account {
  let data: unknown
  try { data = JSON.parse(raw) } catch { throw new Error('档案不是有效的 JSON 文件。') }
  if (!record(data) || data.format !== 'claude-local-account-v1') throw new Error('这不是本项目的账号档案。')
  const account = data.account
  if (!record(account)) throw new Error('档案缺少必要的账号数据。')
  const strings = ['name', 'virtualEmail', 'emailProvider', 'signupMethod', 'persona', 'lastTransition']
  const numbers = ['seed', 'rng', 'balance', 'sessionUsed', 'weeklyUsed', 'trust', 'stability', 'paymentRisk']
  const times = ['now', 'createdAt', 'lastDailyTick', 'statusSince', 'sessionResetAt', 'weeklyResetAt']
  if (!text(account.id, 100) || !/^[a-z0-9_-]+$/i.test(account.id as string)
    || strings.some(key => !text(account[key], 2000)) || numbers.some(key => !number(account[key]))
    || times.some(key => !time(account[key])) || !oneOf(account.mode, Object.keys(MODE_INFO))
    || !oneOf(account.plan, Object.keys(PLAN_INFO)) || !oneOf(account.status, statuses)
    || typeof account.loggedIn !== 'boolean' || !environment(account.environment)
    || !environment(account.initialEnvironment) || !record(account.stats)
    || (account.sequence !== undefined && (!number(account.sequence) || (account.sequence as number) < 0))
    || ['nextBillingAt', 'cancelAt', 'restrictionUntil', 'lastPolicyRefusalAt'].some(key => account[key] !== undefined && !time(account[key]))
    || (account.policyRefusals !== undefined && (!number(account.policyRefusals) || (account.policyRefusals as number) < 0))
    || (account.verificationAttempts !== undefined && (!number(account.verificationAttempts) || (account.verificationAttempts as number) < 0))
    || (account.gateOverride !== undefined && !oneOf(account.gateOverride, ['signup', 'network', 'service']))
    || (account.sandboxPaymentOutcome !== undefined && !oneOf(account.sandboxPaymentOutcome, ['success', 'failure']))
    || (account.virtualPhone !== undefined && !text(account.virtualPhone, 100))
    || (account.outcome !== undefined && !text(account.outcome, 2000))) throw new Error('档案的账号基础资料无效。')
  const stats = account.stats
  if (!list(stats.exploredEvents, 100, item => text(item, 100))
    || ['messagesSent', 'daysActive', 'reviewsSurvived', 'appealsWon', 'restrictions', 'regionChanges', 'peakRisk', 'rapidMessages', 'safeDays'].some(key => !number(stats[key]) || (stats[key] as number) < 0)
    || ['upgradedAt', 'lastMessageAt'].some(key => stats[key] !== undefined && !time(stats[key]))) throw new Error('档案中的生涯统计无效。')
  if (!list(account.chats, 1000, chat) || !list(account.riskEvents, 1000, riskEvent)
    || !list(account.riskHistory, 1000, item => record(item) && time(item.at) && number(item.score) && number(item.trust) && oneOf(item.status, statuses))
    || !list(account.timeline, 1000, item => record(item) && text(item.id, 150) && time(item.at) && oneOf(item.category, ['system', 'risk', 'usage', 'billing', 'appeal']) && text(item.title, 500) && text(item.body, 5000) && typeof item.visible === 'boolean')
    || !list(account.notifications, 1000, item => record(item) && text(item.id, 150) && time(item.at) && text(item.title, 500) && text(item.body, 5000) && typeof item.read === 'boolean' && oneOf(item.tone, ['info', 'warning', 'danger', 'success']))
    || !list(account.appeals, 1000, item => record(item) && text(item.id, 150) && time(item.submittedAt) && time(item.dueAt) && text(item.text) && oneOf(item.stage, ['pending', 'needs_info', 'granted', 'denied']) && (item.resolution === undefined || text(item.resolution, 5000)) && (item.supplement === undefined || text(item.supplement)))
    || !list(account.invoices, 1000, item => record(item) && text(item.id, 150) && time(item.at) && oneOf(item.plan, Object.keys(PLAN_INFO)) && number(item.amount) && oneOf(item.result, ['paid', 'failed', 'refund']) && text(item.note, 2000) && (item.refundOf === undefined || text(item.refundOf, 150)))
    || !list(account.achievements, 1000, item => text(item, 100))
    || account.pendingChecks !== undefined && !list(account.pendingChecks, 1000, pendingCheck)) throw new Error('档案中的对话或事件记录无效。')
  if (account.projects !== undefined && !list(account.projects, 1000, item => record(item) && text(item.id, 150) && text(item.name, 500) && text(item.description, 2000) && time(item.createdAt))) throw new Error('档案中的项目记录无效。')
  if (account.activeChatId !== undefined && (!text(account.activeChatId, 150) || !(account.chats as {id:string}[]).some(chat => chat.id === account.activeChatId))) throw new Error('档案的当前对话引用无效。')
  if (account.labConfig !== undefined && (!record(account.labConfig) || ['sensitivity', 'randomness', 'decayMultiplier'].some(key => !number((account.labConfig as Record<string, unknown>)[key]) || ((account.labConfig as Record<string, number>)[key]) <= 0))) throw new Error('档案的风控实验参数无效。')
  if (account.labWeights !== undefined && (!record(account.labWeights) || Object.entries(account.labWeights).some(([key,value]) => !oneOf(key, Object.keys(EVENT_LABELS)) || !number(value) || (value as number) < 0 || (value as number) > 2.5))) throw new Error('档案的风控事件权重无效。')
  if (account.artifactEdits !== undefined && (!record(account.artifactEdits) || Object.keys(account.artifactEdits).length > 5000 || Object.entries(account.artifactEdits).some(([key,value]) => !text(key, 200) || !text(value)))) throw new Error('档案的 Artifact 编辑记录无效。')
  return account as unknown as Account
}
