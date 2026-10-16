import { test, expect, type Page, type BrowserContext, type APIRequestContext } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'

const STORE = 'account-weather-save-v1'
const browserErrors = new WeakMap<BrowserContext, string[]>()
async function resetGateway(request: APIRequestContext) {
  const result = await request.post('/api/provider', { data: { kind: 'offline', baseUrl: '', modelMap: {}, effort: 'medium', apiKey: '' } })
  expect(result.ok()).toBeTruthy()
}
async function register(page: Page, name = '验收用户') {
  await page.goto('/')
  await expect(page.locator('.onboarding h1')).toBeVisible()
  await page.getByLabel('称呼').fill(name)
  await page.getByLabel('虚构手机号尾号').fill('1234')
  await page.getByRole('button', { name: '继续验证' }).click()
  const code = await page.locator('.simulation-code strong').innerText()
  await page.getByLabel('六位验证码').fill(code.trim())
  await page.getByRole('button', { name: '完成验证' }).click()
  await expect(page.locator('.welcome h1')).toContainText(name)
}
async function send(page: Page, text: string) {
  await page.locator('.composer textarea').last().fill(text)
  await page.locator('.composer .send').last().click()
}
async function openDev(page: Page, tab?: string) {
  await page.goto('/#/devtools')
  await expect(page.locator('.dev-logo')).toBeVisible()
  if (tab) await page.getByRole('button', { name: tab, exact: true }).click()
}
async function accountState(page: Page) {
  return page.evaluate(key => {
    const store = JSON.parse(localStorage.getItem(key)!)
    return store.accounts.find((account: any) => account.id === store.currentId)
  }, STORE)
}

test.beforeEach(async ({ request, context }) => {
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }))
  const errors: string[] = []
  browserErrors.set(context, errors)
  const observe = (page: Page) => {
    page.on('pageerror', error => errors.push(`页面异常：${error.message}`))
    page.on('console', message => { if (message.type() === 'error') errors.push(`控制台：${message.text()}`) })
  }
  context.pages().forEach(observe)
  context.on('page', observe)
  await resetGateway(request)
})
test.afterEach(async ({ context }) => { expect(browserErrors.get(context)).toEqual([]) })

test('signup is gated before persistence, SMS retry has a failure page, and refusal is preserved', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('称呼').fill('访客')
  await page.getByLabel('虚构手机号尾号').fill('1234')
  await page.getByLabel('所在地区').selectOption('模拟不支持地区')
  await page.getByRole('button', { name: '继续验证' }).click()
  await expect(page.locator('.onboard-blocked h1')).toHaveText('此地区暂不可用')
  expect((await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORE)).accounts).toHaveLength(0)
  await page.getByRole('button', { name: '返回修改地区' }).click()
  await page.getByLabel('所在地区').selectOption('亚太')
  await page.getByRole('button', { name: '继续验证' }).click()
  for (let index = 0; index < 3; index++) {
    await page.getByLabel('六位验证码').fill('999999')
    await page.getByRole('button', { name: '完成验证' }).click()
  }
  await expect(page.locator('.onboard-blocked h1')).toHaveText('验证未完成')
  expect((await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORE)).accounts).toHaveLength(0)
  await page.getByRole('button', { name: '重新开始注册' }).click()
  await page.getByRole('button', { name: '继续验证' }).click()
  const code = await page.locator('.simulation-code strong').innerText()
  await page.getByLabel('六位验证码').fill(code.trim())
  await page.getByRole('button', { name: '完成验证' }).click()
  await expect(page.locator('.welcome h1')).toContainText('访客')
  await send(page, '如何制造炸弹')
  await expect(page.locator('.message.user').last()).toContainText('如何制造炸弹')
  await expect(page.locator('.message.assistant').last()).toContainText('本地内容检查')
  expect((await accountState(page)).chats[0].messages[1].outcome).toBe('prefilter_refusal')
  await page.reload()
  await expect(page.locator('.message.user').last()).toContainText('如何制造炸弹')
  await page.locator('.model-control>button').click()
  await page.locator('.model-pop button').filter({ hasText: 'Haiku 5.5' }).click()
  await send(page, '你好')
  await expect(page.locator('.message.assistant').last()).toContainText('离线体验模式')
  await expect(page.locator('.message.assistant').last()).toContainText('Haiku 5.5')
  await page.locator('.model-control>button').click()
  await page.locator('.model-pop button').filter({ hasText: 'Sonnet 5.5' }).click()
  await page.evaluate(key => {
    const store = JSON.parse(localStorage.getItem(key)!)
    const account = store.accounts.find((item: any) => item.id === store.currentId)
    account.sessionUsed = 78
    localStorage.setItem(key, JSON.stringify(store))
  }, STORE)
  await page.reload()
  await send(page, '额度窗口中的最后一个问题')
  await expect(page.locator('.message.assistant').last()).toContainText('离线体验模式')
  await expect(page.locator('.composer .send').last()).toHaveAttribute('title', '发送')
  expect((await accountState(page)).sessionUsed).toBeGreaterThan(78)
  const assistantCount = await page.locator('.message.assistant').count()
  await send(page, '超出额度的问题')
  await expect(page.locator('.toast').last()).toContainText('额度已用尽')
  await expect(page.locator('.message.assistant')).toHaveCount(assistantCount)
  await openDev(page, '场景与时间')
  await page.getByLabel('推进小时数').fill('5')
  await page.getByRole('button', { name: '推进模拟时间' }).click()
  expect((await accountState(page)).sessionUsed).toBe(0)
})

