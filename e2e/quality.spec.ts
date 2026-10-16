import { test, expect, type Page, type BrowserContext, type APIRequestContext } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'

const STORE = 'account-weather-save-v1'
const errors = new WeakMap<BrowserContext, string[]>()
async function register(page: Page) {
  await page.goto('/')
  await page.getByLabel('称呼').fill('质量测试')
  await page.getByLabel('虚构手机号尾号').fill('4321')
  await page.getByRole('button', { name: '继续验证' }).click()
  await page.getByLabel('六位验证码').fill((await page.locator('.simulation-code strong').innerText()).trim())
  await page.getByRole('button', { name: '完成验证' }).click()
  await expect(page.locator('.welcome h1')).toBeVisible()
}
async function send(page: Page, value: string) {
  await page.locator('.composer textarea').last().fill(value)
  await page.locator('.composer .send').last().click()
}
async function state(page: Page) {
  return page.evaluate(key => {
    const store = JSON.parse(localStorage.getItem(key)!)
    return store.accounts.find((account: any) => account.id === store.currentId)
  }, STORE)
}
async function mockServer(reply: (prompt: string, res: ServerResponse) => void) {
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk.toString()
    const prompt = JSON.parse(body).messages.at(-1)?.content ?? ''
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    reply(prompt, res)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, port: (server.address() as { port: number }).port }
}
async function useOpenAI(request: APIRequestContext, port: number) {
  const response = await request.post('/api/provider', { data: { kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test', modelMap: { 'claude-sonnet-5-5': 'mock', 'claude-haiku-5-5': 'mock' }, effort: 'medium' } })
  expect(response.ok()).toBeTruthy()
}
function delta(res: ServerResponse, text: string) {
  if (!res.destroyed) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
}
function done(res: ServerResponse) {
  if (!res.destroyed) res.end('data: [DONE]\n\n')
}

test.beforeEach(async ({ request, context }) => {
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }))
  const found: string[] = []
  errors.set(context, found)
  const observe = (page: Page) => {
    page.on('pageerror', error => found.push(error.message))
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes("frame is sandboxed and the 'allow-scripts' permission is not set")) found.push(message.text()) })
  }
  context.pages().forEach(observe)
  context.on('page', observe)
  const response = await request.post('/api/provider', { data: { kind: 'offline', baseUrl: '', modelMap: {}, effort: 'medium', apiKey: '' } })
  expect(response.ok()).toBeTruthy()
})
test.afterEach(async ({ context }) => { expect(errors.get(context)).toEqual([]) })

test('sidebar, routes and empty drafts remain navigable', async ({ page }) => {
  await register(page)
  await page.getByTitle('折叠侧栏').first().click()
  await expect(page.getByTitle('展开侧栏').first()).toBeVisible()
  await page.getByTitle('展开侧栏').first().click()
  await page.locator('.new-chat').click()
  await page.locator('.new-chat').click()
  expect((await state(page)).chats).toHaveLength(0)
  for (const route of ['search', 'projects', 'artifacts', 'usage', 'billing', 'settings', 'notifications']) {
    await page.goto(`/#/${route}`)
    await expect(page.getByRole('button', { name: '返回聊天' })).toBeVisible()
    await page.getByRole('button', { name: '返回聊天' }).click()
    await expect(page.locator('.welcome h1')).toBeVisible()
  }
  await page.locator('.client-side nav button').filter({ hasText: '搜索' }).click()
  await expect(page.locator('.page-heading h1')).toHaveText('搜索对话')
  await page.goBack()
  await expect(page.locator('.welcome h1')).toBeVisible()
  await page.goForward()
  await expect(page.locator('.page-heading h1')).toHaveText('搜索对话')
})

test('unsupported simulated region has a visible path back to environment settings', async ({ page }) => {
  await register(page)
  await page.evaluate(() => { location.hash = '/devtools' })
  await page.getByRole('button', { name: '账号与环境' }).click()
  await page.getByLabel('地区').selectOption('模拟不支持地区')
  await page.getByRole('button', { name: '返回客户端' }).click()
  await expect(page.locator('.access-gate h1')).toHaveText('此地区暂不可用')
  await page.getByRole('button', { name: '打开开发者工具' }).click()
  await page.getByLabel('地区').selectOption('亚太')
  await page.getByRole('button', { name: '返回客户端' }).click()
  await expect(page.locator('.welcome h1')).toBeVisible()
})

