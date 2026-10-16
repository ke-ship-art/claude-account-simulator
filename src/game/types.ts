export type Mode = 'normal' | 'hard' | 'chaos' | 'lab'
export type Plan = 'free' | 'pro' | 'max5' | 'max20'
export type Model = 'haiku' | 'sonnet' | 'opus' | 'claude-fable-5-1' | 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-5-5'
export type AccountStatus = 'active' | 'challenge' | 'warned' | 'throttled' | 'review' | 'frozen' | 'banned'
export type EventCode = 'signup' | 'message' | 'burst' | 'new_account_load' | 'region_jump' | 'network_change' | 'device_change' | 'unsupported_region' | 'login_failure' | 'verification_failure' | 'automation' | 'payment_issue' | 'shared_session' | 'behavior_shift' | 'stable_day' | 'verification_passed' | 'false_positive' | 'appeal_submitted' | 'appeal_granted' | 'appeal_denied' | 'review_clear' | 'subscription_change' | 'random_event' | 'manual_probe' | 'policy_pattern'
export type Region = '北美' | '欧洲' | '亚太' | '其他地区' | '模拟不支持地区'
export type Network = '家庭宽带' | '移动网络' | '公司网络' | '数据中心网络' | '公共 Wi-Fi'
export type Reputation = '良好' | '一般' | '较差'
export type Device = '桌面电脑' | '笔记本电脑' | '平板' | '手机'

export interface Environment { region: Region; network: Network; reputation: Reputation; device: Device; browser: string; concurrentSessions: number }
export interface RiskEvent { id: string; at: number; code: EventCode; label: string; weight: number; halfLifeHours: number; detail: string; confirmed: boolean }
export interface TimelineEntry { id: string; at: number; category: 'system' | 'risk' | 'usage' | 'billing' | 'appeal'; title: string; body: string; visible: boolean }
export type MessageOutcome = 'generating' | 'normal' | 'model_refusal' | 'prefilter_refusal' | 'provider_block' | 'network_error' | 'service_error' | 'cancelled' | 'stream_interrupted'
export interface Message { id: string; role: 'user' | 'assistant'; text: string; at: number; model?: Model; outcome?: MessageOutcome; requestId?: string; attachment?: { name: string; size: number; text?: string } }
export interface Chat { id: string; title: string; createdAt: number; updatedAt: number; pinned: boolean; messages: Message[]; projectId?: string }
export interface Project { id: string; name: string; description: string; createdAt: number }
export interface PendingCheck { id: string; createdAt: number; dueAt: number; code: EventCode; trigger: string; reason: string; status: 'pending' | 'completed' | 'skipped'; completedAt?: number; result?: string; scoreAtRun?: number }
export interface Appeal { id: string; submittedAt: number; dueAt: number; text: string; stage: 'pending' | 'needs_info' | 'granted' | 'denied'; resolution?: string; supplement?: string }
export interface Invoice { id: string; at: number; plan: Plan; amount: number; result: 'paid' | 'failed' | 'refund'; note: string; refundOf?: string }
export interface Notification { id: string; at: number; title: string; body: string; read: boolean; tone: 'info' | 'warning' | 'danger' | 'success' }
export interface RiskSnapshot { at: number; score: number; trust: number; status: AccountStatus }
export interface AccountStats { messagesSent: number; daysActive: number; reviewsSurvived: number; appealsWon: number; restrictions: number; regionChanges: number; exploredEvents: EventCode[]; peakRisk: number; upgradedAt?: number; lastMessageAt?: number; rapidMessages: number; safeDays: number }
export interface Account {
  id: string; name: string; virtualEmail: string; emailProvider: string; signupMethod: string; persona: string;
  mode: Mode; seed: number; rng: number; sequence?: number; now: number; createdAt: number; lastDailyTick: number;
  plan: Plan; nextBillingAt?: number; cancelAt?: number; status: AccountStatus; statusSince: number; restrictionUntil?: number; loggedIn: boolean;
  balance: number; sessionUsed: number; sessionResetAt: number; weeklyUsed: number; weeklyResetAt: number;
  environment: Environment; initialEnvironment: Environment; trust: number; stability: number; paymentRisk: number;
  labConfig?: RiskConfig;
  labWeights?: Partial<Record<EventCode, number>>;
  riskEvents: RiskEvent[]; timeline: TimelineEntry[]; riskHistory: RiskSnapshot[]; lastTransition: string;
  chats: Chat[]; activeChatId?: string; appeals: Appeal[]; invoices: Invoice[]; notifications: Notification[];
  projects?: Project[]; pendingChecks?: PendingCheck[]; policyRefusals?: number; lastPolicyRefusalAt?: number; virtualPhone?: string; verificationAttempts?: number;
  artifactEdits?: Record<string,string>;
  gateOverride?: 'signup' | 'network' | 'service';
  sandboxPaymentOutcome?: 'success' | 'failure';
  stats: AccountStats; achievements: string[]; outcome?: string;
}
export interface GameStore { version: 1; accounts: Account[]; currentId?: string; savedAtWall?: number; lifetime: { appealsWon: number; discovered: EventCode[]; achievements: string[] } }
export interface SignupOptions { name: string; region: Region; network: Network; reputation: Reputation; device: Device; browser: string; emailProvider: string; signupMethod: string; persona: string; mode: Mode; seed: number; virtualPhone?: string }
export interface RiskConfig { sensitivity: number; randomness: number; decayMultiplier: number }
