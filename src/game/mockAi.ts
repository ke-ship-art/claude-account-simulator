import type { Model } from './types'

const pick = <T,>(items: T[], seed: number) => items[Math.abs(seed) % items.length]
const hash = (text: string) => [...text].reduce((v, c) => ((v << 5) - v + c.charCodeAt(0)) | 0, 17)

export function mockReply(prompt: string, model: Model, name: string, attachment?: string): string {
  const q = prompt.trim()
  const lower = q.toLowerCase()
  const opening = pick([
    '我先把问题拆成几个可操作的部分。',
    '这个问题值得从目标、约束和下一步三个层面来看。',
    '可以。下面给你一个清晰、能立即使用的版本。',
    '我们先抓住最重要的判断依据，再处理细节。',
  ], hash(q + name))
  const subject = q.length > 65 ? `${q.slice(0, 62)}…` : q || `附件「${attachment ?? '文件'}」`
  if (/代码|编程|函数|javascript|typescript|python|react|bug|报错|api/i.test(lower)) {
    return `${opening}\n\n针对“${subject}”，建议先复现最小场景，然后把输入、预期输出和实际输出并列检查。\n\n\`\`\`ts\nfunction inspect(input: string) {\n  const normalized = input.trim()\n  if (!normalized) throw new Error('Input is empty')\n  return { value: normalized, length: normalized.length }\n}\n\`\`\`\n\n**下一步**：如果你提供一段具体代码或错误信息，我可以把这个示例改成更贴合你的方案。\n\n> 本回复由游戏内 Mock AI 生成，没有连接真实 Claude。`
  }
  if (/计划|安排|步骤|路线|学习|项目|任务/i.test(lower)) {
    return `${opening}\n\n### 关于“${subject}”的行动框架\n\n1. **明确结果**：写下一句可验证的完成标准。\n2. **拆分路径**：先完成最小闭环，再逐步提高质量。\n3. **安排反馈**：每完成一个阶段，就核对实际结果与预期的差异。\n\n如果时间有限，我会优先处理影响最大的第一步。你也可以告诉我期限与资源，我再把计划细化。\n\n> 游戏内 Mock AI · 模拟回复。`
  }
  if (/写|文案|邮件|故事|诗|介绍|润色|总结/i.test(lower)) {
    return `${opening}\n\n**草稿**\n\n> ${subject.replace(/[。.!！?？]$/, '')}。我们希望表达的核心并不复杂：先讲清背景，再说明想法，最后给出明确的下一步。语气保持自然，让读者能在第一遍阅读时理解重点。\n\n你可以告诉我目标读者和希望的语气，我可以再写一个更精炼或更有感染力的版本。\n\n> 游戏内 Mock AI · 模拟回复。`
  }
  if (/为什么|原因|解释|区别|是什么|如何|怎么/i.test(lower)) {
    return `${opening}\n\n**简短解释**：关于“${subject}”，通常需要区分表面现象与底层原因。先确认前提是否成立，再看有哪些可观察的证据，最后比较不同解释能否预测后续结果。\n\n- 如果关注实践，先做一个成本很低的小实验。\n- 如果关注准确性，记录条件和例外情况。\n- 如果关注选择，比较收益、代价与可逆性。\n\n这是模拟回答；你若给出更多上下文，我可以继续围绕你的具体问题展开。`
  }
  const depth = model === 'opus' ? '\n\n进一步看，可以把它放进更大的背景中：真正有用的答案往往取决于目标、约束和你愿意承担的代价。' : model === 'haiku' ? '' : '\n\n如果你愿意，我们可以选其中一个角度继续深入。'
  return `${opening}\n\n你提到“${subject}”。我的初步建议是先确定你最想得到的结果，再从一个小而明确的步骤开始。这样能更快发现哪些假设需要调整。${depth}\n\n> 游戏内 Mock AI · 模拟回复。`
}