test('unsent text and attachments stay with their own chat while late file reads are ignored', async ({ page }) => {
  await register(page)
  await send(page, '草稿会话甲')
  await expect(page.locator('.message.assistant')).toContainText('离线体验模式')
  const input = page.locator('.composer textarea').last()
  await input.fill('甲的未发送草稿')
  await page.locator('.composer input[type="file"]').setInputFiles({ name: 'first.md', mimeType: 'text/markdown', buffer: Buffer.from('甲附件') })
  await expect(page.locator('.composer .file-pill')).toContainText('first.md')
  await page.locator('.new-chat').click()
  await expect(input).toHaveValue('')
  await expect(page.locator('.composer .file-pill')).toHaveCount(0)
  await send(page, '草稿会话乙')
  await expect(page.locator('.message.assistant')).toContainText('离线体验模式')
  await input.fill('乙的未发送草稿')
  await page.locator('.recent-scroll .recent').filter({ hasText: '草稿会话甲' }).locator('button').first().click()
  await expect(input).toHaveValue('甲的未发送草稿')
  await expect(page.locator('.composer .file-pill')).toContainText('first.md')
  await page.locator('.recent-scroll .recent').filter({ hasText: '草稿会话乙' }).locator('button').first().click()
  await expect(input).toHaveValue('乙的未发送草稿')
  await expect(page.locator('.composer .file-pill')).toHaveCount(0)
  await page.evaluate(() => {
    const original = File.prototype.text
    File.prototype.text = function () {
      return new Promise<string>((resolve, reject) => setTimeout(() => original.call(this).then(resolve, reject), 600))
    }
  })
  await page.locator('.composer input[type="file"]').setInputFiles({ name: 'late.md', mimeType: 'text/markdown', buffer: Buffer.from('晚到附件') })
  await page.locator('.recent-scroll .recent').filter({ hasText: '草稿会话甲' }).locator('button').first().click()
  await page.waitForTimeout(750)
  await expect(page.locator('.composer .file-pill')).toContainText('first.md')
  await page.locator('.recent-scroll .recent').filter({ hasText: '草稿会话乙' }).locator('button').first().click()
  await expect(page.locator('.composer .file-pill')).toHaveCount(0)
})

test('concurrent streams stay with their chats and deletion cannot resurrect a chat', async ({ page, request }) => {
  const { server, port } = await mockServer((prompt, res) => {
    delta(res, `${prompt} 第一段`)
    setTimeout(() => { delta(res, `${prompt} 完成`); done(res) }, prompt.includes('删除') ? 2200 : 1300)
  })
  try {
    await useOpenAI(request, port)
    await register(page)
    await send(page, 'A 会话')
    await expect(page.locator('.message.assistant')).toContainText('A 会话 第一段')
    const chatA = (await state(page)).activeChatId
    await page.locator('.new-chat').click()
    await expect(page.locator('.message')).toHaveCount(0)
    await send(page, 'B 会话')
    await expect(page.locator('.message.assistant')).toContainText('B 会话 第一段')
    expect(await page.locator('.message.assistant').textContent()).not.toContain('A 会话')
    await expect(page.locator('.message.assistant')).toContainText('B 会话 完成')
    await page.locator('.recent-scroll .recent').filter({ hasText: 'A 会话' }).locator('button').first().click()
    await expect(page.locator('.message.assistant')).toContainText('A 会话 完成')
    expect((await state(page)).chats.find((chat: any) => chat.id === chatA).messages.at(-1).outcome).toBe('normal')
    await page.locator('.new-chat').click()
    await send(page, '删除中的回复')
    await expect(page.locator('.message.assistant')).toContainText('删除中的回复 第一段')
    const deletedId = (await state(page)).activeChatId
    page.on('dialog', dialog => dialog.accept())
    await page.locator('.recent.current .more').click()
    await page.getByRole('menuitem', { name: '删除' }).click()
    await expect(page.locator('.welcome h1')).toBeVisible()
    await page.waitForTimeout(2500)
    expect((await state(page)).chats.some((chat: any) => chat.id === deletedId)).toBe(false)
  } finally { server.close() }
})

