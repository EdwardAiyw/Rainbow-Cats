const assert = require('assert/strict')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const databaseUrl = process.env.DATABASE_URL
const edgePath = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
if (!databaseUrl) throw new Error('Set DATABASE_URL before running npm run test:ui-two-user')
if (!fs.existsSync(edgePath)) throw new Error(`Edge executable not found: ${edgePath}`)

const sleep = delay => new Promise(resolve => setTimeout(resolve, delay))
const suffix = `${Date.now()}-${process.pid}`
const password = 'RainbowCats-two-user-2026'
const owner = {
  username: `two_owner_${suffix}`.replace(/[^a-z0-9_]/g, '').slice(0, 30),
  displayName: `Two User Owner ${String(Date.now()).slice(-5)}`
}
const guest = {
  username: `two_guest_${suffix}`.replace(/[^a-z0-9_]/g, '').slice(0, 30),
  displayName: `Two User Guest ${String(Date.now()).slice(-5)}`
}

let server
const browsers = []
const sessions = []
let baseUrl

async function freePort() {
  const listener = net.createServer()
  await new Promise((resolve, reject) => listener.listen(0, '127.0.0.1', resolve).once('error', reject))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return port
}

async function waitFor(check, message, attempts = 75) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { if (await check()) return } catch (_) {}
    await sleep(200)
  }
  throw new Error(message)
}

async function connect(debugPort) {
  let target
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
    const targets = await response.json()
    target = targets.find(item => item.type === 'page' && item.url.startsWith(baseUrl)) || targets.find(item => item.type === 'page')
    return Boolean(target)
  }, 'Edge debugging endpoint did not expose a page')

  const socket = new WebSocket(target.webSocketDebuggerUrl)
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
      const pendingCall = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) pendingCall.reject(new Error(message.error.message))
      else pendingCall.resolve(message.result)
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
  return { socket, send, evaluate, runtimeErrors }
}

async function startBrowser(debugPort, profileDir) {
  const browser = spawn(edgePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, baseUrl
  ], { stdio: 'ignore' })
  browsers.push(browser)
  const session = await connect(debugPort)
  sessions.push(session)
  await session.send('Page.enable')
  await session.send('Runtime.enable')
  await session.send('Log.enable')
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await session.send('Page.navigate', { url: baseUrl })
  await waitFor(() => session.evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('#auth-form'))`), 'Login page did not load')
  return session
}

async function createAccount(session, account) {
  await session.evaluate(`(() => {
    window.alert = () => {}
    document.querySelector('[data-auth="create"]').click()
    const values = ${JSON.stringify({ ...account, password })}
    for (const [name, value] of Object.entries(values)) document.querySelector('[name="' + name + '"]').value = value
    document.querySelector('#auth-form').requestSubmit()
  })()`)
  await waitFor(() => session.evaluate('Boolean(document.querySelector(".workspace"))'), 'Owner space creation failed')
}

async function joinAccount(session, account, inviteCode) {
  await session.evaluate(`(() => {
    window.alert = () => {}
    document.querySelector('[data-auth="join"]').click()
    const values = ${JSON.stringify({ ...account, password, inviteCode })}
    for (const [name, value] of Object.entries(values)) document.querySelector('[name="' + name + '"]').value = value
    document.querySelector('#auth-form').requestSubmit()
  })()`)
  await waitFor(() => session.evaluate('Boolean(document.querySelector(".workspace"))'), 'Guest space join failed')
}

async function waitForView(session, view) {
  await waitFor(() => session.evaluate(`document.querySelector('.sidebar [data-view="${view}"]')?.classList.contains('active')`), `${view} view did not load`)
  await waitFor(() => session.evaluate(`!document.querySelector('#app')?.hasAttribute('aria-busy')`), `${view} view remained busy`)
}

async function openView(session, view) {
  await session.evaluate(`document.querySelector('.sidebar [data-view="${view}"]').click()`)
  await waitForView(session, view)
}

async function reload(session) {
  await session.send('Page.reload', { ignoreCache: true })
  await waitFor(() => session.evaluate('document.readyState === "complete" && Boolean(document.querySelector(".workspace"))'), 'Session did not survive reload')
}

async function api(pathname, token, options = {}) {
  const response = await fetch(`${baseUrl}/api/v1${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  })
  const payload = await response.json()
  if (!response.ok || !payload.ok) throw new Error(payload.error?.message || `HTTP ${response.status}`)
  return payload.data
}

async function token(session) {
  return session.evaluate('sessionStorage.getItem("rainbowToken")')
}

