export type PolicyResult = { kind: 'safe' | 'caution' | 'refuse'; reason?: string }

// Experimental local classifier. It is deliberately narrow and is not an Anthropic policy implementation.
export function classifyContent(text: string): PolicyResult {
  const input = text.trim().toLowerCase()
  if (/如何(制造|制作).{0,12}(爆炸物|炸弹)|how to (build|make) (a )?bomb/i.test(input)) {
    return { kind: 'refuse', reason: '这个请求在本地内容检查中被拦截。你可以换一种安全的方式提问。' }
  }
  if (/自伤|自杀|伤害自己|suicide|self.harm/i.test(input)) {
    return { kind: 'caution', reason: '此话题需要谨慎处理，实际回复由所选模型提供。' }
  }
  return { kind: 'safe' }
}

// Only labels a clear opening refusal. The provider's text is never rewritten.
export function detectModelRefusal(text: string): boolean {
  return /^(?:很抱歉|抱歉|对不起)[，,。\s]*(?:我)?(?:不能|无法|没法)(?:帮助|提供|协助|完成|回答)|^(?:sorry|i(?:'m| am) sorry)[,.\s]+(?:i\s+)?(?:can't|cannot|won't|am unable to)\s+(?:help|provide|assist)/i.test(text.trim())
}