test('long input, drop feedback, search target, code copy and sandbox Artifact', async ({ page, request }) => {
  const { server, port } = await mockServer((prompt, res) => {
    const answer = prompt.includes('artifact request')
      ? '普通代码：\n```ts\nconst testValue = 42\n```\n\n独立页面：\n```html\n<h1>沙盒预览</h1><script>parent.document.body.dataset.escaped="yes"</script>\n```'
      : `已收到 ${prompt.slice(0, 40)}`
    delta(res, answer); done(res)
  })
  try {
    await useOpenAI(request, port)
    await register(page)
    const longText = '长文本'.repeat(1200) + '\n```ts\nconst x = 1\n```'
    const input = page.locator('.composer textarea').last()
    await input.fill(longText)
    expect(await input.evaluate(el => (el as HTMLTextAreaElement).clientHeight)).toBeLessThanOrEqual(241)
    await input.press('Shift+Enter')
    expect(await input.inputValue()).toContain('const x = 1')
    await input.fill('第一条包含 独特定位词 的消息')
    await input.press('Enter')
    await expect(page.locator('.message.assistant')).toContainText('已收到')
    await send(page, 'artifact request')
    await expect(page.locator('.message.assistant').last()).toContainText('沙盒预览')
    await page.getByTitle('复制代码').first().click()
    await expect(page.getByTitle('复制代码').first()).toContainText('已复制')
    await page.locator('.client-side nav button').filter({ hasText: '搜索' }).click()
    await page.locator('.search-box input').fill('独特定位词')
    await expect(page.locator('.search-hit')).toHaveCount(3)
    await expect(page.locator('.search-hit mark').first()).toHaveText('独特定位词')
    const targetId = (await state(page)).chats[0].messages[0].id
    await page.locator('.search-hit').nth(1).click()
    await expect(page.locator(`#message-${targetId}`)).toBeInViewport()
    await page.locator('.client-side nav button').filter({ hasText: 'Artifacts' }).click()
    await expect(page.locator('.artifact-layout .items>button')).toHaveCount(1)
    await page.locator('.artifact-layout .items>button').click()
    await expect(page.frameLocator('iframe[title="Artifact 沙盒预览"]').getByText('沙盒预览')).toBeVisible()
    expect(await page.locator('body').getAttribute('data-escaped')).toBeNull()
    await page.getByLabel('Artifact 内容').fill('<h1>编辑后的内容</h1>')
    await page.getByRole('button', { name: '保存编辑' }).click()
    await page.reload()
    await page.locator('.artifact-layout .items>button').click()
    await expect(page.getByLabel('Artifact 内容')).toHaveValue('<h1>编辑后的内容</h1>')
    await page.getByRole('button', { name: '返回聊天' }).click()
    await page.locator('.composer').last().dispatchEvent('drop', { dataTransfer: await page.evaluateHandle(() => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['text'], 'bad.exe', { type: 'application/octet-stream' })); return transfer
    }) })
    await expect(page.locator('.file-error')).toContainText('仅支持常见文本文件')
    await page.locator('.composer').last().dispatchEvent('drop', { dataTransfer: await page.evaluateHandle(() => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['附件内容'], 'notes.txt', { type: 'text/plain' })); return transfer
    }) })
    await expect(page.locator('.composer .file-pill')).toContainText('notes.txt')
    await page.locator('.file-pill button[title="移除附件"]').click()
    await expect(page.locator('.composer .file-pill')).toHaveCount(0)
    await page.locator('.composer textarea').last().evaluate(element => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['粘贴附件'], 'pasted.md', { type: 'text/markdown' }))
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
    })
    await expect(page.locator('.composer .file-pill')).toContainText('pasted.md')
    await page.locator('.file-pill button[title="移除附件"]').click()
    const currentUrl = page.url()
    await page.evaluate(() => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['内容'], 'outside.txt', { type: 'text/plain' }))
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
    })
    await expect(page.locator('.toast')).toContainText('请将文件拖入聊天输入框')
    expect(page.url()).toBe(currentUrl)
  } finally { server.close() }
})

test('reload marks unfinished output and cross-tab updates are not overwritten', async ({ page, context, request }) => {
  const { server, port } = await mockServer((prompt, res) => { delta(res, `${prompt} 部分结果`); setTimeout(() => done(res), 4000) })
  try {
    await useOpenAI(request, port)
    await register(page)
    await send(page, '刷新中的请求')
    await expect(page.locator('.message.assistant')).toContainText('部分结果')
    await page.reload()
    await expect(page.locator('.message.assistant')).toContainText('流中断')
    expect((await state(page)).chats[0].messages.at(-1).outcome).toBe('stream_interrupted')
    await page.locator('.new-chat').click()
    await send(page, '第一标签页的新内容')
    await expect(page.locator('.message.assistant').last()).toContainText('部分结果')
    const second = await context.newPage()
    await second.goto('/')
    await expect(second.locator('.message.assistant').last()).toContainText('正在生成')
    await second.locator('.client-side nav button').filter({ hasText: '搜索' }).click()
    await expect(second.locator('.storage-conflict')).toBeVisible()
    await expect(page.locator('.message.assistant').last()).toContainText('已完成')
    const firstSnapshot = await page.evaluate(key => localStorage.getItem(key), STORE)
    await second.getByRole('button', { name: '读取最新存档' }).click()
    await expect(second.locator('.recent-scroll')).toContainText('第一标签页的新内容')
    expect(await second.evaluate(key => localStorage.getItem(key), STORE)).toBe(firstSnapshot)
  } finally { server.close() }
})