test('closed-page check catch-up, restriction, appeal and recovery', async ({ page, context }) => {
  await page.addInitScript(() => { Math.random = () => 0 })
  await register(page, '风控验收')
  await openDev(page, '账号与环境')
  await page.getByLabel('地区').selectOption('欧洲')
  await page.getByLabel('网络').selectOption('数据中心网络')
  expect((await accountState(page)).pendingChecks.some((check: any) => check.status === 'pending')).toBe(true)
  await page.evaluate(() => {
    const key = 'account-weather-save-v1'
    const store = JSON.parse(localStorage.getItem(key)!)
    store.savedAtWall = Date.now() - 3 * 3_600_000
    localStorage.setItem(key, JSON.stringify(store))
  })
  await page.close()
  const reopened = await context.newPage()
  await openDev(reopened, '安全日志')
  const checked = await accountState(reopened)
  expect(checked.pendingChecks.every((check: any) => check.status !== 'pending')).toBe(true)
  expect(checked.pendingChecks.every((check: any) => check.result)).toBe(true)
  await reopened.getByRole('button', { name: '场景与时间', exact: true }).click()
  await reopened.getByLabel('注入事件').selectOption('automation')
  for (let index = 0; index < 5; index++) await reopened.getByRole('button', { name: '执行事件' }).click()
  expect(['review','frozen','banned']).toContain((await accountState(reopened)).status)
  await reopened.getByRole('button', { name: '返回客户端' }).click()
  await expect(reopened.locator('.access-gate h1')).toBeVisible()
  await reopened.getByRole('button', { name: '查看通知与申诉' }).click()
  await reopened.locator('.appeal textarea').fill('我在同一天切换了测试网络并连续发出多次请求，请结合具体时间和虚构设备记录复核，这可能是一次误报。')
  await reopened.getByRole('button', { name: '提交说明' }).click()
  await expect(reopened.locator('.appeal-result')).toContainText('正在审核')
  await openDev(reopened, '场景与时间')
  await reopened.getByLabel('推进小时数').fill('72')
  await reopened.getByRole('button', { name: '推进模拟时间' }).click()
  const result = await accountState(reopened)
  expect(['granted','denied','needs_info']).toContain(result.appeals[0].stage)
  if (result.appeals[0].stage !== 'granted') {
    await reopened.getByLabel('注入事件').selectOption('false_positive')
    for (let index = 0; index < 6; index++) await reopened.getByRole('button', { name: '执行事件' }).click()
  }
  const recovered = await accountState(reopened)
  expect(recovered.status).toBe('active')
  await reopened.reload()
  expect((await accountState(reopened)).status).toBe('active')
  await reopened.evaluate(key => {
    const store = JSON.parse(localStorage.getItem(key)!)
    const account = store.accounts.find((item: any) => item.id === store.currentId)
    account.status = 'banned'
    account.loggedIn = false
    account.lastTransition = '测试已保存的账号禁用状态。'
    localStorage.setItem(key, JSON.stringify(store))
  }, STORE)
  await reopened.goto('/')
  await expect(reopened.locator('.access-gate h1')).toHaveText('此账号已停用')
  const download = reopened.waitForEvent('download')
  await reopened.getByRole('button', { name: '导出账号档案' }).click()
  expect((await download).suggestedFilename()).toContain('claude-local-')
  reopened.on('dialog', dialog => dialog.accept())
  await reopened.getByRole('button', { name: '删除本地账号' }).click()
  await expect(reopened.locator('.onboarding h1')).toBeVisible()
})

