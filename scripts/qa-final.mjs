import { connectNative } from '../../chrome-cdp/native-cdp.mjs'

const browser = await connectNative({ browserURL: 'http://127.0.0.1:9222', targetUrl: 'http://127.0.0.1:5173/', guest: false })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const read = (fn, ...args) => browser.evaluate(fn, ...args)
async function click(selector, text) {
  const rect = await read((s, t) => { const e = [...document.querySelectorAll(s)].find(x => !t || x.textContent?.includes(t)); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] }, selector, text)
  if (!rect) throw new Error(`${selector} ${text ?? ''} not found`)
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect[0], y: rect[1], button: 'left', clickCount: 1 })
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect[0], y: rect[1], button: 'left', clickCount: 1 })
  await wait(120)
}
try {
  await browser.send('Page.enable')
  await browser.send('Page.bringToFront')
  await browser.send('Page.reload')
  await wait(650)
  await click('.side-link', '订阅计划')
  await click('button', '取消订阅')
  const canceled = await read(() => document.querySelector('.billing-cycle')?.textContent?.includes('已安排取消订阅'))
  await click('.new-chat')
  await click('.chat-pin')
  const pinned = await read(() => { const data = JSON.parse(localStorage.getItem('account-weather-save-v1')); const a = data.accounts.find(x => x.id === data.currentId); return a.chats.find(c => c.id === a.activeChatId)?.pinned })
  await click('.profile-row')
  const previousRegion = await read(() => { const data = JSON.parse(localStorage.getItem('account-weather-save-v1')); return data.accounts.find(a => a.id === data.currentId).environment.region })
  await read(() => { const field = [...document.querySelectorAll('label')].find(x => x.textContent?.startsWith('地区')); const select = field.querySelector('select'); const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(select, '欧洲'); select.dispatchEvent(new Event('change', { bubbles: true })) })
  await wait(200)
  const region = await read(() => { const data = JSON.parse(localStorage.getItem('account-weather-save-v1')); const a = data.accounts.find(x => x.id === data.currentId); return { value: a.environment.region, events: a.riskEvents.filter(e => e.code === 'region_jump').length } })
  console.log(JSON.stringify({ canceled, pinned, previousRegion, region }, null, 2))
} finally { await browser.disconnect() }
