const assert = require('node:assert/strict')
const { test } = require('node:test')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')

function client() {
  const element = { innerHTML: '', dataset: {}, classList: { add() {}, remove() {} }, setAttribute() {}, removeAttribute() {} }
  const memory = new Map()
  const storage = { getItem: key => memory.get(key) || '', setItem: (key, value) => memory.set(key, String(value)), removeItem: key => memory.delete(key) }
  const context = vm.createContext({
    document: { querySelector: selector => ['#app', '#toast'].includes(selector) ? element : null, querySelectorAll: () => [], addEventListener() {} },
    sessionStorage: storage,
    localStorage: storage,
    AbortController,
    FormData: class { constructor(form) { this.form = form } entries() { return Object.entries(this.form.values || {}) } },
    setTimeout: () => 1, clearTimeout() {},
    fetch: async () => { throw new Error('Unexpected network request') }
  })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../web/app.js'), 'utf8'), context)
  return { run: code => vm.runInContext(code, context), context, element }
}

test('completed and own missions cannot be completed from the UI', () => {
  const { run } = client()
  run("state.me = { id: 'me' }")
  assert.match(run("itemRow({ id: 'm', creator_id: 'other', available: true }, 'mission')"), /data-complete/)
  assert.doesNotMatch(run("itemRow({ id: 'm', creator_id: 'other', available: false }, 'mission')"), /data-complete/)
  assert.doesNotMatch(run("itemRow({ id: 'm', creator_id: 'me', available: true }, 'mission')"), /data-complete/)
})

test('dashboard and ledger preserve recipe search and unrelated cached data', async () => {
  const { run } = client()
  run("state.data = { recipeSearch: ['saved'], bindings: ['binding'] }; api = async path => path.startsWith('/budget') ? { spent: 1 } : []")
  await run('loadToday()')
  await run('loadLedger()')
  assert.equal(run('state.data.recipeSearch[0]'), 'saved')
  assert.equal(run('state.data.bindings[0]'), 'binding')
  assert.equal(run('state.data.budget.spent'), 1)
})

test('gift requests start together and commit only when both succeed', async () => {
  const { run, context } = client()
  const calls = []
  let resolveMarket
  context.fetch = url => {
    calls.push(url)
    if (url.endsWith('/market')) return new Promise(resolve => { resolveMarket = resolve })
    return Promise.resolve({ ok: false, status: 503, json: async () => ({ error: { message: 'offline' } }) })
  }
  run("state.data.gifts = ['existing']")
  const loading = run('loadGifts()')
  assert.deepEqual(calls, ['/api/v1/market', '/api/v1/storage'])
  resolveMarket({ ok: true, json: async () => ({ ok: true, data: ['new'] }) })
  await assert.rejects(loading, /offline/)
  assert.equal(run('state.data.gifts[0]'), 'existing')
})

test('failed navigation stays on the previous page and permits retry', async () => {
  const { run, element } = client()
  run("loadView = async () => { throw new Error('offline') }")
  await run("navigate('gifts')")
  assert.equal(run('state.view'), 'today')
  assert.equal(element.textContent, 'offline')
  run('loadView = async () => {}')
  await run("navigate('recipes')")
  assert.equal(run('state.view'), 'recipes')
})

test('overlapping navigation does not start competing page loads', async () => {
  const { run, context } = client()
  let finish
  context.waitForLoad = () => new Promise(resolve => { finish = resolve })
  run('loadView = waitForLoad')
  const first = run("navigate('gifts')")
  await run("navigate('recipes')")
  assert.equal(run('state.view'), 'gifts')
  finish()
  await first
  assert.equal(run('navigationPending'), false)
})

test('budget month uses the local calendar, not UTC', () => {
  const { run } = client()
  assert.equal(run('localMonth({ getFullYear: () => 2026, getMonth: () => 8 })'), '2026-09')
  assert.equal(run('localMonth({ getFullYear: () => 2027, getMonth: () => 0 })'), '2027-01')
})

