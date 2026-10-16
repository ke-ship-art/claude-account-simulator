import type { Account } from './types'

export interface Artifact { id: string; chatId: string; messageId: string; chatTitle: string; language: string; content: string; previewable: boolean; at: number }

export function extractArtifacts(account: Account): Artifact[] {
  const artifacts: Artifact[] = []
  const fence = /(?:^|\n)```(html|svg|jsx|tsx|react)\s*\n([\s\S]*?)\n```/gi
  for (const chat of account.chats) for (const message of chat.messages) {
    if (message.role !== 'assistant') continue
    let match: RegExpExecArray | null, index = 0
    fence.lastIndex = 0
    while ((match = fence.exec(message.text))) {
      const language = match[1].toLowerCase()
      const original = match[2].trim()
      if (!original) continue
      const id = `${message.id}:${index++}`
      artifacts.push({ id, chatId: chat.id, messageId: message.id, chatTitle: chat.title, language, content: account.artifactEdits?.[id] ?? original, previewable: language === 'html' || language === 'svg', at: message.at })
    }
  }
  return artifacts.sort((a,b)=>b.at-a.at)
}

export function sandboxDocument(artifact: Artifact): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">`
  return artifact.language === 'svg' ? `<!doctype html><html><head>${policy}<style>body{margin:16px}</style></head><body>${artifact.content}</body></html>` : `<!doctype html><html><head>${policy}</head><body>${artifact.content}</body></html>`
}
