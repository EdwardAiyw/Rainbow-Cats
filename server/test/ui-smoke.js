const assert = require('assert/strict')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const databaseUrl = process.env.DATABASE_URL
const edgePath = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
if (!databaseUrl) throw new Error('请先设置 DATABASE_URL，再运行 npm run test:ui')
if (!fs.existsSync(edgePath)) throw new Error(`找不到 Edge：${edgePath}`)

const sleep = delay => new Promise(resolve => setTimeout(resolve, delay))
const suffix = `${Date.now()}-${process.pid}`
const username = `ui_${suffix}`.replace(/[^a-z0-9_]/g, '').slice(0, 30)
const password = 'RainbowCats-ui-2026'
const displayName = `UI测试-${String(Date.now()).slice(-5)}`
const screenshots = {
  desktop: path.join(os.tmpdir(), 'rainbow-cats-ui-desktop.png'),
  mobile: path.join(os.tmpdir(), 'rainbow-cats-ui-mobile.png')
}

let server
let browser
let socket
let profileDir
let createdAccount = false
let createdToken = ''
let testBaseUrl = ''

async function freePort() {
  const listener = net.createServer()
  await new Promise((resolve, reject) => listener.listen(0, '127.0.0.1', resolve).once('error', reject))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return port
}

async function waitFor(check, message, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { if (await check()) return } catch (_) {}
    await sleep(200)
  }
  throw new Error(message)
}

async function connect(debugPort, baseUrl) {
  let target
  await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
    target = targets.find(item => item.type === 'page' && item.url.startsWith(baseUrl)) || targets.find(item => item.type === 'page')
    return Boolean(target)
  }, 'Edge 调试端口启动超时')

  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })

  let nextId = 0
  const pending = new Map()
  const runtimeErrors = []
  socket.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
      return
    }
    if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error' && message.params.entry.source === 'javascript') runtimeErrors.push(message.params.entry.text)
  }

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }
  return { send, evaluate, runtimeErrors }
}

