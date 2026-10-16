import type { Account } from './types'

export interface SearchHit { id: string; chatId: string; chatTitle: string; messageId?: string; at: number; snippet: string; matchStart: number; matchEnd: number }

export function searchAccount(account: Account, query: string): SearchHit[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return []
  const hits: SearchHit[] = []
  for (const chat of account.chats) {
    const titlePosition = chat.title.toLocaleLowerCase().indexOf(needle)
    if (titlePosition >= 0) hits.push({ id: `${chat.id}:title`, chatId: chat.id, chatTitle: chat.title, at: chat.updatedAt, snippet: chat.title, matchStart: titlePosition, matchEnd: titlePosition + needle.length })
    for (const message of chat.messages) {
      const haystack = message.text.toLocaleLowerCase()
      let from = 0, found = 0
      while (found < 5) {
        const position = haystack.indexOf(needle, from)
        if (position < 0) break
        const start = Math.max(0, position - 55)
        const end = Math.min(message.text.length, position + needle.length + 95)
        hits.push({ id: `${message.id}:${position}`, chatId: chat.id, chatTitle: chat.title, messageId: message.id, at: message.at, snippet: `${start?'…':''}${message.text.slice(start,end)}${end<message.text.length?'…':''}`, matchStart: position - start + (start ? 1 : 0), matchEnd: position - start + needle.length + (start ? 1 : 0) })
        from = position + Math.max(needle.length, 1)
        found++
      }
    }
  }
  return hits.sort((a,b)=>b.at-a.at)
}