test('small viewport keeps composer reachable and menu supports Escape', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 740 })
  await register(page)
  const input = page.locator('.composer textarea').last()
  await expect(input).toBeInViewport()
  await send(page, '移动端对话')
  await expect(page.locator('.message.assistant')).toContainText('离线体验模式')
  await page.getByTitle('打开侧栏').click()
  await expect(page.locator('.client-side.open')).toBeVisible()
  await page.locator('.recent.current .more').click()
  await expect(page.getByRole('menuitem', { name: '重命名' })).toBeVisible()
  const bounds = await page.locator('.floating-chat-menu').boundingBox()
  expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 740).toBeTruthy()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menuitem', { name: '重命名' })).toHaveCount(0)
  await page.locator('.recent.current .more').click()
  await page.getByRole('menuitem', { name: '重命名' }).click()
  await page.getByRole('dialog', { name: '重命名对话' }).getByLabel('标题').fill('手机上的新标题')
  await page.keyboard.press('Enter')
  await expect(page.locator('.recent.current')).toContainText('手机上的新标题')
  await page.locator('.recent.current .more').click()
  await page.locator('.menu-shield').click({ position: { x: 300, y: 100 } })
  await expect(page.getByRole('menuitem', { name: '删除' })).toHaveCount(0)
})

test('Ollama NDJSON through the gateway handles success, interruption and offline service', async ({ page, request }) => {
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk.toString()
    const prompt = JSON.parse(body).messages.at(-1)?.content ?? ''
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.write(JSON.stringify({ message: { content: 'Ollama 本地片段' }, done: false }) + '\n')
    if (prompt.includes('中断')) res.end()
    else res.end(JSON.stringify({ done: true }) + '\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  try {
    const denied = await request.post('/api/provider', { data: { kind: 'ollama', baseUrl: 'http://172.20.1.8:11434', modelMap: {} } })
    expect(denied.status()).toBe(400)
    const trusted = await request.post('/api/provider', { data: { kind: 'ollama', baseUrl: 'http://172.20.1.8:11434', trustCurrentOllamaEndpoint: true, modelMap: {} } })
    expect(trusted.ok()).toBeTruthy()
    const metadata = await request.post('/api/provider', { data: { kind: 'ollama', baseUrl: 'http://169.254.169.254:11434', trustCurrentOllamaEndpoint: true, modelMap: {} } })
    expect(metadata.status()).toBe(400)
    const configured = await request.post('/api/provider', { data: { kind: 'ollama', baseUrl: `http://127.0.0.1:${port}`, modelMap: { 'claude-sonnet-5-5': 'mock-ollama' }, effort: 'medium' } })
    expect(configured.ok()).toBeTruthy()
    await register(page)
    await send(page, '本地模型正常')
    await expect(page.locator('.message.assistant').last()).toContainText('Ollama 本地片段')
    await expect(page.locator('.message.assistant').last()).toContainText('已完成')
    await send(page, '本地模型中断')
    await expect(page.locator('.message.assistant').last()).toContainText('流中断')
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await send(page, '本地模型离线')
    await expect(page.locator('.message.assistant').last()).toContainText('网络错误')
  } finally { if (server.listening) server.close() }
})

test('sandbox checkout uses a confirmation code and changes actual quota', async ({ page }) => {
  await register(page)
  const freeQuota = (await state(page)).sessionUsed
  await page.goto('/#/billing')
  await page.locator('.plan-card').filter({ hasText: 'Pro' }).getByRole('button', { name: '选择计划' }).click()
  await expect(page.locator('.checkout')).toContainText('LOCAL SANDBOX CHECKOUT')
  await expect(page.locator('input[type="password"]')).toHaveCount(0)
  await page.getByLabel('本地沙盒确认码').fill('000000')
  await page.getByRole('button', { name: '确认虚拟付款' }).click()
  await expect(page.locator('.toast')).toContainText('虚拟付款未完成')
  expect((await state(page)).plan).toBe('free')
  await page.getByLabel('本地沙盒确认码').fill('123456')
  await page.getByRole('button', { name: '确认虚拟付款' }).click()
  await expect(page.locator('.plan-card.chosen')).toContainText('Pro')
  expect((await state(page)).plan).toBe('pro')
  expect((await state(page)).sessionUsed).toBe(freeQuota)
  await page.getByRole('button', { name: '返回聊天' }).click()
  await page.locator('.model-control>button').click()
  await expect(page.locator('.model-pop button').filter({ hasText: 'Opus 5.5' })).toBeEnabled()
  await page.goto('/#/settings')
  await page.getByRole('button', { name: '打开开发者设置' }).click()
  await expect(page.locator('.dev-logo')).toBeVisible()
  await page.getByRole('button', { name: '返回客户端' }).click()
  await page.locator('.model-control>button').click()
  await page.locator('.model-pop button').filter({ hasText: 'Opus 5.5' }).click()
  await expect(page.locator('.model-control>button')).toContainText('Opus 5.5')
  await page.locator('.client-top').getByRole('button', { name: 'Pro', exact: true }).click()
  await page.getByRole('button', { name: '申请退款' }).click()
  await page.getByRole('button', { name: '确认退款' }).click()
  await expect(page.locator('.plan-card.chosen')).toContainText('Free')
  await page.getByRole('button', { name: '返回聊天' }).click()
  await expect(page.locator('.model-control>button')).toContainText('Sonnet 5.5')
})