async function main() {
  const [port, ownerDebugPort, guestDebugPort] = await Promise.all([freePort(), freePort(), freePort()])
  baseUrl = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PORT: String(port),
      WEB_ORIGIN: baseUrl,
      SESSION_SECRET: 'ui-two-user-session-secret',
      TIANAPI_KEY: '',
      OPENCLAW_CHAT_URL: '',
      OPENCLAW_GATEWAY_TOKEN: '',
      OPENCLAW_CHAT_CLI_ENABLED: 'false',
      OPENCLAW_RECIPE_ENABLED: 'false'
    },
    stdio: 'ignore'
  })
  await waitFor(async () => (await fetch(`${baseUrl}/api/v1/health`)).ok, 'Two-user test server did not start')

  const [ownerProfile, guestProfile] = [
    fs.mkdtempSync(path.join(os.tmpdir(), 'rainbow-cats-two-owner-')),
    fs.mkdtempSync(path.join(os.tmpdir(), 'rainbow-cats-two-guest-'))
  ]
  const [ownerSession, guestSession] = await Promise.all([
    startBrowser(ownerDebugPort, ownerProfile),
    startBrowser(guestDebugPort, guestProfile)
  ])

  try {
    await createAccount(ownerSession, owner)
    const inviteCode = await ownerSession.evaluate('document.querySelector(".invite b")?.textContent.trim()')
    assert.match(inviteCode, /^RC-/)

    await joinAccount(guestSession, guest, inviteCode)
    const [ownerToken, guestToken] = await Promise.all([token(ownerSession), token(guestSession)])
    assert.ok(ownerToken)
    assert.ok(guestToken)

    await openView(ownerSession, 'missions')
    await ownerSession.evaluate(`(() => {
      document.querySelector('[data-action="new-mission"]').click()
      document.querySelector('[name="title"]').value = 'Two-user mission'
      document.querySelector('[name="desc"]').value = 'Created in the owner browser'
      document.querySelector('[name="credit"]').value = '20'
      document.querySelector('#modal-form').requestSubmit()
    })()`)
    await waitFor(() => ownerSession.evaluate('document.body.innerText.includes("Two-user mission")'), 'Owner mission creation failed')

    await reload(guestSession)
    await openView(guestSession, 'missions')
    await waitFor(() => guestSession.evaluate('document.body.innerText.includes("Two-user mission") && Boolean(document.querySelector("[data-complete]"))'), 'Guest did not see the mission')
    await guestSession.evaluate('document.querySelector("[data-complete]").click()')
    await waitFor(() => guestSession.evaluate('document.body.innerText.includes("Two-user mission") && !document.querySelector("[data-complete]")'), 'Guest mission completion did not finish')

    await reload(ownerSession)
    assert.match(await ownerSession.evaluate('document.querySelector(".member-line small")?.textContent'), /20/)

    await openView(guestSession, 'gifts')
    await guestSession.evaluate(`(() => {
      document.querySelector('[data-action="new-gift"]').click()
      document.querySelector('[name="title"]').value = 'Two-user gift'
      document.querySelector('[name="desc"]').value = 'A shared reward'
      document.querySelector('[name="credit"]').value = '10'
      document.querySelector('#modal-form').requestSubmit()
    })()`)
    await waitFor(() => guestSession.evaluate('document.body.innerText.includes("Two-user gift")'), 'Guest gift creation failed')

    await reload(ownerSession)
    await openView(ownerSession, 'gifts')
    await waitFor(() => ownerSession.evaluate('document.body.innerText.includes("Two-user gift") && Boolean(document.querySelector("[data-purchase]"))'), 'Owner did not see the gift')
    await ownerSession.evaluate('document.querySelector("[data-purchase]").click()')
    await waitFor(() => ownerSession.evaluate('document.body.innerText.includes("Two-user gift") && Boolean(document.querySelector("[data-use]"))'), 'Gift purchase did not reach storage')
    await ownerSession.evaluate('document.querySelector("[data-use]").click()')
    await waitFor(() => ownerSession.evaluate('document.body.innerText.includes("Two-user gift") && document.body.innerText.includes("已使用")'), 'Gift use was not recorded')

    await openView(ownerSession, 'recipes')
    await ownerSession.evaluate(`(() => {
      document.querySelector('[data-action="new-recipe"]').click()
      document.querySelector('[name="title"]').value = 'Two-user recipe'
      document.querySelector('[name="desc"]').value = 'Shared recipe'
      document.querySelector('[name="ingredients"]').value = 'Water'
      document.querySelector('[name="steps"]').value = 'Boil'
      document.querySelector('#modal-form').requestSubmit()
    })()`)
    await waitFor(() => ownerSession.evaluate('document.body.innerText.includes("Two-user recipe")'), 'Owner recipe creation failed')
    await reload(guestSession)
    await openView(guestSession, 'recipes')
    await waitFor(() => guestSession.evaluate('document.body.innerText.includes("Two-user recipe")'), 'Guest did not see the recipe')

    await Promise.all([reload(ownerSession), reload(guestSession)])
    assert.equal((await api('/space', ownerToken)).members.length, 2)
    assert.equal((await api('/recipes', guestToken)).some(item => item.title === 'Two-user recipe'), true)
    assert.deepEqual(ownerSession.runtimeErrors, [])
    assert.deepEqual(guestSession.runtimeErrors, [])
    console.log(JSON.stringify({ passed: true, inviteCode, checks: ['join', 'mission-complete', 'gift-purchase-use', 'recipe-sync', 'reload'] }, null, 2))
  } finally {
    await cleanupAccounts(ownerSession, guestSession)
  }
}

async function cleanupAccounts(ownerSession, guestSession) {
  for (const session of [guestSession, ownerSession]) {
    try {
      const sessionToken = await token(session)
      if (sessionToken) await api('/me', sessionToken, { method: 'DELETE' })
    } catch (error) {
      console.error(`Two-user cleanup failed: ${error.message}`)
      process.exitCode = 1
    }
  }
}

async function cleanup() {
  for (const session of sessions) {
    if (session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(JSON.stringify({ id: Date.now() + Math.random(), method: 'Browser.close' }))
      await sleep(250)
      session.socket.close()
    }
  }
  for (const browser of browsers) if (!browser.killed) browser.kill()
  if (server && !server.killed) server.kill()
  await sleep(300)
}

main().catch(error => {
  console.error(error.stack || error)
  process.exitCode = 1
}).finally(cleanup)
