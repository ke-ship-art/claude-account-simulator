import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { connectNative } from '../../chrome-cdp/native-cdp.mjs'

const browser = await connectNative({ browserURL: 'http://127.0.0.1:9222', targetUrl: 'http://127.0.0.1:5173/', guest: false })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const evaluate = (fn, ...args) => browser.evaluate(fn, ...args)
const click = async text => {
  const r = await evaluate(t => { const el = [...document.querySelectorAll('button')].find(x => x.textContent?.includes(t)); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } }, text)
  if (!r) throw new Error(`Button not found: ${text}`)
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await wait(160)
}
const type = async text => {
  const r = await evaluate(() => { const el = document.querySelector('.appeal-card textarea'); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
  if (!r) throw new Error('Appeal form missing')
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await browser.send('Input.insertText', { text })
}
try {
  await browser.send('Page.enable')
  await browser.send('Page.bringToFront')
  await click('风控实验室')
  await evaluate(() => { const select = document.querySelector('.lab-page select'); const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(select, 'false_positive'); select.dispatchEvent(new Event('change', { bubbles: true })) })
  await evaluate(() => { const input = document.querySelector('.lab-page input[type=range]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '3'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })) })
  for (let i = 0; i < 4; i++) await click('执行事件')
  const before = await evaluate(() => document.querySelector('.risk-number')?.textContent?.trim())
  await click('通知中心')
  await type('补充材料：我在模拟时间的 10 月 13 日使用笔记本电脑，浏览器为 Chrome，网络为家庭宽带。密集请求是手动测试多个问题造成的，没有共享账号。请复核自动化证据与实际对话时间。')
  await click('补充信息')
  await click('推进 2 天查看结果')
  let result = await evaluate(() => document.querySelector('.appeal-status')?.textContent?.trim().slice(0, 90))
  if (result?.includes('未通过')) {
    await type('再次申诉：先前的调用来自我本人在同一设备、同一网络下的手动对话。请对照模拟时间线核查短时间的多个问题是否被误认为自动化；我愿意接受进一步安全验证。')
    await click('提交申诉')
    await click('推进 2 天查看结果')
    result = await evaluate(() => document.querySelector('.appeal-status')?.textContent?.trim().slice(0, 90))
  }
  const status = await evaluate(() => { const data = JSON.parse(localStorage.getItem('account-weather-save-v1')); return data.accounts.find(a => a.id === data.currentId).status })
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await wait(300)
  const mobile = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const temp = fileURLToPath(new URL('../.tmp/', import.meta.url))
  await mkdir(temp, { recursive: true })
  await writeFile(fileURLToPath(new URL('../.tmp/qa-mobile.png', import.meta.url)), Buffer.from(mobile.data, 'base64'))
  const overflow = await evaluate(() => document.documentElement.scrollWidth > innerWidth)
  await browser.send('Emulation.clearDeviceMetricsOverride')
  await browser.send('Page.reload')
  await wait(650)
  const persisted = await evaluate(() => { const data = JSON.parse(localStorage.getItem('account-weather-save-v1')); return data.accounts.find(a => a.id === data.currentId).status })
  console.log(JSON.stringify({ riskBeforeAppeal: before, appeal: result, status, persisted, mobileHorizontalOverflow: overflow }, null, 2))
} finally { await browser.disconnect() }