test('clock catch-up and a streaming completion both commit without losing messages', async ({ page, request }) => {
  const { server, port } = await mockServer((prompt, res) => { delta(res, `${prompt} 第一段`); setTimeout(() => { delta(res, ' 最终段'); done(res) }, 1000) })
  try {
    await useOpenAI(request, port)
    await register(page)
    await send(page, '时钟竞态')
    await expect(page.locator('.message.assistant')).toContainText('第一段')
    await page.evaluate(() => {
      const future = Date.now() + 2 * 3_600_000
      Date.now = () => future
      window.dispatchEvent(new Event('focus'))
    })
    await expect(page.locator('.message.assistant')).toContainText('最终段')
    const saved = await state(page)
    expect(saved.now).toBeGreaterThan(saved.createdAt + 60 * 60_000)
    expect(saved.chats[0].messages.at(-1).outcome).toBe('normal')
    expect(saved.chats[0].messages.at(-1).text).toContain('最终段')
    await page.reload()
    expect((await state(page)).chats[0].messages.at(-1).text).toContain('最终段')
  } finally { server.close() }
})

test('gateway times out an upstream that never sends response headers', async ({ request }) => {
  const server = createServer(async req => { for await (const _chunk of req) { /* consume the request, intentionally never reply */ } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const port = (server.address() as { port: number }).port
    const configured = await request.post('/api/provider', { data: { kind: 'ollama', baseUrl: `http://127.0.0.1:${port}`, modelMap: { 'claude-sonnet-5-5': 'mock' } } })
    expect(configured.ok()).toBeTruthy()
    const started = Date.now()
    const reply = await request.post('/api/chat', { data: { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: '超时测试' }] }, timeout: 40_000 })
    expect(reply.ok()).toBeTruthy()
    expect(await reply.json()).toMatchObject({ outcome: 'network_error' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(29_000)
  } finally { server.closeAllConnections(); server.close() }
})

test('gateway times out an error response whose body never finishes', async ({ request }) => {
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the request */ }
    res.writeHead(503, { 'content-type': 'text/plain' })
    res.flushHeaders()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const port = (server.address() as { port: number }).port
    await useOpenAI(request, port)
    const started = Date.now()
    const reply = await request.post('/api/chat', { data: { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: '错误响应超时测试' }] }, timeout: 40_000 })
    expect(reply.ok()).toBeTruthy()
    expect(await reply.json()).toMatchObject({ outcome: 'network_error' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(29_000)
  } finally { server.closeAllConnections(); server.close() }
})

test('rapid repeated send writes one user message and corrupted archives are recoverable', async ({ page }) => {
  await register(page)
  await page.locator('.composer textarea').fill('只发送一次')
  await page.locator('.composer .send').evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click() })
  await expect(page.locator('.message.user')).toHaveCount(1)
  await expect(page.locator('.message.assistant')).toContainText('离线体验模式')
  await page.evaluate(key => localStorage.setItem(key, '{broken-json'), STORE)
  await page.reload()
  await expect(page.locator('.access-gate h1')).toHaveText('本地存档需要恢复')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载原始存档' }).click()
  expect((await download).suggestedFilename()).toBe('claude-local-recovery.json')
  expect(await page.evaluate(key => localStorage.getItem(key), STORE)).toBe('{broken-json')
})

test('a structurally damaged saved account opens recovery instead of crashing or overwriting it', async ({ page }) => {
  await register(page)
  const damaged = await page.evaluate(key => {
    const store = JSON.parse(localStorage.getItem(key)!)
    store.accounts[0].stats.exploredEvents = null
    const raw = JSON.stringify(store)
    localStorage.setItem(key, raw)
    return raw
  }, STORE)
  await page.reload()
  await expect(page.locator('.access-gate h1')).toHaveText('本地存档需要恢复')
  await expect(page.locator('.welcome')).toHaveCount(0)
  expect(await page.evaluate(key => localStorage.getItem(key), STORE)).toBe(damaged)
})

