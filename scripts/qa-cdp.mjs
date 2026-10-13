import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { startChrome, probeVersion } from '../../chrome-cdp/chrome-cdp.mjs'
import { connectNative } from '../../chrome-cdp/native-cdp.mjs'

const url = 'http://127.0.0.1:5173/'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const output = []
const errors = []

async function main() {
  if (!await probeVersion()) {
    await startChrome({ url, guest: false })
    for (let i = 0; i < 50 && !await probeVersion(); i++) await wait(300)
  }
  if (!await probeVersion()) throw new Error('Chrome CDP did not start')
  const browser = await connectNative({ browserURL: 'http://127.0.0.1:9222', targetUrl: url, guest: false, protocolTimeout: 15_000 })
  browser.socket.addEventListener('message', event => {
    try { const data = JSON.parse(event.data); if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.text) } catch { /* ignore */ }
  })
  try {
    await browser.send('Page.enable')
    await browser.send('Runtime.enable')
    await browser.send('Page.bringToFront')
    const evaluate = (fn, ...args) => browser.evaluate(fn, ...args)
    const rect = async (selector, text) => evaluate((s, t) => {
      const all = [...document.querySelectorAll(s)]
      const el = t ? all.find(x => x.textContent?.includes(t)) : all[0]
      if (!el) return null
      el.scrollIntoView({ block: 'center', inline: 'center' })
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: el.textContent?.slice(0, 80) }
    }, selector, text)
    const click = async (selector, text) => {
      const r = await rect(selector, text)
      if (!r) throw new Error(`Missing clickable element: ${selector} ${text ?? ''}`)
      await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
      await wait(180)
    }
    const type = async (selector, value) => {
      await click(selector)
      await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 })
      await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
      await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
      await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 })
      await browser.send('Input.insertText', { text: value }); await wait(90)
    }
    const eventually = async (fn, label) => {
      for (let i = 0; i < 30; i++) { const value = await fn(); if (value) return value; await wait(200) }
      throw new Error(`Timed out: ${label}`)
    }
    await eventually(() => evaluate(() => document.querySelector('.creator-heading h1')?.textContent), 'creator')
    output.push('registration-screen')
    await type('.form-stack input[maxlength="28"]', '浏览器测试者')
    await click('button', '开始这段账号生涯')
    await eventually(() => evaluate(() => document.querySelector('.welcome h1')?.textContent), 'welcome')
    output.push('account-created')
    await type('.composer textarea', '请解释随机种子如何让模拟结果可复现？')
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await eventually(() => evaluate(() => document.querySelectorAll('.message.assistant').length), 'mock reply')
    output.push('chat-reply')
    await click('.side-link', '用量')
    output.push(await evaluate(() => document.querySelector('.usage-number')?.textContent?.trim()))
    await click('.side-link', '订阅计划')
    await click('.plan-card', 'Pro')
    // Click the plan's button after finding the Pro card.
    const planButton = await evaluate(() => [...document.querySelectorAll('.plan-card')].find(x => x.querySelector('.plan-card-top')?.textContent?.includes('Pro'))?.querySelector('button')?.getBoundingClientRect().toJSON())
    if (!planButton) throw new Error('Pro plan action missing')
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: planButton.x + planButton.width / 2, y: planButton.y + planButton.height / 2, button: 'left', clickCount: 1 })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: planButton.x + planButton.width / 2, y: planButton.y + planButton.height / 2, button: 'left', clickCount: 1 })
    await eventually(() => evaluate(() => [...document.querySelectorAll('.plan-card')].some(x => x.querySelector('.plan-card-top')?.textContent?.includes('Pro') && x.textContent?.includes('当前计划'))), 'Pro upgrade')
    output.push('plan-upgrade')
    await click('.side-link', '风控实验室')
    await eventually(() => evaluate(() => document.querySelector('.risk-number')?.textContent), 'lab')
    for (let i = 0; i < 5; i++) await click('button', '执行事件')
    const status = await evaluate(() => document.querySelector('.lab-status .pill')?.textContent?.trim())
    output.push(`risk-status:${status}`)
    await click('.side-link', '通知中心')
    const appealVisible = await evaluate(() => !!document.querySelector('.appeal-card'))
    output.push(`appeal-visible:${appealVisible}`)
    if (appealVisible) {
      await type('.appeal-card textarea', '我在模拟时间的今天密集使用了账号，可能被系统当成异常调用。请结合我的设备、地区和具体聊天记录重新复核。')
      await click('button', '提交申诉')
      await eventually(() => evaluate(() => document.querySelector('.appeal-status')?.textContent?.includes('正在审核')), 'appeal pending')
      await click('button', '推进 2 天查看结果')
      await wait(300)
      output.push(`appeal-result:${await evaluate(() => document.querySelector('.appeal-status')?.textContent?.trim().slice(0, 70))}`)
    }
    const localSave = await evaluate(() => !!localStorage.getItem('account-weather-save-v1'))
    output.push(`saved:${localSave}`)
    const shot = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(fileURLToPath(new URL('../qa-screen.png', import.meta.url)), Buffer.from(shot.data, 'base64'))
    console.log(JSON.stringify({ steps: output, consoleErrors: errors }, null, 2))
  } finally { await browser.disconnect() }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1 })
