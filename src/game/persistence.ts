import { emptyStore } from './engine'
import { DAY } from './data'
import type { GameStore } from './types'

export const STORAGE_KEY = 'account-weather-save-v1'

export function loadStore(storage: Pick<Storage, 'getItem'> = localStorage): GameStore {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return emptyStore()
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1 || !('accounts' in parsed) || !Array.isArray(parsed.accounts)) return emptyStore()
    const store = parsed as GameStore
    for (const account of store.accounts) {
      if (account.plan !== 'free' && !account.nextBillingAt) {
        const lastPaid = account.invoices?.find(invoice => invoice.result === 'paid')?.at ?? account.now
        account.nextBillingAt = Math.max(lastPaid + 30 * DAY, account.now + DAY)
      }
    }
    return store
  } catch { return emptyStore() }
}

export function saveStore(store: GameStore, storage: Pick<Storage, 'setItem'> = localStorage) {
  storage.setItem(STORAGE_KEY, JSON.stringify(store))
}