test('search opens an early message in a long conversation', async ({ page }) => {
  await register(page)
  await send(page, '创建长会话')
  await expect(page.locator('.message.assistant')).toContainText('离线体验模式')
  await page.evaluate(key => {
    const store = JSON.parse(localStorage.getItem(key)!)
    const account = store.accounts[0]
    const chat = account.chats[0]
    for (let index = 0; index < 120; index++) chat.messages.push({ id: `history-${index}`, role: 'user', text: index === 3 ? '早期唯一锚点' : `历史消息 ${index}`, at: account.now + index })
    localStorage.setItem(key, JSON.stringify(store))
  }, STORE)
  await page.reload()
  await expect(page.locator('.message')).toHaveCount(80)
  await page.locator('.client-side nav button').filter({ hasText: '搜索' }).click()
  await page.locator('.search-box input').fill('早期唯一锚点')
  await expect(page.locator('.search-hit')).toHaveCount(1)
  await page.locator('.search-hit').click()
  await expect(page.locator('#message-history-3')).toBeInViewport()
  await expect(page.locator('.older-messages')).toHaveCount(0)
})

test('provider settings show failure or durable success and remain configured after reload', async ({ page }) => {
  const { server, port } = await mockServer((_prompt,res) => { delta(res,'持久配置仍可调用'); done(res) })
  try {
    await register(page)
    await page.goto('/#/devtools')
    await page.getByRole('button', { name: 'AI 提供方' }).click()
    const form = page.locator('.provider-settings').first()
    await form.getByLabel('提供方').selectOption('openai')
    await form.getByLabel('API 基础地址').fill('http://169.254.169.254/v1')
    await form.getByLabel('API 密钥').fill('durable-browser-test-key')
    await form.getByLabel('Claude Sonnet 5.5').fill('mock')
    await form.getByRole('button', { name: '保存配置' }).click()
    await expect(page.locator('.provider-feedback.error')).toContainText('保存失败')
    const expectedRejection = errors.get(page.context())!
    expect(expectedRejection).toContain('Failed to load resource: the server responded with a status of 400 (Bad Request)')
    expectedRejection.splice(expectedRejection.indexOf('Failed to load resource: the server responded with a status of 400 (Bad Request)'),1)
    await form.getByLabel('API 基础地址').fill(`http://127.0.0.1:${port}/v1`)
    await form.getByRole('button', { name: '保存配置' }).click()
    await expect(page.locator('.provider-feedback.success')).toContainText('重启服务后会自动恢复')
    const safe = await page.request.get('/api/provider')
    const safeBody = await safe.json()
    expect(safeBody).toMatchObject({ kind: 'openai', hasKey: true, storedOnDisk: true, modelMap: { 'claude-sonnet-5-5': 'mock' } })
    expect(JSON.stringify(safeBody)).not.toContain('durable-browser-test-key')
    expect(await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage))).not.toContain('durable-browser-test-key')
    await page.getByRole('button', { name: '返回客户端' }).click()
    await send(page,'保存后立即请求')
    await expect(page.locator('.message.assistant').last()).toContainText('持久配置仍可调用')
    await page.goto('/#/devtools')
    await page.getByRole('button', { name: 'AI 提供方' }).click()
    await expect(form.getByLabel('提供方')).toHaveValue('openai')
    await expect(form.getByLabel('API 基础地址')).toHaveValue(`http://127.0.0.1:${port}/v1`)
    await expect(form.getByLabel('Claude Sonnet 5.5')).toHaveValue('mock')
    await page.reload()
    await page.getByRole('button', { name: 'AI 提供方' }).click()
    await expect(form.getByLabel('提供方')).toHaveValue('openai')
    await expect(form.getByLabel('API 基础地址')).toHaveValue(`http://127.0.0.1:${port}/v1`)
    await expect(form.getByLabel('Claude Sonnet 5.5')).toHaveValue('mock')
    await page.getByRole('button', { name: '返回客户端' }).click()
    await send(page,'重新打开后请求')
    await expect(page.locator('.message.assistant').last()).toContainText('持久配置仍可调用')
  } finally { server.close() }
})