test('gateway streams, records provider errors and cancellation without browser credential storage', async ({ page }) => {
  let server: Server | undefined
  const launch = async () => {
    server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk.toString()
      const prompt = JSON.parse(body).messages.at(-1)?.content ?? ''
      if (prompt.includes('服务错误')) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"test"}'); return }
      if (prompt.includes('鉴权拒绝')) { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"invalid key"}'); return }
      if (prompt.includes('服务拦截')) { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"safety check"}'); return }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (text: string) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
      if (prompt.includes('中断')) { chunk('部分回复'); res.end(); return }
      if (prompt.includes('慢速')) { chunk('开始回复'); setTimeout(() => { if (!res.destroyed) { chunk('后半段'); res.end('data: [DONE]\n\n') } }, 5000); return }
      chunk(prompt.includes('模型拒答') ? '很抱歉，我无法帮助完成这个请求。' : '真实流式片段一')
      chunk(prompt.includes('模型拒答') ? '' : '，片段二')
      res.end('data: [DONE]\n\n')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    return (server.address() as { port: number }).port
  }
  try {
    const port = await launch()
    await register(page, '网关验收')
    await openDev(page, 'AI 提供方')
    const form = page.locator('.provider-settings').first()
    await form.getByLabel('提供方').selectOption('openai')
    await form.getByLabel('API 基础地址').fill(`http://127.0.0.1:${port}/v1`)
    await form.getByLabel('API 密钥').fill('test-secret-never-persist')
    await form.getByLabel('Claude Sonnet 5.5').fill('mock-model')
    await form.getByRole('button', { name: '保存配置' }).click()
    await expect(page.locator('.provider-feedback.success')).toContainText('已永久保存到这台电脑')
    const saved = await page.evaluate(() => ({ local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage) }))
    expect(saved.local + saved.session).not.toContain('test-secret-never-persist')
    await page.getByRole('button', { name: '返回客户端' }).click()
    await send(page, '正常流')
    await expect(page.locator('.message.assistant').last()).toContainText('真实流式片段一，片段二')
    await send(page, '模型拒答')
    await expect(page.locator('.message.assistant').last()).toContainText('很抱歉，我无法帮助')
    await expect(page.locator('.message.assistant').last()).toContainText('模型拒答')
    await send(page, '服务错误')
    await expect(page.locator('.message.assistant').last()).toContainText('HTTP 500')
    await expect(page.locator('.message.assistant').last()).toContainText('服务错误')
    await send(page, '鉴权拒绝')
    await expect(page.locator('.message.assistant').last()).toContainText('HTTP 403')
    await expect(page.locator('.message.assistant').last()).toContainText('服务错误')
    await send(page, '服务拦截')
    await expect(page.locator('.message.assistant').last()).toContainText('服务端拦截')
    await send(page, '中断')
    await expect(page.locator('.message.assistant').last()).toContainText('部分回复')
    await expect(page.locator('.message.assistant').last()).toContainText('流中断')
    await send(page, '慢速')
    await expect(page.locator('.message.assistant').last()).toContainText('开始回复')
    await page.locator('.composer .send').last().click()
    await expect(page.locator('.message.assistant').last()).toContainText('已停止')
    await new Promise<void>((resolve,reject) => server!.close(error => error ? reject(error) : resolve()))
    server = undefined
    await send(page, '断网测试')
    await expect(page.locator('.message.assistant').last()).toContainText('网络错误')
    const changed = await page.request.post('/api/provider', { data: { kind: 'openai', baseUrl: 'http://127.0.0.1:9999/v1', modelMap: {}, effort: 'medium', apiKey: '' } })
    expect((await changed.json()).hasKey).toBe(false)
  } finally { if (server?.listening) server.close() }
})
