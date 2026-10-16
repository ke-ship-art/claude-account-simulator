import type { Account, SignupOptions } from './types'

export type AccessResult = { kind: 'allowed' | 'region' | 'signup' | 'verification' | 'verification_failed' | 'session' | 'network' | 'service' | 'restricted'; title: string; detail: string }

export function assessSignup(options: SignupOptions): AccessResult {
  if (options.region === '模拟不支持地区') return { kind: 'region', title: '此地区暂不可用', detail: '这个虚构地区不在本地模拟服务范围内，因此不会创建账号。请返回并选择其他地区。' }
  if (!options.name.trim()) return { kind: 'signup', title: '还不能创建身份', detail: '请填写虚拟账号的称呼。' }
  if (!/^\d{4}$/.test(options.virtualPhone ?? '')) return { kind: 'signup', title: '虚拟号码格式不正确', detail: '请输入四位数字作为本地模拟号码尾号；不要填写真实手机号。' }
  return { kind: 'allowed', title: '', detail: '' }
}

export function assessAccess(account: Account): AccessResult {
  if (account.environment.region === '模拟不支持地区') return { kind: 'region', title: '此地区暂不可用', detail: '当前虚构地区不在本地服务范围内。你可以在开发者工具中调整环境后重试。' }
  if (account.gateOverride === 'signup') return { kind: 'signup', title: '无法完成注册', detail: '本地准入检查没有通过。请在开发者工具中检查虚构身份资料。' }
  if (account.gateOverride === 'network') return { kind: 'network', title: '连接暂时不可用', detail: '无法验证当前虚构网络环境。请稍后重试或更换网络设置。' }
  if (account.gateOverride === 'service') return { kind: 'service', title: '服务暂时不可用', detail: '这是一个可在开发者工具中解除的测试场景。' }
  if (account.status === 'challenge' && (account.verificationAttempts ?? 0) >= 3) return { kind: 'verification_failed', title: '验证暂时无法继续', detail: '三次本地确认均未通过。请推进模拟时间，等待当前安全挑战到期后再尝试。' }
  if (account.status === 'challenge') return { kind: 'verification', title: '确认这是你本人', detail: `请使用本地确认码验证虚构号码${account.virtualPhone ? ` ${account.virtualPhone}` : ''}；剩余 ${3 - (account.verificationAttempts ?? 0)} 次。` }
  if (['review', 'frozen', 'banned'].includes(account.status)) return { kind: 'restricted', title: account.status === 'banned' ? '此账号已停用' : account.status === 'frozen' ? '账号暂时无法使用' : '账号正在审核', detail: account.lastTransition }
  if (!account.loggedIn) return { kind: 'session', title: '登录已结束', detail: '重新进入此本地虚拟账号即可继续。' }
  return { kind: 'allowed', title: '', detail: '' }
}