test('a late startup read cannot erase a newly saved provider configuration', async ({ page }) => {
  const { server, port } = await mockServer((_prompt,res) => { delta(res,'延迟读取后仍然可用'); done(res) })
  let releaseInitialRead: (() => void) | undefined
  const readGate = new Promise<void>(resolve => { releaseInitialRead = resolve })
  let staleReads = 0
  let released = false
  const savedKinds: string[] = []
  try {
    await page.route('**/api/provider', async route => {
      if (route.request().method() === 'POST') savedKinds.push(String(route.request().postDataJSON()?.kind))
      if (route.request().method() === 'GET' && !released) {
        staleReads++
        await readGate
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ kind: 'offline', baseUrl: '', modelMap: {}, effort: 'medium', hasKey: false, storedOnDisk: true }) })
      } else await route.continue()
    })
    await register(page)
    await page.evaluate(() => { location.hash = '/devtools' })
    await page.getByRole('button', { name: 'AI 提供方' }).click()
    const form = page.locator('.provider-settings').first()
    await form.getByLabel('提供方').selectOption('openai')
    await form.getByLabel('API 基础地址').fill(`http://127.0.0.1:${port}/v1`)
    await form.getByLabel('API 密钥').fill('late-read-test-key')
    await form.getByLabel('Claude Sonnet 5.5').fill('mock')
    await expect(form.getByLabel('提供方')).toHaveValue('openai')
    const saveResponse = page.waitForResponse(response => response.url().endsWith('/api/provider') && response.request().method() === 'POST')
    await form.getByRole('button', { name: '保存配置' }).click()
    await expect(page.locator('.provider-feedback.success')).toBeVisible()
    expect(staleReads).toBeGreaterThan(0)
    expect(savedKinds).toEqual(['openai'])
    expect((await (await saveResponse).json()).kind).toBe('openai')
    expect((await (await page.request.get('/api/provider')).json()).kind).toBe('openai')
    const staleReadFinished = page.waitForResponse(response => response.url().endsWith('/api/provider') && response.request().method() === 'GET')
    released = true
    releaseInitialRead?.()
    await staleReadFinished
    await expect(form.getByLabel('提供方')).toHaveValue('openai')
    await expect(form.getByLabel('Claude Sonnet 5.5')).toHaveValue('mock')
    await page.getByRole('button', { name: '返回客户端' }).click()
    await expect(page.locator('.offline-label')).toHaveCount(0)
    await send(page,'检查晚到的旧配置')
    await expect(page.locator('.message.assistant')).toContainText('延迟读取后仍然可用')
  } finally { releaseInitialRead?.(); server.close() }
})

test('a late startup read cannot clear provider fields while they are being edited', async ({ page }) => {
  let releaseRead: (() => void) | undefined
  const readGate = new Promise<void>(resolve => { releaseRead = resolve })
  let heldReads = 0
  let completedReads = 0
  let released = false
  try {
    page.on('response', response => {
      if (response.url().endsWith('/api/provider') && response.request().method() === 'GET') completedReads++
    })
    await page.route('**/api/provider', async route => {
      if (route.request().method() === 'GET' && !released) {
        heldReads++
        await readGate
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ kind: 'offline', baseUrl: '', modelMap: {}, effort: 'medium', hasKey: false }) })
      } else await route.continue()
    })
    await register(page)
    await page.evaluate(() => { location.hash = '/devtools' })
    await page.getByRole('button', { name: 'AI 提供方' }).click()
    const form = page.locator('.provider-settings').first()
    await form.getByLabel('提供方').selectOption('openai')
    await form.getByLabel('API 基础地址').fill('https://example.com/v1')
    await form.getByLabel('API 密钥').fill('still-editing-key')
    await form.getByLabel('Claude Sonnet 5.5').fill('still-editing-model')
    expect(heldReads).toBeGreaterThan(0)
    released = true
    releaseRead?.()
    await expect.poll(() => completedReads).toBeGreaterThanOrEqual(heldReads)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(form.getByLabel('提供方')).toHaveValue('openai')
    await expect(form.getByLabel('API 基础地址')).toHaveValue('https://example.com/v1')
    await expect(form.getByLabel('API 密钥')).toHaveValue('still-editing-key')
    await expect(form.getByLabel('Claude Sonnet 5.5')).toHaveValue('still-editing-model')
  } finally { releaseRead?.() }
})