async function main() {
  const [port, debugPort] = await Promise.all([freePort(), freePort()])
  const baseUrl = `http://127.0.0.1:${port}`
  testBaseUrl = baseUrl
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rainbow-cats-ui-'))

  server = spawn(process.execPath, ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PORT: String(port),
      WEB_ORIGIN: baseUrl,
      SESSION_SECRET: 'ui-smoke-session-secret',
      TIANAPI_KEY: '',
      OPENCLAW_CHAT_URL: '',
      OPENCLAW_GATEWAY_TOKEN: '',
      OPENCLAW_CHAT_CLI_ENABLED: 'false',
      OPENCLAW_RECIPE_ENABLED: 'false'
    },
    stdio: 'ignore'
  })
  await waitFor(async () => (await fetch(`${baseUrl}/api/v1/health`)).ok, 'UI 测试服务启动超时')

  browser = spawn(edgePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    baseUrl
  ], { stdio: 'ignore' })

  const { send, evaluate, runtimeErrors } = await connect(debugPort, baseUrl)
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: baseUrl })
  await waitFor(() => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('#auth-form'))`), '登录页加载失败')

  const desktopAuth = await evaluate(`(() => {
    const panel = document.querySelector('.auth-panel').getBoundingClientRect()
    return {
      overflow: document.documentElement.scrollWidth > innerWidth,
      panelInside: panel.left >= 0 && panel.right <= innerWidth,
      tabs: document.querySelectorAll('[data-auth]').length
    }
  })()`)
  assert.deepEqual(desktopAuth, { overflow: false, panelInside: true, tabs: 4 })

  await evaluate(`(() => {
    window.alert = () => {}
    document.querySelector('[data-auth="create"]').click()
    const values = ${JSON.stringify({ username, password, displayName })}
    for (const [name, value] of Object.entries(values)) document.querySelector('[name="' + name + '"]').value = value
    document.querySelector('#auth-form').requestSubmit()
  })()`)
  await waitFor(() => evaluate(`Boolean(document.querySelector('.workspace'))`), '通过页面创建空间失败')
  createdAccount = true
  createdToken = await evaluate(`sessionStorage.getItem('rainbowToken')`)

  const shell = await evaluate(`({
    token: Boolean(sessionStorage.getItem('rainbowToken')),
    navCount: document.querySelectorAll('.sidebar [data-view]').length,
    inviteVisible: Boolean(document.querySelector('.invite b')?.textContent.trim()),
    overflow: document.documentElement.scrollWidth > innerWidth
  })`)
  assert.deepEqual(shell, { token: true, navCount: 9, inviteVisible: true, overflow: false })

  const views = [
    ['today', '今天'], ['missions', '心愿与任务'], ['gifts', '礼物与收藏'], ['recipes', '菜谱'],
    ['calendar', '日程'], ['ledger', '账本'], ['album', '相册'], ['ai', 'AI 助手'], ['settings', '设置']
  ]
  for (const [view, title] of views) {
    await evaluate(`document.querySelector('.sidebar [data-view="${view}"]').click()`)
    await waitFor(() => evaluate(`document.querySelector('.sidebar [data-view="${view}"]')?.classList.contains('active')`), `${title} 页面加载失败`)
    const layout = await evaluate(`({
      title: document.querySelector('.topbar h1')?.textContent,
      overflow: document.documentElement.scrollWidth > innerWidth,
      content: Boolean(document.querySelector('.content'))
    })`)
    assert.deepEqual(layout, { title, overflow: false, content: true })
  }

  await evaluate(`document.querySelector('.sidebar [data-view="missions"]').click()`)
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-action="new-mission"]'))`), '任务页操作按钮缺失')
  await evaluate(`(() => {
    document.querySelector('[data-action="new-mission"]').click()
    document.querySelector('[name="title"]').value = 'UI smoke mission'
    document.querySelector('[name="desc"]').value = 'browser flow'
    document.querySelector('[name="credit"]').value = '20'
    document.querySelector('#modal-form').requestSubmit()
  })()`)
  await waitFor(() => evaluate(`document.body.innerText.includes('UI smoke mission')`), '通过页面新增任务失败')

  await evaluate(`document.querySelector('.sidebar [data-view="recipes"]').click()`)
  await waitFor(() => evaluate(`Boolean(document.querySelector('#recipe-search-form'))`), '菜谱页加载失败')
  await evaluate(`(() => {
    document.querySelector('#recipe-search-form [name="word"]').value = '红烧肉'
    document.querySelector('#recipe-search-form').requestSubmit()
  })()`)
  await waitFor(() => evaluate(`document.querySelector('#toast')?.textContent.includes('TIANAPI_KEY')`), 'TianAPI 未配置提示缺失')

  await evaluate(`document.querySelector('.sidebar [data-view="ai"]').click()`)
  await waitFor(() => evaluate(`Boolean(document.querySelector('#ai-chat-form'))`), 'AI 页面加载失败')
  const aiOffline = await evaluate(`({
    status: document.querySelector('.ai-status')?.textContent.includes('OpenClaw 尚未启用'),
    offlineClass: document.querySelector('.ai-status')?.classList.contains('is-offline'),
    submitDisabled: document.querySelector('#ai-chat-form [type="submit"]')?.disabled
  })`)
  assert.deepEqual(aiOffline, { status: true, offlineClass: true, submitDisabled: true })

  const desktopCapture = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(screenshots.desktop, Buffer.from(desktopCapture.data, 'base64'))

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await evaluate(`document.querySelector('.mobile-nav [data-view="today"]').click()`)
  await waitFor(() => evaluate(`document.querySelector('.mobile-nav [data-view="today"]')?.classList.contains('active')`), '移动端首页加载失败')
  const mobile = await evaluate(`(() => {
    const bottomNav = document.querySelector('.mobile-nav')
    const rect = bottomNav.getBoundingClientRect()
    const toast = document.querySelector('#toast')
    const toastRect = toast.getBoundingClientRect()
    return {
      overflow: document.documentElement.scrollWidth > innerWidth,
      sidebarNavHidden: getComputedStyle(document.querySelector('.sidebar nav')).display === 'none',
      bottomNavVisible: getComputedStyle(bottomNav).display === 'flex',
      bottomNavScrollable: bottomNav.scrollWidth > bottomNav.clientWidth,
      bottomNavInside: rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      toastAvoidsNav: !toast.classList.contains('show') || toastRect.bottom <= rect.top,
      navCount: bottomNav.querySelectorAll('[data-view]').length
    }
  })()`)
  assert.deepEqual(mobile, { overflow: false, sidebarNavHidden: true, bottomNavVisible: true, bottomNavScrollable: true, bottomNavInside: true, toastAvoidsNav: true, navCount: 9 })

  await evaluate(`document.querySelector('[data-action="new-expense"]').click()`)
  const modal = await evaluate(`(() => {
    const element = document.querySelector('.modal')
    const rect = element.getBoundingClientRect()
    return {
      inside: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
      scrollable: ['auto', 'scroll'].includes(getComputedStyle(element).overflowY),
      submitVisible: Boolean(element.querySelector('[type="submit"]'))
    }
  })()`)
  assert.deepEqual(modal, { inside: true, scrollable: true, submitVisible: true })
  await evaluate(`document.querySelector('[data-action="close-modal"]').click()`)

  const mobileCapture = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(screenshots.mobile, Buffer.from(mobileCapture.data, 'base64'))
  assert.deepEqual(runtimeErrors, [])
  await removeTestAccount()

  console.log(JSON.stringify({ passed: true, views: views.length, desktopAuth, mobile, modal, screenshots }, null, 2))
}

async function removeTestAccount() {
  if (!createdAccount || !createdToken || !testBaseUrl) return
  const response = await fetch(`${testBaseUrl}/api/v1/me`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${createdToken}` }
  })
  if (!response.ok && response.status !== 401) throw new Error(`UI 测试账号清理失败：HTTP ${response.status}`)
  createdAccount = false
}

async function cleanup() {
  try { await removeTestAccount() } catch (error) { console.error(error.stack || error); process.exitCode = 1 }
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ id: Date.now() + 1, method: 'Browser.close' }))
    await sleep(500)
    socket.close()
  }
  if (browser && !browser.killed) browser.kill()
  if (server && !server.killed) server.kill()
  await sleep(300)
  if (profileDir) {
    try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch (_) {}
  }
}

main().catch(error => {
  console.error(error.stack || error)
  process.exitCode = 1
}).finally(cleanup)
