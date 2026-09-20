const assert = require('assert/strict')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Pool } = require('pg')

const port = Number(process.env.TEST_PORT || 3417)
const baseUrl = `http://127.0.0.1:${port}/api/v1`
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('请先设置 DATABASE_URL，再运行 npm run test:api')

const suffix = `${Date.now()}-${process.pid}`
const ownerName = `owner-${suffix}`.slice(0, 12)
const guestName = `guest-${suffix}`.slice(0, 12)
const ownerUsername = `owner_${suffix}`.replace(/[^a-z0-9_]/g, '').slice(0, 30)
const guestUsername = `guest_${suffix}`.replace(/[^a-z0-9_]/g, '').slice(0, 30)
const password = 'RainbowCats-test-2026'
let child
let ownerSpaceId
let openclawDir

async function request(path, options = {}) {
  const response = await fetch(baseUrl + path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } })
  const payload = await response.json()
  if (!response.ok || !payload.ok) {
    const error = new Error(payload.error?.message || `请求失败：${response.status}`)
    error.status = response.status
    throw error
  }
  return payload.data
}

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { if ((await request('/health')).database === 'ready') return } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('API 服务启动超时')
}

async function expectFailure(action, status) { await assert.rejects(action, error => error.status === status) }

async function cleanup() {
  const pool = new Pool({ connectionString: databaseUrl })
  try {
    if (ownerSpaceId) await pool.query('DELETE FROM spaces WHERE id=$1', [ownerSpaceId])
    await pool.query('DELETE FROM users WHERE display_name = ANY($1::varchar[])', [[ownerName, guestName]])
  } finally { await pool.end() }
}

async function main() {
  openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rainbow-openclaw-'))
  const openclawPath = path.join(openclawDir, 'openclaw')
  fs.writeFileSync(openclawPath, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ outputs: [{ text: JSON.stringify({ message: 'CLI Gateway 测试回答', action: null, payload: {} }) }] }))
`)
  fs.chmodSync(openclawPath, 0o755)
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: __dirname + '/..',
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PORT: String(port),
      PATH: `${openclawDir}${path.delimiter}${process.env.PATH || ''}`,
      OPENCLAW_CHAT_URL: '',
      OPENCLAW_GATEWAY_TOKEN: '',
      OPENCLAW_CHAT_CLI_ENABLED: 'true',
      OPENCLAW_CHAT_MODEL: 'test/mock',
      OPENCLAW_CHAT_DAILY_LIMIT: '100'
    },
    stdio: 'ignore'
  })
  try {
    await waitForServer()
    await expectFailure(() => request('/me'), 401)
    await expectFailure(() => request('/recipes/search?word=%E7%BA%A2%E7%83%A7%E8%82%89'), 401)
    await expectFailure(() => request('/auth/create-space', { method: 'POST', body: '{' }), 400)
    await expectFailure(() => request('/auth/create-space', { method: 'POST', body: JSON.stringify({ displayName: 'x'.repeat(70000) }) }), 413)
    const created = await request('/auth/create-space', { method: 'POST', body: JSON.stringify({ displayName: ownerName, username: ownerUsername, password }) })
    ownerSpaceId = created.spaceId
    const ownerHeaders = { Authorization: `Bearer ${created.token}` }
    const openclawStatus = await request('/openclaw/status', { headers: ownerHeaders })
    assert.deepEqual(openclawStatus, { configured: true, transport: 'cli-gateway', model: 'test/mock' })
    const openclawReply = await request('/openclaw/chat', { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ message: '你好' }) })
    assert.deepEqual(openclawReply, { message: 'CLI Gateway 测试回答' })
    const setupPool = new Pool({ connectionString: databaseUrl })
    try { await setupPool.query('UPDATE users SET username=NULL,password_hash=NULL,recovery_code_hash=NULL WHERE id=$1', [created.user.id]) } finally { await setupPool.end() }
    assert.equal((await request('/me', { headers: ownerHeaders })).username, null)
    const claimed = await request('/me/credentials', { method: 'PATCH', headers: ownerHeaders, body: JSON.stringify({ username: ownerUsername, password }) })
    assert.equal(claimed.username, ownerUsername)
    assert.match(claimed.recoveryCode, /^RC-[A-F0-9]{4}-[A-F0-9]{4}$/)
    await expectFailure(() => request('/me/credentials', { method: 'PATCH', headers: ownerHeaders, body: JSON.stringify({ username: `${ownerUsername}_again`, password }) }), 409)
    await expectFailure(() => request('/recipes/search?word=%E7%BA%A2%E7%83%A7%E8%82%89', { headers: ownerHeaders }), 503)
    const joined = await request('/auth/join-space', { method: 'POST', body: JSON.stringify({ displayName: guestName, username: guestUsername, password, inviteCode: created.inviteCode }) })
    const guestHeaders = { Authorization: `Bearer ${joined.token}` }

    assert.equal((await request('/space', { headers: ownerHeaders })).members.length, 2)
    await expectFailure(() => request('/auth/join-space', { method: 'POST', body: JSON.stringify({ displayName: 'third-user', inviteCode: created.inviteCode }) }), 400)

    const mission = await request('/missions', { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ title: 'smoke-mission', desc: 'transaction', credit: 25 }) })
    await request(`/missions/${mission.id}/complete`, { method: 'POST', headers: guestHeaders })
    await expectFailure(() => request(`/missions/${mission.id}/complete`, { method: 'POST', headers: guestHeaders }), 409)
    assert.equal((await request('/me', { headers: ownerHeaders })).credit, 25)
    await expectFailure(() => request('/missions', { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ title: 'bad-credit', credit: 501 }) }), 400)

    const gift = await request('/market', { method: 'POST', headers: guestHeaders, body: JSON.stringify({ title: 'smoke-gift', desc: 'purchase', credit: 20 }) })
    await request(`/market/${gift.id}/purchase`, { method: 'POST', headers: ownerHeaders })
    const purchased = (await request('/storage', { headers: ownerHeaders })).find(item => item.source_item_id === gift.id)
    assert.ok(purchased)
    await request(`/storage/${purchased.id}/use`, { method: 'POST', headers: ownerHeaders })
    await expectFailure(() => request(`/storage/${purchased.id}/use`, { method: 'POST', headers: ownerHeaders }), 404)

    const recipe = await request('/recipes', { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ title: 'smoke-recipe', ingredients: 'water', steps: 'boil' }) })
    assert.ok((await request('/recipes', { headers: guestHeaders })).some(item => item.id === recipe.id))

    const disposable = await request('/auth/create-space', { method: 'POST', body: JSON.stringify({ displayName: `delete-${suffix}`.slice(0, 12), username: `delete_${suffix}`.replace(/[^a-z0-9_]/g, '').slice(0, 30), password }) })
    const disposableHeaders = { Authorization: `Bearer ${disposable.token}` }
    await request('/me', { method: 'DELETE', headers: disposableHeaders })
    await expectFailure(() => request('/me', { headers: disposableHeaders }), 401)
    console.log('API smoke tests passed')
  } finally {
    if (child && !child.killed) child.kill()
    await cleanup()
    if (openclawDir) fs.rmSync(openclawDir, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