test('editing model settings while save is pending keeps the newer edits visible', async ({ page }) => {
  const { server, port } = await mockServer((_prompt,res) => { delta(res,'配置可用'); done(res) })
  let releaseSave: (() => void) | undefined
  let confirmSaved: (() => void) | undefined
  const saveGate = new Promise<void>(resolve => { releaseSave = resolve })
  const serverSaved = new Promise<void>(resolve => { confirmSaved = resolve })
  let firstSave = true
  try {
    await page.route('**/api/provider', async route => {
      if (route.request().method() === 'POST' && firstSave) {
        firstSave = false
        const response = await route.fetch()
        confirmSaved?.()
        await saveGate
        await route.fulfill({ response })
      } else await route.continue()
    })
    await register(page)
    await page.evaluate(() => { location.hash = '/devtools' })
    await page.getByRole('button', { name: 'AI 提供方' }).click()
    const form = page.locator('.provider-settings').first()
    await form.getByLabel('提供方').selectOption('openai')
    await form.getByLabel('API 基础地址').fill(`http://127.0.0.1:${port}/v1`)
    await form.getByLabel('API 密钥').fill('inflight-edit-test-key')
    await form.getByLabel('Claude Sonnet 5.5').fill('mock-original')
    await form.getByRole('button', { name: '保存配置' }).click()
    await serverSaved
    await form.getByLabel('Claude Sonnet 5.5').fill('mock-newer')
    releaseSave?.()
    await expect(page.locator('.provider-feedback.success')).toContainText('新增的修改尚未保存')
    await expect(form.getByLabel('Claude Sonnet 5.5')).toHaveValue('mock-newer')
    await form.getByRole('button', { name: '保存配置' }).click()
    await expect(page.locator('.provider-feedback.success')).toContainText('已永久保存')
    expect((await (await page.request.get('/api/provider')).json()).modelMap['claude-sonnet-5-5']).toBe('mock-newer')
  } finally { releaseSave?.(); server.close() }
})

test('onboarding reports a failed browser save without pretending the account was created', async ({ page }) => {
  await page.addInitScript(key => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Quota exceeded', 'QuotaExceededError')
      return original.call(this, name, value)
    }
  }, STORE)
  await page.goto('/')
  await page.getByLabel('称呼').fill('无法保存测试')
  await page.getByLabel('虚构手机号尾号').fill('4321')
  await page.getByRole('button', { name: '继续验证' }).click()
  await page.getByLabel('六位验证码').fill((await page.locator('.simulation-code strong').innerText()).trim())
  await page.getByRole('button', { name: '完成验证' }).click()
  await expect(page.locator('.onboard-error')).toContainText('未能保存到此浏览器')
  await expect(page.locator('.welcome')).toHaveCount(0)
  expect(await page.evaluate(key => localStorage.getItem(key), STORE)).toBeNull()
})

test('unavailable browser storage shows a blocking explanation instead of a blank page', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = function () { throw new DOMException('Access denied', 'SecurityError') }
  })
  await page.goto('/')
  await expect(page.locator('.access-gate h1')).toHaveText('浏览器存储不可用')
  await expect(page.locator('.onboarding')).toHaveCount(0)
})

test('a failed generation lease cannot strand a completed reply', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (name, value) {
      if (name === 'account-weather-generation-leases-v1') throw new DOMException('Quota exceeded', 'QuotaExceededError')
      return original.call(this, name, value)
    }
  })
  await register(page)
  await send(page, '租约写入失败时仍应完成')
  await expect(page.locator('.message.assistant').last()).toContainText('离线体验模式')
  await expect(page.locator('.message.assistant').last()).toContainText('已完成')
  await page.reload()
  await expect(page.locator('.message.assistant').last()).toContainText('已完成')
})

test('browser quota failure during streaming preserves the last durable reply and ends loading', async ({ page, request }) => {
  const { server, port } = await mockServer((_prompt, res) => {
    delta(res, 'FIRST_CHUNK')
    setTimeout(() => { delta(res, 'SECOND_CHUNK'); done(res) }, 300)
  })
  try {
    await useOpenAI(request, port)
    await page.addInitScript(key => {
      const original = Storage.prototype.setItem
      Storage.prototype.setItem = function (name, value) {
        if (name === key && value.includes('SECOND_CHUNK')) throw new DOMException('Quota exceeded', 'QuotaExceededError')
        return original.call(this, name, value)
      }
    }, STORE)
    await register(page)
    await send(page, '容量边界')
    await expect(page.locator('.message.assistant')).toContainText('FIRST_CHUNK')
    await expect(page.locator('.message.assistant')).toContainText('流中断')
    expect(await page.locator('.message.assistant').innerText()).not.toContain('SECOND_CHUNK')
    await page.reload()
    await expect(page.locator('.message.assistant')).toContainText('FIRST_CHUNK')
    await expect(page.locator('.message.assistant')).toContainText('流中断')
  } finally { server.close() }
})

test('a malformed imported archive is rejected without replacing the current account', async ({ page }) => {
  await register(page)
  await page.evaluate(() => { location.hash = '/devtools' })
  await page.getByRole('button', { name: '场景与时间' }).click()
  const current = await state(page)
  const invalid = { format: 'claude-local-account-v1', account: { ...current, mode: 'invalid-mode' } }
  await page.locator('.archive-settings input[type="file"]').setInputFiles({ name: 'broken-account.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) })
  await expect(page.locator('.archive-notice')).toContainText('基础资料无效')
  expect((await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORE)).accounts).toHaveLength(1)
  await page.reload()
  await expect(page.locator('.dev-logo')).toBeVisible()
})