test('recipe links reject executable URLs before DOM insertion', () => {
  const { run } = client()
  assert.doesNotMatch(run("recipesView({ recipeSearch: [{ title: 'x', url: 'javascript:alert(1)' }] })"), /href=/)
  assert.match(run("recipesView({ recipeSearch: [{ title: 'x', url: 'https://example.com/recipe' }] })"), /href="https:\/\/example.com\/recipe"/)
})

test('legacy accounts are prompted to create durable login credentials', () => {
  const { run } = client()
  run("state.me = { id: 'legacy', displayName: '旧用户', username: null }; state.data.bindings = []")
  assert.match(run('settingsView()'), /id="credentials-form"/)
  run("state.me.username = 'saved_user'")
  assert.doesNotMatch(run('settingsView()'), /id="credentials-form"/)
})

test('generated recipes remain visibly labelled and show their method', () => {
  const { run } = client()
  const html = run("recipesView({ recipes: [], recipeSearch: [{ title: '测试菜', isGenerated: true, ingredients: '水', steps: '煮开' }] })")
  assert.match(html, /AI 生成参考/)
  assert.match(html, /查看做法/)
})

test('AI view exposes the CLI Gateway connection and conversation', () => {
  const { run } = client()
  const html = run("aiView({ openclawStatus: { configured: true, transport: 'cli-gateway', model: 'test/model' }, proposals: [{ id: 'p1', action: 'create_event', status: 'pending', created_at: '2026-09-20T12:00:00Z' }], aiMessages: [{ role: 'user', message: '<测试>' }, { role: 'assistant', message: '已收到' }] })")
  assert.match(html, /OpenClaw 已连接/)
  assert.match(html, /本机安全通道/)
  assert.match(html, /新增日程/)
  assert.match(html, /&lt;测试&gt;/)
  assert.doesNotMatch(html, /type="submit" disabled/)
})

test('AI view disables chat when OpenClaw is not enabled', () => {
  const { run } = client()
  const html = run("aiView({ openclawStatus: { configured: false, transport: 'disabled' }, proposals: [], aiMessages: [] })")
  assert.match(html, /OpenClaw 尚未启用/)
  assert.match(html, /id="ai-chat-form"/)
  assert.match(html, /type="submit" disabled/)
})

test('AI loader preserves the local conversation while refreshing status', async () => {
  const { run } = client()
  run("state.data = { aiMessages: [{ role: 'user', message: '保留我' }] }; api = async path => path === '/ai/proposals' ? [{ id: 'p1' }] : { configured: true, transport: 'cli-gateway' }")
  await run('loadAI()')
  assert.equal(run('state.data.aiMessages[0].message'), '保留我')
  assert.equal(run('state.data.proposals[0].id'), 'p1')
  assert.equal(run('state.data.openclawStatus.transport'), 'cli-gateway')
})

test('AI chat keeps the reply and turns write requests into proposals', async () => {
  const { run } = client()
  run("state.data = { openclawStatus: { configured: true }, proposals: [], aiMessages: [] }; calls = []; api = async (path, options) => { calls.push({ path, timeout: options.timeout }); return path === '/openclaw/chat' ? { message: '已整理', action: 'create_event', payload: { title: '看电影' } } : { id: 'p1', action: 'create_event', status: 'pending' } }; render = () => {}")
  await run("handleAiSubmit({ preventDefault() {}, target: { values: { message: '安排看电影' } } })")
  assert.equal(run('calls[0].path'), '/openclaw/chat')
  assert.equal(run('calls[0].timeout'), 65000)
  assert.equal(run('calls[1].path'), '/ai/proposals')
  assert.equal(run('state.data.aiMessages[1].message'), '已整理')
  assert.equal(run('state.data.proposals[0].id'), 'p1')
  assert.equal(run('state.data.aiPending'), false)
})
