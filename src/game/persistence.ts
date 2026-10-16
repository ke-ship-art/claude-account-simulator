import { advanceTime, emptyStore, finishGeneration } from './engine'
import { DAY, HOUR } from './data'
import { parseAccountArchive } from './archive'
import type { GameStore } from './types'

export const STORAGE_KEY = 'account-weather-save-v1'
export const CLOCK_KEY = 'account-weather-wall-clock-v1'
export const GENERATION_LEASE_KEY = 'account-weather-generation-leases-v1'
const LEASE_TTL = 15_000

function readLeases(storage: Pick<Storage, 'getItem'>): Record<string, number> {
  try {
    const value = JSON.parse(storage.getItem(GENERATION_LEASE_KEY) ?? '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

export function setGenerationLease(requestId: string, active: boolean, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage, now = Date.now()) {
  const leases = readLeases(storage)
  for (const [id, updated] of Object.entries(leases)) if (!Number.isFinite(updated) || now - updated > LEASE_TTL) delete leases[id]
  if (active) leases[requestId] = now
  else delete leases[requestId]
  storage.setItem(GENERATION_LEASE_KEY, JSON.stringify(leases))
}

export function loadStore(storage: Pick<Storage, 'getItem'> = localStorage, wallNow = Date.now()): GameStore {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return emptyStore()
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1 || !('accounts' in parsed) || !Array.isArray(parsed.accounts)) return emptyStore()
    const store = parsed as GameStore
    if (store.accounts.length > 1000 || store.currentId !== undefined && !store.accounts.some(account => account?.id === store.currentId)
      || !store.lifetime || !Number.isFinite(store.lifetime.appealsWon)
      || !Array.isArray(store.lifetime.discovered) || !Array.isArray(store.lifetime.achievements)) return emptyStore()
    const leases = readLeases(storage)
    for (let index = 0; index < store.accounts.length; index++) {
      let account = store.accounts[index]
      const interrupted: Array<{requestId:string;text:string}> = []
      for (const chat of account.chats ?? []) for (const message of chat.messages ?? []) {
        if (message.outcome === 'generating' && !(message.requestId && Number.isFinite(leases[message.requestId]) && wallNow - leases[message.requestId] < LEASE_TTL)) {
          if (message.requestId) interrupted.push({requestId:message.requestId,text:message.text || '页面关闭前尚未收到模型回复。'})
          else { message.outcome = 'stream_interrupted'; message.text ||= '页面关闭前尚未收到模型回复。' }
        }
      }
      for (const item of interrupted) account = finishGeneration(account,item.requestId,item.text,'stream_interrupted')
      store.accounts[index] = account
      account.pendingChecks = (account.pendingChecks ?? []).map(check => ({
        ...check,
        createdAt: Number.isFinite(check.createdAt) ? check.createdAt : Math.min(account.now, check.dueAt - 2 * HOUR),
        trigger: check.trigger ?? '旧版存档中的环境变更',
        status: check.status ?? 'pending',
      }))
      if (account.plan !== 'free' && !account.nextBillingAt) {
        const lastPaid = account.invoices?.find(invoice => invoice.result === 'paid')?.at ?? account.now
        account.nextBillingAt = Math.max(lastPaid + 30 * DAY, account.now + DAY)
      }
      parseAccountArchive(JSON.stringify({ format: 'claude-local-account-v1', account }))
    }
    const lastSaved = Number.isFinite(store.savedAtWall) ? store.savedAtWall! : Number(storage.getItem(CLOCK_KEY))
    const elapsedHours = (wallNow - lastSaved) / HOUR
    if (lastSaved > 0 && Number.isFinite(elapsedHours) && elapsedHours > 0) {
      store.accounts = store.accounts.map(account => elapsedHours >= 1 / 60 || account.pendingChecks?.some(check => check.status === 'pending' && check.dueAt <= account.now + elapsedHours * HOUR)
        ? advanceTime(account, Math.min(elapsedHours, 8760), true) : account)
    }
    return store
  } catch { return emptyStore() }
}

export function saveStore(store: GameStore, storage: Pick<Storage, 'setItem'> = localStorage, wallNow = Date.now()) {
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...store, savedAtWall: wallNow }))
  store.savedAtWall = wallNow
}
