import type { EventCode, Mode, Model, Plan, RiskConfig } from './types'

export const HOUR = 3_600_000
export const DAY = HOUR * 24
export const PLAN_INFO: Record<Plan, { name: string; price: number; session: number; weekly: number; note: string }> = {
  free: { name: 'Free', price: 0, session: 100, weekly: Infinity, note: '适合偶尔探索' },
  pro: { name: 'Pro', price: 20, session: 500, weekly: 2600, note: '更多日常使用空间' },
  max5: { name: 'Max 5x', price: 100, session: 2500, weekly: 13000, note: '长时间连续使用' },
  max20: { name: 'Max 20x', price: 200, session: 10000, weekly: 52000, note: '高强度创作实验' },
}
export const MODEL_INFO: Record<Model, { name: string; cost: number; context: number; description: string }> = {
  haiku: { name: 'Haiku', cost: 9, context: 12000, description: '轻快 · 低消耗' },
  sonnet: { name: 'Sonnet', cost: 18, context: 24000, description: '平衡 · 日常首选' },
  opus: { name: 'Opus', cost: 34, context: 32000, description: '深入 · 高消耗' },
  'claude-fable-5-1': { name: 'Claude Fable 5.1', cost: 52, context: 1000000, description: '长程推理与复杂任务' },
  'claude-opus-5-5': { name: 'Claude Opus 5.5', cost: 34, context: 1000000, description: '深入思考与知识工作' },
  'claude-sonnet-5-5': { name: 'Claude Sonnet 5.5', cost: 18, context: 1000000, description: '速度与能力的平衡' },
  'claude-haiku-5-5': { name: 'Claude Haiku 5.5', cost: 9, context: 1000000, description: '快速日常任务' },
}
export const CURRENT_MODELS: Model[] = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
export const MODEL_META: Record<string, { family: string; version: string; apiId: string; contextTokens: number; maxOutputTokens: number; availability: string; maintained: boolean }> = {
  'claude-fable-5-1': { family: 'Fable', version: '5.1', apiId: 'claude-fable-5-1', contextTokens: 1000000, maxOutputTokens: 128000, availability: 'Max；Pro 需用量积分', maintained: true },
  'claude-opus-5-5': { family: 'Opus', version: '5.5', apiId: 'claude-opus-5-5', contextTokens: 1000000, maxOutputTokens: 128000, availability: 'Pro / Max', maintained: true },
  'claude-sonnet-5-5': { family: 'Sonnet', version: '5.5', apiId: 'claude-sonnet-5-5', contextTokens: 1000000, maxOutputTokens: 128000, availability: 'Free / Pro / Max', maintained: true },
  'claude-haiku-5-5': { family: 'Haiku', version: '5.5', apiId: 'claude-haiku-5-5', contextTokens: 1000000, maxOutputTokens: 128000, availability: 'Free / Pro / Max', maintained: true },
}
export const MODE_INFO: Record<Mode, { name: string; description: string; config: RiskConfig; startingBalance: number }> = {
  normal: { name: '普通', description: '温和而有悬念的账号生涯', config: { sensitivity: 1, randomness: 0.78, decayMultiplier: 1 }, startingBalance: 260 },
  hard: { name: '困难', description: '更紧的额度与更敏感的风控', config: { sensitivity: 1.27, randomness: 0.92, decayMultiplier: .82 }, startingBalance: 120 },
  chaos: { name: '混沌', description: '更多突发情况与戏剧性转折', config: { sensitivity: 1.1, randomness: 1.35, decayMultiplier: 1.1 }, startingBalance: 380 },
  lab: { name: '实验室', description: '透明、可控、可复现的规则试验', config: { sensitivity: 1, randomness: 1, decayMultiplier: 1 }, startingBalance: 1000 },
}
export const ACHIEVEMENTS = [
  { id: 'first_chat', icon: '/brand-icon.png', title: '开口第一句', detail: '发送第一条消息' },
  { id: 'steady_100', icon: '◌', title: '安然无恙', detail: '连续模拟使用 100 天，期间没有受到限制' },
  { id: 'survivor', icon: '↗', title: '九死一生', detail: '经历两次审核后依然正常使用' },
  { id: 'paid_then_review', icon: '◇', title: '氪金受害者', detail: '升级虚拟订阅后 3 天内进入审核' },
  { id: 'appeal_master', icon: '✉', title: '申诉达人', detail: '累计帮助两个虚拟账号申诉成功' },
  { id: 'researcher', icon: '⌘', title: '风控研究员', detail: '发现 8 种不同的风控事件' },
  { id: 'comeback', icon: '☀', title: '天气转晴', detail: '受限后通过申诉恢复使用' },
  { id: 'power_user', icon: '⚡', title: '额度管理师', detail: '在一个窗口内用完额度后等待恢复' },
]
export const EVENT_LABELS: Partial<Record<EventCode, string>> = {
  policy_pattern: '重复性内容策略异常',
  burst: '短时间密集使用', new_account_load: '新账号高负载', region_jump: '地区频繁变化', network_change: '网络环境变化', device_change: '设备特征变化', unsupported_region: '模拟不支持地区访问', login_failure: '登录失败', verification_failure: '验证异常', automation: '自动化调用痕迹', payment_issue: '虚拟支付异常', shared_session: '异常并发会话', behavior_shift: '使用模式骤变', stable_day: '稳定使用', false_positive: '误报复核', manual_probe: '实验室注入事件', subscription_change: '订阅状态变化', random_event: '随机生活事件', review_clear: '审核结束', verification_passed: '验证通过', appeal_submitted: '提交申诉', appeal_granted: '申诉成功', appeal_denied: '申诉未通过', signup: '账号创建', message: '发送消息',
}
