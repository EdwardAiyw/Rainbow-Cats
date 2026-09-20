const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { URL } = require('url')
const { Pool } = require('pg')
const https = require('https')
const { createDAVClient } = require('tsdav')

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const PORT = Number(process.env.PORT || 3000)
const ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:3000'
const SESSION_DAYS = 30
const WEB_ROOT = path.resolve(__dirname, '../../web')
const SESSION_SECRET = process.env.SESSION_SECRET || 'development-only-change-me'
const OPENCLAW_CHAT_URL = process.env.OPENCLAW_CHAT_URL || ''
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || ''
const OPENCLAW_INTERNAL_TOKEN = process.env.OPENCLAW_INTERNAL_TOKEN || ''
const OPENCLAW_IDENTITY_SECRET = process.env.OPENCLAW_IDENTITY_SECRET || SESSION_SECRET
const TIANAPI_KEY = process.env.TIANAPI_KEY || ''
const TIANAPI_DAILY_LIMIT = Math.max(1, Number(process.env.TIANAPI_DAILY_LIMIT || 95))

const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const token = () => crypto.randomBytes(32).toString('hex')
const clean = (value, max) => String(value ?? '').trim().slice(0, max)
const fail = (message, code = 'BAD_REQUEST') => ({ ok: false, data: null, error: { message, code } })
const ok = data => ({ ok: true, data, error: null })
const query = (text, values = [], client = pool) => client.query(text, values)

function send(res, status, payload, extra = {}) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', ...extra }
  res.writeHead(status, headers)
  res.end(JSON.stringify(payload))
}
async function body(req) { let raw = ''; for await (const chunk of req) raw += chunk; if (!raw) return {}; try { return JSON.parse(raw) } catch (_) { throw Object.assign(new Error('请求格式错误'), { status: 400, code: 'INVALID_JSON' }) } }
function cookies(req) { return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(pair => pair.length === 2)) }
function setSessionCookie(res, value) { res.setHeader('Set-Cookie', `rainbow_session=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`) }
function clearSessionCookie(res) { res.setHeader('Set-Cookie', 'rainbow_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0') }
function passwordHash(password) { const salt = crypto.randomBytes(16).toString('hex'); const derived = crypto.scryptSync(password, salt, 64).toString('hex'); return `scrypt$${salt}$${derived}` }
function passwordMatches(password, stored) { const [, salt, expected] = String(stored || '').split('$'); if (!salt || !expected) return false; const actual = crypto.scryptSync(password, salt, 64).toString('hex'); return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected)) }
function hashMatches(value, expected) { const actual = Buffer.from(hash(value)); const target = Buffer.from(String(expected || '')); return actual.length === target.length && crypto.timingSafeEqual(actual, target) }
function encryptSecret(value) { const key = crypto.createHash('sha256').update(SESSION_SECRET).digest(); const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]); return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}` }
function decryptSecret(value) { const [ivText, tagText, dataText] = String(value || '').split('.'); const key = crypto.createHash('sha256').update(SESSION_SECRET).digest(); const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64')); decipher.setAuthTag(Buffer.from(tagText, 'base64')); return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64')), decipher.final()]).toString('utf8') }
function recoveryCode() { return `RC-${crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 4)}-${crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 4)}` }
function inviteCode() { return `RC-${crypto.randomBytes(3).toString('hex').toUpperCase()}` }
function confirmationCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0') }
function identityHash(channel, agentAccountId, requesterSenderId) {
  return crypto.createHmac('sha256', OPENCLAW_IDENTITY_SECRET).update([channel, agentAccountId, requesterSenderId].join('\0')).digest('hex')
}
function isLoopback(req) {
  const address = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '')
  return address === '127.0.0.1' || address === '::1' || address === '::'
}
function internalAuthorized(req) {
  if (!OPENCLAW_INTERNAL_TOKEN || !isLoopback(req)) return false
  const supplied = String(req.headers['x-openclaw-internal-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  return supplied.length > 0 && hashMatches(supplied, hash(OPENCLAW_INTERNAL_TOKEN))
}
async function createSession(userId, res) { const value = token(); await query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+$3::interval)', [userId, hash(value), `${SESSION_DAYS} days`]); setSessionCookie(res, value); return value }
async function auth(req) {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const supplied = bearer || cookies(req).rainbow_session
  if (!supplied) throw Object.assign(new Error('请先登录'), { status: 401, code: 'UNAUTHORIZED' })
  const result = await query('SELECT u.*, sm.space_id, sm.credit FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN space_members sm ON sm.user_id=u.id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()', [hash(supplied)])
  if (!result.rows.length) throw Object.assign(new Error('登录已失效，请重新登录'), { status: 401, code: 'SESSION_EXPIRED' })
  return result.rows[0]
}
async function withAudit(user, action, entityType, entityId, metadata = {}) { await query('INSERT INTO audit_logs(space_id,user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)', [user.space_id || null, user.id, action, entityType || null, entityId || null, metadata]) }
async function getSpace(user) { const result = await query('SELECT s.id,s.invite_code,s.currency,s.created_at, json_agg(json_build_object(\'id\',u.id,\'displayName\',sm.display_name,\'credit\',sm.credit) ORDER BY sm.created_at) AS members FROM spaces s JOIN space_members sm ON sm.space_id=s.id JOIN users u ON u.id=sm.user_id WHERE s.id=$1 GROUP BY s.id', [user.space_id]); return result.rows[0] || null }

async function applyProposal(client, user, proposal) {
  const payload = proposal.payload || {}
  const action = proposal.action
  if (action === 'create_mission') {
    const title = clean(payload.title, 120); const credit = Number(payload.credit)
    if (!title || !Number.isFinite(credit) || credit < 1 || credit > 500) throw Object.assign(new Error('任务提案参数不合法'), { status: 400 })
    const result = await client.query('INSERT INTO missions(space_id,creator_id,title,description,credit) VALUES($1,$2,$3,$4,$5) RETURNING *', [user.space_id, user.id, title, clean(payload.desc || payload.description, 1000), credit])
    return result.rows[0]
  }
  if (action === 'create_market_item') {
    const title = clean(payload.title, 120); const credit = Number(payload.credit)
    if (!title || !Number.isFinite(credit) || credit < 1 || credit > 500) throw Object.assign(new Error('礼物提案参数不合法'), { status: 400 })
    const result = await client.query('INSERT INTO market_items(space_id,creator_id,title,description,credit) VALUES($1,$2,$3,$4,$5) RETURNING *', [user.space_id, user.id, title, clean(payload.desc || payload.description, 1000), credit])
    return result.rows[0]
  }
  if (action === 'create_expense') {
    const amount = Number(payload.amount); const category = clean(payload.category, 50)
    if (!Number.isFinite(amount) || amount <= 0 || !category) throw Object.assign(new Error('支出提案参数不合法'), { status: 400 })
    const result = await client.query('INSERT INTO expenses(space_id,created_by,amount,category,note,spent_on) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [user.space_id, user.id, amount, category, clean(payload.note, 300), payload.spentOn || new Date().toISOString().slice(0, 10)])
    return result.rows[0]
  }
  if (action === 'create_event') {
    const title = clean(payload.title, 200); const start = new Date(payload.startsAt); const end = new Date(payload.endsAt || payload.startsAt)
    if (!title || Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || end < start) throw Object.assign(new Error('日程提案参数不合法'), { status: 400 })
    const result = await client.query('INSERT INTO calendar_events(space_id,title,notes,starts_at,ends_at,all_day,source,updated_by) VALUES($1,$2,$3,$4,$5,$6,\'local\',$7) RETURNING *', [user.space_id, title, clean(payload.notes, 2000), start, end, Boolean(payload.allDay), user.id])
    return result.rows[0]
  }
  if (action === 'complete_mission') {
    const found = await client.query('SELECT * FROM missions WHERE id=$1 AND space_id=$2 FOR UPDATE', [payload.missionId, user.space_id])
    if (!found.rows.length) throw Object.assign(new Error('任务不存在'), { status: 404 }); const item = found.rows[0]
    if (!item.available) throw Object.assign(new Error('任务已经完成'), { status: 409 }); if (item.creator_id === user.id) throw Object.assign(new Error('不能完成自己发布的任务'), { status: 400 })
    await client.query('UPDATE missions SET available=false,completed_by=$1,completed_at=now() WHERE id=$2', [user.id, item.id]); await client.query('UPDATE space_members SET credit=LEAST(500,credit+$1) WHERE user_id=$2', [item.credit, item.creator_id]); return { id: item.id }
  }
  if (action === 'purchase_market_item') {
    const found = await client.query('SELECT * FROM market_items WHERE id=$1 AND space_id=$2 FOR UPDATE', [payload.marketItemId, user.space_id])
    if (!found.rows.length) throw Object.assign(new Error('礼物不存在'), { status: 404 }); const item = found.rows[0]
    const member = await client.query('SELECT credit FROM space_members WHERE space_id=$1 AND user_id=$2 FOR UPDATE', [user.space_id, user.id])
    if (!item.available) throw Object.assign(new Error('礼物已被兑换'), { status: 409 }); if (item.creator_id === user.id) throw Object.assign(new Error('不能兑换自己发布的礼物'), { status: 400 }); if (Number(member.rows[0]?.credit || 0) < item.credit) throw Object.assign(new Error('积分不足'), { status: 400 })
    await client.query('UPDATE market_items SET available=false,purchased_by=$1,purchased_at=now() WHERE id=$2', [user.id, item.id]); await client.query('UPDATE space_members SET credit=credit-$1 WHERE user_id=$2 AND space_id=$3', [item.credit, user.id, user.space_id]); const stored = await client.query('INSERT INTO storage_items(space_id,owner_id,source_item_id,title,description,credit) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [user.space_id, user.id, item.id, item.title, item.description, item.credit]); return stored.rows[0]
  }
  throw Object.assign(new Error('这个 AI 动作不允许由网页确认'), { status: 400 })
}

async function authCreate(req, res) {
  const input = await body(req); const name = clean(input.displayName || input.username, 40); const username = clean(input.username, 40).toLowerCase(); const password = clean(input.password, 200)
  if (!name) return send(res, 400, fail('请输入昵称'))
  if (!/^[a-z0-9_]{3,40}$/.test(username) || password.length < 8) return send(res, 400, fail('账号需为 3-40 位字母、数字或下划线，密码至少 8 位'))
  const recovery = recoveryCode(); const client = await pool.connect()
  try { await client.query('BEGIN'); const u = await client.query('INSERT INTO users(username,password_hash,recovery_code_hash,display_name) VALUES($1,$2,$3,$4) RETURNING id,display_name,username', [username || null, username ? passwordHash(password) : null, hash(recovery), name]); const s = await client.query('INSERT INTO spaces(invite_code,owner_user_id) VALUES($1,$2) RETURNING id,invite_code', [inviteCode(), u.rows[0].id]); await client.query('INSERT INTO space_members(space_id,user_id,display_name) VALUES($1,$2,$3)', [s.rows[0].id, u.rows[0].id, name]); await client.query('INSERT INTO albums(space_id) VALUES($1)', [s.rows[0].id]); await client.query('COMMIT'); const session = await createSession(u.rows[0].id, res); return send(res, 201, ok({ token: session, spaceId: s.rows[0].id, inviteCode: s.rows[0].invite_code, user: u.rows[0], recoveryCode: username ? recovery : undefined })) } catch (error) { await client.query('ROLLBACK'); if (error.code === '23505') return send(res, 409, fail('账号已存在', 'USERNAME_TAKEN')); throw error } finally { client.release() }
}
async function authJoin(req, res) {
  const input = await body(req); const name = clean(input.displayName || input.username, 40); const invite = clean(input.inviteCode, 12).toUpperCase(); const username = clean(input.username, 40).toLowerCase(); const password = clean(input.password, 200)
  if (!name || !invite) return send(res, 400, fail('请输入昵称和邀请码'))
  if (!/^[a-z0-9_]{3,40}$/.test(username) || password.length < 8) return send(res, 400, fail('账号需为 3-40 位字母、数字或下划线，密码至少 8 位'))
  const recovery = username ? recoveryCode() : null; const client = await pool.connect(); try { await client.query('BEGIN'); const space = await client.query('SELECT * FROM spaces WHERE invite_code=$1 FOR UPDATE', [invite]); if (!space.rows.length) throw Object.assign(new Error('邀请码无效'), { status: 400 }); const count = await client.query('SELECT count(*)::int AS count FROM space_members WHERE space_id=$1', [space.rows[0].id]); if (count.rows[0].count >= 2) throw Object.assign(new Error('这个双人空间已满'), { status: 400 }); const u = await client.query('INSERT INTO users(username,password_hash,recovery_code_hash,display_name) VALUES($1,$2,$3,$4) RETURNING id,display_name,username', [username || null, username ? passwordHash(password) : null, recovery ? hash(recovery) : null, name]); await client.query('INSERT INTO space_members(space_id,user_id,display_name) VALUES($1,$2,$3)', [space.rows[0].id, u.rows[0].id, name]); await client.query('COMMIT'); const session = await createSession(u.rows[0].id, res); return send(res, 201, ok({ token: session, spaceId: space.rows[0].id, user: u.rows[0], recoveryCode: recovery || undefined })) } catch (error) { await client.query('ROLLBACK'); if (error.status) return send(res, error.status, fail(error.message)); throw error } finally { client.release() }
}
async function authLogin(req, res) { const input = await body(req); const username = clean(input.username, 40).toLowerCase(); const password = clean(input.password, 200); const result = await query('SELECT id FROM users WHERE username=$1', [username]); if (!result.rows.length) return send(res, 401, fail('账号或密码错误', 'INVALID_CREDENTIALS')); const user = await query('SELECT * FROM users WHERE id=$1', [result.rows[0].id]); if (!passwordMatches(password, user.rows[0].password_hash)) return send(res, 401, fail('账号或密码错误', 'INVALID_CREDENTIALS')); const session = await createSession(user.rows[0].id, res); return send(res, 200, ok({ token: session, user: { id: user.rows[0].id, username: user.rows[0].username, displayName: user.rows[0].display_name } })) }
async function authRecover(req, res) { const input = await body(req); const username = clean(input.username, 40).toLowerCase(); const code = clean(input.recoveryCode, 30).toUpperCase(); const password = clean(input.newPassword, 200); if (password.length < 8) return send(res, 400, fail('新密码至少 8 位')); const result = await query('SELECT * FROM users WHERE username=$1', [username]); if (!result.rows.length || !hashMatches(code, result.rows[0].recovery_code_hash)) return send(res, 401, fail('恢复码无效', 'INVALID_RECOVERY_CODE')); await query('UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2', [passwordHash(password), result.rows[0].id]); await query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [result.rows[0].id]); return send(res, 200, ok(null)) }
async function channelBindingToken(req, res, user) {
  const raw = confirmationCode();
  await query('UPDATE identity_link_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [user.id])
  const result = await query('INSERT INTO identity_link_tokens(user_id,space_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval \'10 minutes\') RETURNING id,expires_at', [user.id, user.space_id, hash(raw)])
  await withAudit(user, 'channel.link_token.create', 'identity_link_token', result.rows[0].id)
  return send(res, 201, ok({ id: result.rows[0].id, code: raw, expiresAt: result.rows[0].expires_at }))
}
async function listChannelBindings(res, user) {
  const result = await query('SELECT id,channel,agent_account_id AS "agentAccountId",created_at AS "createdAt",last_seen_at AS "lastSeenAt" FROM channel_identities WHERE user_id=$1 AND space_id=$2 ORDER BY created_at DESC', [user.id, user.space_id])
  return send(res, 200, ok(result.rows))
}
async function deleteChannelBinding(res, user, id) {
  const result = await query('DELETE FROM channel_identities WHERE id=$1 AND user_id=$2 AND space_id=$3 RETURNING id', [id, user.id, user.space_id])
  if (!result.rows.length) return send(res, 404, fail('绑定不存在', 'NOT_FOUND'))
  await withAudit(user, 'channel.unbind', 'channel_identity', result.rows[0].id)
  return send(res, 200, ok({ id: result.rows[0].id }))
}
async function trustedIdentity(input) {
  const channel = clean(input.channel, 40); const agentAccountId = clean(input.agentAccountId, 160); const requesterSenderId = clean(input.requesterSenderId, 300)
  if (!channel || !agentAccountId || !requesterSenderId) throw Object.assign(new Error('缺少可信渠道身份'), { status: 400, code: 'IDENTITY_REQUIRED' })
  const senderKeyHash = identityHash(channel, agentAccountId, requesterSenderId)
  const result = await query('SELECT ci.*, u.display_name, u.username, sm.credit FROM channel_identities ci JOIN users u ON u.id=ci.user_id JOIN space_members sm ON sm.space_id=ci.space_id AND sm.user_id=ci.user_id WHERE ci.channel=$1 AND ci.agent_account_id=$2 AND ci.sender_key_hash=$3', [channel, agentAccountId, senderKeyHash])
  if (!result.rows.length) throw Object.assign(new Error('该微信身份尚未绑定，请先在网页生成绑定码'), { status: 403, code: 'IDENTITY_NOT_BOUND' })
  await query('UPDATE channel_identities SET last_seen_at=now() WHERE id=$1', [result.rows[0].id])
  return { ...result.rows[0], channel, agentAccountId, senderKeyHash }
}
async function handleOpenClawInternal(req, res, pathname) {
  if (!internalAuthorized(req)) return send(res, 403, fail('仅允许本机 OpenClaw 调用', 'FORBIDDEN'))
  if (req.method !== 'POST') return send(res, 405, fail('仅支持 POST', 'METHOD_NOT_ALLOWED'))
  const input = await body(req)
  if (pathname === '/api/internal/openclaw/link') {
    const channel = clean(input.channel, 40); const agentAccountId = clean(input.agentAccountId, 160); const requesterSenderId = clean(input.requesterSenderId, 300); const code = clean(input.code, 20)
    if (!channel || !agentAccountId || !requesterSenderId || !/^\d{6}$/.test(code)) return send(res, 400, fail('渠道、发送者和 6 位绑定码不能为空'))
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const tokenRow = await client.query('SELECT * FROM identity_link_tokens WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() AND attempts<5 FOR UPDATE', [hash(code)])
      if (!tokenRow.rows.length) { await client.query('ROLLBACK'); return send(res, 400, fail('绑定码无效、已过期或已使用', 'INVALID_LINK_CODE')) }
      const row = tokenRow.rows[0]; const senderKeyHash = identityHash(channel, agentAccountId, requesterSenderId)
      const existing = await client.query('SELECT id,user_id FROM channel_identities WHERE channel=$1 AND agent_account_id=$2 AND sender_key_hash=$3', [channel, agentAccountId, senderKeyHash])
      if (existing.rows.length && existing.rows[0].user_id !== row.user_id) { await client.query('ROLLBACK'); return send(res, 409, fail('该微信身份已绑定其他账号', 'IDENTITY_ALREADY_BOUND')) }
      let identityId = existing.rows[0]?.id
      if (!existing.rows.length) { const identity = await client.query('INSERT INTO channel_identities(channel,agent_account_id,sender_key_hash,user_id,space_id) VALUES($1,$2,$3,$4,$5) RETURNING id', [channel, agentAccountId, senderKeyHash, row.user_id, row.space_id]); identityId = identity.rows[0].id }
      await client.query('UPDATE identity_link_tokens SET used_at=now() WHERE id=$1', [row.id]); await client.query('COMMIT')
      await withAudit({ id: row.user_id, space_id: row.space_id }, 'channel.bind', 'channel_identity', identityId, { channel, agentAccountId })
      return send(res, 200, ok({ bound: true, userId: row.user_id, spaceId: row.space_id }))
    } catch (error) { await client.query('ROLLBACK'); if (error.code === '23505') return send(res, 409, fail('该微信身份已绑定', 'IDENTITY_ALREADY_BOUND')); throw error } finally { client.release() }
  }
  if (pathname === '/api/internal/openclaw/context') {
    const identity = await trustedIdentity(input)
    return send(res, 200, ok({ user: { id: identity.user_id, username: identity.username, displayName: identity.display_name, credit: identity.credit }, spaceId: identity.space_id, channel: identity.channel, agentAccountId: identity.agentAccountId }))
  }
  if (pathname === '/api/internal/openclaw/proposals') {
    const identity = await trustedIdentity(input); const action = clean(input.action, 80); const allowed = ['create_mission', 'create_market_item', 'create_expense', 'create_event', 'complete_mission', 'purchase_market_item']
    if (!allowed.includes(action)) return send(res, 400, fail('这个 AI 动作不允许由微信助手发起'))
    const code = confirmationCode(); const result = await query('INSERT INTO ai_action_proposals(space_id,created_by,action,payload,source_channel,source_agent_account_id,source_sender_key_hash,confirmation_code_hash,confirmation_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval \'10 minutes\') RETURNING id,action,payload,status,created_at,confirmation_expires_at', [identity.space_id, identity.user_id, action, input.payload || {}, identity.channel, identity.agentAccountId, identity.senderKeyHash, hash(code)])
    await withAudit({ ...identity, space_id: identity.space_id, id: identity.user_id }, 'ai.proposal.create', 'ai_action_proposal', result.rows[0].id, { source: identity.channel })
    return send(res, 201, ok({ ...result.rows[0], confirmationCode: code }))
  }
  if (pathname === '/api/internal/openclaw/confirm') {
    const identity = await trustedIdentity(input); const proposalId = clean(input.proposalId, 80); const code = clean(input.confirmationCode, 20)
    if (!proposalId || !/^\d{6}$/.test(code)) return send(res, 400, fail('提案 ID 和 6 位确认码不能为空'))
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const found = await client.query('SELECT * FROM ai_action_proposals WHERE id=$1 AND space_id=$2 AND created_by=$3 AND status=\'pending\' FOR UPDATE', [proposalId, identity.space_id, identity.user_id])
      if (!found.rows.length) { await client.query('ROLLBACK'); return send(res, 404, fail('提案不存在或已处理', 'PROPOSAL_NOT_FOUND')) }
      const proposal = found.rows[0]
      if (proposal.source_channel !== identity.channel || proposal.source_agent_account_id !== identity.agentAccountId || proposal.source_sender_key_hash !== identity.senderKeyHash) { await client.query('ROLLBACK'); return send(res, 403, fail('该提案不属于当前微信身份', 'PROPOSAL_IDENTITY_MISMATCH')) }
      if (proposal.confirmation_expires_at <= new Date()) { await client.query('ROLLBACK'); return send(res, 400, fail('确认码已过期', 'CONFIRMATION_EXPIRED')) }
      if (!hashMatches(code, proposal.confirmation_code_hash)) { await client.query('UPDATE ai_action_proposals SET confirmation_attempts=confirmation_attempts+1 WHERE id=$1', [proposal.id]); await client.query('COMMIT'); return send(res, 400, fail('确认码错误', 'INVALID_CONFIRMATION_CODE')) }
      const user = await query('SELECT u.*, sm.space_id, sm.credit FROM users u JOIN space_members sm ON sm.user_id=u.id WHERE u.id=$1 AND sm.space_id=$2', [identity.user_id, identity.space_id]); const result = await applyProposal(client, user.rows[0], proposal)
      const updated = await client.query('UPDATE ai_action_proposals SET status=\'confirmed\',result=$1,confirmed_at=now(),executed_at=now(),confirmed_by_user_id=$2 WHERE id=$3 RETURNING id,status,result,confirmed_at', [result || {}, identity.user_id, proposal.id]); await client.query('COMMIT'); await withAudit(user.rows[0], 'ai.proposal.confirm', 'ai_action_proposal', proposal.id, { source: identity.channel }); return send(res, 200, ok(updated.rows[0]))
    } catch (error) { await client.query('ROLLBACK'); if (error.status) return send(res, error.status, fail(error.message)); throw error } finally { client.release() }
  }
  return send(res, 404, fail('内部接口不存在', 'NOT_FOUND'))
}
function upstreamGet(hostname, requestPath) { return new Promise((resolve, reject) => { const request = https.request({ hostname, path: requestPath, method: 'GET', timeout: 8000 }, response => { let raw = ''; response.setEncoding('utf8'); response.on('data', chunk => { raw += chunk }); response.on('end', () => { try { resolve(JSON.parse(raw)) } catch (_) { reject(new Error('上游服务返回格式错误')) } }) }); request.on('timeout', () => request.destroy(new Error('上游服务超时'))); request.on('error', reject); request.end() }) }

async function route(req, res, pathname, method, search) {
  if (pathname.startsWith('/api/internal/openclaw/')) return handleOpenClawInternal(req, res, pathname)
  if (!pathname.startsWith('/api/')) { const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\//, ''); const file = path.resolve(WEB_ROOT, requested); const relative = path.relative(WEB_ROOT, file); if (relative.startsWith('..') || path.isAbsolute(relative)) return send(res, 400, fail('非法路径')); try { const content = await fs.promises.readFile(file); const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }; res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }); return res.end(content) } catch (_) { return send(res, 404, fail('页面不存在', 'NOT_FOUND')) } }
  if (pathname === '/api/v1/health') return send(res, 200, ok({ service: 'rainbow-cats', database: process.env.DATABASE_URL ? 'configured' : 'missing' }))
  if (pathname === '/api/v1/auth/create-space' && method === 'POST') return authCreate(req, res)
  if (pathname === '/api/v1/auth/join-space' && method === 'POST') return authJoin(req, res)
  if (pathname === '/api/v1/auth/login' && method === 'POST') return authLogin(req, res)
  if (pathname === '/api/v1/auth/recover' && method === 'POST') return authRecover(req, res)
  const user = await auth(req)
  if (pathname === '/api/v1/auth/logout' && method === 'POST') { await query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [user.id]); clearSessionCookie(res); return send(res, 200, ok(null)) }
  if (pathname === '/api/v1/channel-bindings/tokens' && method === 'POST') return channelBindingToken(req, res, user)
  if (pathname === '/api/v1/channel-bindings' && method === 'GET') return listChannelBindings(res, user)
  const bindingDelete = pathname.match(/^\/api\/v1\/channel-bindings\/([^/]+)$/); if (bindingDelete && method === 'DELETE') return deleteChannelBinding(res, user, bindingDelete[1])
  if (pathname === '/api/v1/me' && method === 'GET') return send(res, 200, ok({ id: user.id, username: user.username, displayName: user.display_name, credit: user.credit || 0 }))
  if (pathname === '/api/v1/space' && method === 'GET') return send(res, 200, ok(await getSpace(user)))
  if (pathname === '/api/v1/openclaw/chat' && method === 'POST') { if (!OPENCLAW_CHAT_URL || !OPENCLAW_GATEWAY_TOKEN) return send(res, 503, fail('尚未配置 OpenClaw 网关', 'SERVICE_NOT_CONFIGURED')); const input = await body(req); const message = clean(input.message, 2000); if (!message) return send(res, 400, fail('请输入消息')); let upstream; try { upstream = await fetch(OPENCLAW_CHAT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENCLAW_GATEWAY_TOKEN}` }, body: JSON.stringify({ userId: user.id, spaceId: user.space_id, message }) }) } catch (_) { return send(res, 502, fail('OpenClaw 网关暂时不可用', 'OPENCLAW_GATEWAY_ERROR')) } const payload = await upstream.json().catch(() => ({})); if (!upstream.ok) return send(res, 502, fail(payload.error?.message || 'OpenClaw 请求失败', 'OPENCLAW_GATEWAY_ERROR')); return send(res, 200, ok(payload.data || payload)) }
  if (pathname === '/api/v1/me/display-name' && method === 'PATCH') { const input = await body(req); const name = clean(input.displayName, 40); if (!name) return send(res, 400, fail('昵称不能为空')); await query('UPDATE users SET display_name=$1,updated_at=now() WHERE id=$2', [name, user.id]); await query('UPDATE space_members SET display_name=$1 WHERE user_id=$2', [name, user.id]); await withAudit(user, 'profile.rename', 'user', user.id); return send(res, 200, ok({ displayName: name })) }
  if (pathname === '/api/v1/me' && method === 'DELETE') {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const memberships = await client.query('SELECT space_id FROM space_members WHERE user_id=$1', [user.id])
      for (const membership of memberships.rows) {
        const space = await client.query('SELECT owner_user_id FROM spaces WHERE id=$1 FOR UPDATE', [membership.space_id])
        if (!space.rows.length) continue
        if (space.rows[0].owner_user_id === user.id) {
          const replacement = await client.query('SELECT user_id FROM space_members WHERE space_id=$1 AND user_id<>$2 ORDER BY created_at LIMIT 1', [membership.space_id, user.id])
          if (replacement.rows.length) await client.query('UPDATE spaces SET owner_user_id=$1 WHERE id=$2', [replacement.rows[0].user_id, membership.space_id])
          else await client.query('DELETE FROM spaces WHERE id=$1', [membership.space_id])
        }
      }
      await client.query('DELETE FROM users WHERE id=$1', [user.id])
      await client.query('COMMIT')
      clearSessionCookie(res); return send(res, 200, ok(null))
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  const listMap = { missions: 'missions', market: 'market_items' }
  for (const [resource, table] of Object.entries(listMap)) if (pathname === `/api/v1/${resource}` && method === 'GET') { const result = await query(`SELECT *, description AS desc FROM ${table} WHERE space_id=$1 ORDER BY created_at DESC LIMIT 100`, [user.space_id]); return send(res, 200, ok(result.rows)) }
  if (pathname === '/api/v1/storage' && method === 'GET') { const result = await query('SELECT *, description AS desc FROM storage_items WHERE space_id=$1 AND owner_id=$2 ORDER BY created_at DESC', [user.space_id, user.id]); return send(res, 200, ok(result.rows)) }
  if (pathname === '/api/v1/recipes' && method === 'GET') { const result = await query('SELECT * FROM recipes WHERE space_id=$1 ORDER BY created_at DESC', [user.space_id]); return send(res, 200, ok(result.rows)) }
  if (pathname === '/api/v1/recipes/search' && method === 'GET') {
    if (!TIANAPI_KEY) return send(res, 503, fail('服务端尚未配置 TIANAPI_KEY', 'SERVICE_NOT_CONFIGURED'))
    const usage = await query('INSERT INTO api_usage(service,usage_date,count) VALUES($1,current_date,1) ON CONFLICT(service,usage_date) DO UPDATE SET count=api_usage.count+1,updated_at=now() WHERE api_usage.count < $2 RETURNING count', ['tianapi', TIANAPI_DAILY_LIMIT])
    if (!usage.rows.length) return send(res, 429, fail('今日官方菜谱查询次数已用完', 'DAILY_LIMIT_REACHED'))
    const word = clean(search.get('word'), 30); const page = Number(search.get('page') || 1); const num = Math.min(20, Math.max(1, Number(search.get('num') || 10)))
    const params = new URLSearchParams({ key: TIANAPI_KEY, ...(word ? { word } : {}), page: String(Number.isFinite(page) ? page : 1), num: String(num) })
    const upstream = await upstreamGet('apis.tianapi.com', `/caipu/index?${params}`)
    if (upstream.code !== 200) return send(res, 502, fail(upstream.msg || 'TianAPI 请求失败', 'UPSTREAM_ERROR'))
    return send(res, 200, ok({ recipes: upstream.result?.newslist || upstream.result?.list || [], usage: { count: usage.rows[0].count, limit: TIANAPI_DAILY_LIMIT } }))
  }
  if (pathname === '/api/v1/missions' && method === 'POST') { const input = await body(req); const title = clean(input.title, 120); const credit = Number(input.credit); if (!title || !Number.isFinite(credit) || credit < 1 || credit > 500) return send(res, 400, fail('任务标题或积分不合法')); const result = await query('INSERT INTO missions(space_id,creator_id,title,description,credit) VALUES($1,$2,$3,$4,$5) RETURNING *', [user.space_id, user.id, title, clean(input.desc, 1000), credit]); await withAudit(user, 'mission.create', 'mission', result.rows[0].id); return send(res, 201, ok(result.rows[0])) }
  if (pathname === '/api/v1/market' && method === 'POST') { const input = await body(req); const title = clean(input.title, 120); const credit = Number(input.credit); if (!title || !Number.isFinite(credit) || credit < 1 || credit > 500) return send(res, 400, fail('礼物标题或积分不合法')); const result = await query('INSERT INTO market_items(space_id,creator_id,title,description,credit) VALUES($1,$2,$3,$4,$5) RETURNING *', [user.space_id, user.id, title, clean(input.desc, 1000), credit]); await withAudit(user, 'market.create', 'market_item', result.rows[0].id); return send(res, 201, ok(result.rows[0])) }
  if (pathname === '/api/v1/recipes' && method === 'POST') { const input = await body(req); const title = clean(input.title, 160); if (!title) return send(res, 400, fail('请输入菜谱名称')); const result = await query('INSERT INTO recipes(space_id,creator_id,title,description,ingredients,steps,flavor,difficulty,minutes,cuisine) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [user.space_id, user.id, title, clean(input.desc, 1000), clean(input.ingredients, 4000), clean(input.steps, 5000), clean(input.flavor, 40) || '家常', clean(input.difficulty, 40) || '简单', Number(input.minutes) || null, clean(input.cuisine, 60) || '家常菜']); return send(res, 201, ok(result.rows[0])) }
  const complete = pathname.match(/^\/api\/v1\/missions\/([^/]+)\/complete$/); if (complete && method === 'POST') { const client = await pool.connect(); try { await client.query('BEGIN'); const found = await client.query('SELECT * FROM missions WHERE id=$1 AND space_id=$2 FOR UPDATE', [complete[1], user.space_id]); if (!found.rows.length) throw Object.assign(new Error('任务不存在'), { status: 404 }); const item = found.rows[0]; if (!item.available) throw Object.assign(new Error('任务已经完成'), { status: 409 }); if (item.creator_id === user.id) throw Object.assign(new Error('不能完成自己发布的任务'), { status: 400 }); await client.query('UPDATE missions SET available=false,completed_by=$1,completed_at=now() WHERE id=$2', [user.id, item.id]); await client.query('UPDATE space_members SET credit=LEAST(500,credit+$1) WHERE user_id=$2', [item.credit, item.creator_id]); await client.query('COMMIT'); await withAudit(user, 'mission.complete', 'mission', item.id); return send(res, 200, ok({ id: item.id })) } catch (error) { await client.query('ROLLBACK'); if (error.status) return send(res, error.status, fail(error.message)); throw error } finally { client.release() } }
  const purchase = pathname.match(/^\/api\/v1\/market\/([^/]+)\/purchase$/); if (purchase && method === 'POST') { const client = await pool.connect(); try { await client.query('BEGIN'); const found = await client.query('SELECT * FROM market_items WHERE id=$1 AND space_id=$2 FOR UPDATE', [purchase[1], user.space_id]); if (!found.rows.length) throw Object.assign(new Error('礼物不存在'), { status: 404 }); const item = found.rows[0]; if (!item.available) throw Object.assign(new Error('礼物已被兑换'), { status: 409 }); if (item.creator_id === user.id) throw Object.assign(new Error('不能兑换自己发布的礼物'), { status: 400 }); if (Number(user.credit || 0) < item.credit) throw Object.assign(new Error('积分不足'), { status: 400 }); await client.query('UPDATE market_items SET available=false,purchased_by=$1,purchased_at=now() WHERE id=$2', [user.id, item.id]); await client.query('UPDATE space_members SET credit=credit-$1 WHERE user_id=$2', [item.credit, user.id]); await client.query('INSERT INTO storage_items(space_id,owner_id,source_item_id,title,description,credit) VALUES($1,$2,$3,$4,$5,$6)', [user.space_id, user.id, item.id, item.title, item.description, item.credit]); await client.query('COMMIT'); await withAudit(user, 'market.purchase', 'market_item', item.id); return send(res, 200, ok({ id: item.id })) } catch (error) { await client.query('ROLLBACK'); if (error.status) return send(res, error.status, fail(error.message)); throw error } finally { client.release() } }
  const use = pathname.match(/^\/api\/v1\/storage\/([^/]+)\/use$/); if (use && method === 'POST') { const result = await query('UPDATE storage_items SET available=false,used_at=now() WHERE id=$1 AND owner_id=$2 AND available=true RETURNING id', [use[1], user.id]); if (!result.rows.length) return send(res, 404, fail('收藏不存在、已使用或无权操作')); return send(res, 200, ok(result.rows[0])) }
  if (pathname === '/api/v1/calendar/events' && method === 'GET') { const result = await query('SELECT * FROM calendar_events WHERE space_id=$1 ORDER BY starts_at LIMIT 200', [user.space_id]); return send(res, 200, ok(result.rows)) }
  if (pathname === '/api/v1/calendar/events' && method === 'POST') { const input = await body(req); const title = clean(input.title, 200); const start = new Date(input.startsAt); const end = new Date(input.endsAt || input.startsAt); if (!title || Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) return send(res, 400, fail('日程信息不完整')); const result = await query('INSERT INTO calendar_events(space_id,title,notes,starts_at,ends_at,all_day,source,updated_by) VALUES($1,$2,$3,$4,$5,$6,\'local\',$7) RETURNING *', [user.space_id, title, clean(input.notes, 2000), start, end, Boolean(input.allDay), user.id]); return send(res, 201, ok(result.rows[0])) }
  if (pathname === '/api/v1/calendar/connections' && method === 'GET') { const result = await query('SELECT id,provider,calendar_url,account_label,status,last_synced_at FROM calendar_connections WHERE space_id=$1 AND user_id=$2', [user.space_id, user.id]); return send(res, 200, ok(result.rows)) }
  if (pathname === '/api/v1/calendar/connections' && method === 'POST') {
    const input = await body(req); const calendarUrl = clean(input.calendarUrl, 500); const username = clean(input.username, 200); const appPassword = clean(input.appPassword, 300); const provider = clean(input.provider || 'caldav', 30); if (!calendarUrl || !username || !appPassword) return send(res, 400, fail('CalDAV 地址、账号和应用专用密码不能为空'))
    try { const client = await createDAVClient({ serverUrl: calendarUrl, credentials: { username, password: appPassword }, authMethod: 'Basic' }); await client.login({ loadCollections: true, loadObjects: false }); const result = await query('INSERT INTO calendar_connections(space_id,user_id,provider,calendar_url,account_label,credential_ciphertext,status,last_synced_at) VALUES($1,$2,$3,$4,$5,$6,\'connected\',now()) ON CONFLICT(space_id,user_id) DO UPDATE SET provider=EXCLUDED.provider,calendar_url=EXCLUDED.calendar_url,account_label=EXCLUDED.account_label,credential_ciphertext=EXCLUDED.credential_ciphertext,status=\'connected\',last_synced_at=now() RETURNING id,provider,calendar_url,account_label,status,last_synced_at', [user.space_id, user.id, provider, calendarUrl, clean(input.accountLabel || username, 120), encryptSecret(JSON.stringify({ username, password: appPassword }))]); return send(res, 201, ok(result.rows[0])) } catch (error) { return send(res, 502, fail(`CalDAV 连接失败：${error.message}`, 'CALDAV_ERROR')) }
  }
  if (pathname === '/api/v1/calendar/connections/sync' && method === 'POST') {
    const connection = await query('SELECT * FROM calendar_connections WHERE space_id=$1 AND user_id=$2 AND status=\'connected\'', [user.space_id, user.id]); if (!connection.rows.length) return send(res, 404, fail('尚未连接 CalDAV'))
    try { const credentials = JSON.parse(decryptSecret(connection.rows[0].credential_ciphertext)); const client = await createDAVClient({ serverUrl: connection.rows[0].calendar_url, credentials, authMethod: 'Basic' }); await client.login({ loadCollections: true, loadObjects: false }); const calendars = await client.fetchCalendars(); let imported = 0; for (const calendar of calendars) { const objects = await client.fetchCalendarObjects({ calendar, timeRange: { start: new Date().toISOString(), end: new Date(Date.now() + 90 * 86400000).toISOString() } }); for (const object of objects) { const data = object.data || ''; const title = String(data.match(/SUMMARY:(.*)/)?.[1] || 'CalDAV 日程').trim(); const uid = String(data.match(/UID:(.*)/)?.[1] || object.url); const start = String(data.match(/DTSTART(?:;[^:]*)?:(.*)/)?.[1] || '').trim(); if (!start) continue; const parsed = start.length === 8 ? `${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}T00:00:00Z` : `${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}T${start.slice(9, 11) || '00'}:${start.slice(11, 13) || '00'}:00Z`; await query('INSERT INTO calendar_events(space_id,external_id,title,starts_at,ends_at,source,updated_by) VALUES($1,$2,$3,$4,$4,\'caldav\',$5) ON CONFLICT(space_id,external_id) DO UPDATE SET title=EXCLUDED.title,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,updated_at=now()', [user.space_id, uid, title, new Date(parsed), user.id]); imported++ } } await query('UPDATE calendar_connections SET last_synced_at=now(),status=\'connected\' WHERE id=$1', [connection.rows[0].id]); return send(res, 200, ok({ imported, syncedAt: new Date().toISOString() })) } catch (error) { await query('UPDATE calendar_connections SET status=\'error\' WHERE id=$1', [connection.rows[0].id]); return send(res, 502, fail(`CalDAV 同步失败：${error.message}`, 'CALDAV_ERROR')) }
  }
  if (pathname === '/api/v1/expenses' && method === 'GET') { const result = await query('SELECT * FROM expenses WHERE space_id=$1 ORDER BY spent_on DESC,created_at DESC', [user.space_id]); return send(res, 200, ok(result.rows)) }
  if (pathname === '/api/v1/expenses' && method === 'POST') { const input = await body(req); const amount = Number(input.amount); const category = clean(input.category, 50); if (!Number.isFinite(amount) || amount <= 0 || !category) return send(res, 400, fail('金额和分类不能为空')); const result = await query('INSERT INTO expenses(space_id,created_by,amount,category,note,spent_on) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [user.space_id, user.id, amount, category, clean(input.note, 300), input.spentOn || new Date().toISOString().slice(0, 10)]); return send(res, 201, ok(result.rows[0])) }
  if (pathname === '/api/v1/budget' && method === 'GET') { const month = search.get('month') || new Date().toISOString().slice(0, 7) + '-01'; const budget = await query('SELECT * FROM budgets WHERE space_id=$1 AND month=$2', [user.space_id, month]); const spent = await query('SELECT COALESCE(SUM(amount),0)::numeric AS total FROM expenses WHERE space_id=$1 AND spent_on >= $2 AND spent_on < ($2::date + interval \'1 month\')', [user.space_id, month]); return send(res, 200, ok({ month, budget: budget.rows[0]?.amount || 0, spent: spent.rows[0].total })) }
  if (pathname === '/api/v1/budget' && method === 'PUT') { const input = await body(req); const month = clean(input.month, 10); const amount = Number(input.amount); if (!/^\d{4}-\d{2}-01$/.test(month) || !Number.isFinite(amount) || amount < 0) return send(res, 400, fail('预算格式不合法')); const result = await query('INSERT INTO budgets(space_id,month,amount) VALUES($1,$2,$3) ON CONFLICT(space_id,month) DO UPDATE SET amount=EXCLUDED.amount RETURNING *', [user.space_id, month, amount]); return send(res, 200, ok(result.rows[0])) }
  if (pathname === '/api/v1/album' && method === 'GET') { let album = await query('SELECT * FROM albums WHERE space_id=$1 LIMIT 1', [user.space_id]); if (!album.rows.length) album = await query('INSERT INTO albums(space_id) VALUES($1) RETURNING *', [user.space_id]); const photos = await query('SELECT id,uploaded_by,caption,taken_at,metadata,created_at,thumbnail_path FROM photos WHERE album_id=$1 ORDER BY created_at DESC', [album.rows[0].id]); return send(res, 200, ok({ album: album.rows[0], photos: photos.rows })) }
  if (pathname === '/api/v1/album/photos' && method === 'POST') { const input = await body(req); const album = await query('SELECT id FROM albums WHERE space_id=$1 LIMIT 1', [user.space_id]); if (!album.rows.length) return send(res, 404, fail('相册不存在')); const original = clean(input.originalPath, 500); if (!original) return send(res, 400, fail('照片路径不能为空')); const result = await query('INSERT INTO photos(album_id,uploaded_by,original_path,thumbnail_path,caption,taken_at,metadata) VALUES($1,$2,$3,$3,$4,$5,$6) RETURNING id,caption,taken_at,metadata,created_at,thumbnail_path', [album.rows[0].id, user.id, original, clean(input.caption, 300), input.takenAt || null, input.metadata || {}]); return send(res, 201, ok(result.rows[0])) }
  if (pathname === '/api/v1/ai/proposals' && method === 'GET') { const result = await query('SELECT * FROM ai_action_proposals WHERE space_id=$1 ORDER BY created_at DESC LIMIT 50', [user.space_id]); return send(res, 200, ok(result.rows)) }
  if (pathname === '/api/v1/ai/proposals' && method === 'POST') { const input = await body(req); const action = clean(input.action, 80); const allowed = ['create_mission', 'create_market_item', 'create_expense', 'create_event', 'complete_mission', 'purchase_market_item']; if (!allowed.includes(action)) return send(res, 400, fail('这个 AI 动作不允许由网页确认')); const result = await query('INSERT INTO ai_action_proposals(space_id,created_by,action,payload) VALUES($1,$2,$3,$4) RETURNING *', [user.space_id, user.id, action, input.payload || {}]); await withAudit(user, 'ai.proposal.create', 'ai_action_proposal', result.rows[0].id); return send(res, 201, ok(result.rows[0])) }
  const confirm = pathname.match(/^\/api\/v1\/ai\/proposals\/([^/]+)\/confirm$/); if (confirm && method === 'POST') {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const found = await client.query('SELECT * FROM ai_action_proposals WHERE id=$1 AND space_id=$2 AND status=\'pending\' FOR UPDATE', [confirm[1], user.space_id])
      if (!found.rows.length) { await client.query('ROLLBACK'); return send(res, 404, fail('提案不存在或已处理')) }
      const proposal = found.rows[0]; const result = await applyProposal(client, user, proposal)
      const updated = await client.query('UPDATE ai_action_proposals SET status=\'confirmed\',result=$1,confirmed_at=now() WHERE id=$2 RETURNING *', [result || {}, proposal.id])
      await client.query('COMMIT'); await withAudit(user, 'ai.proposal.confirm', 'ai_action_proposal', proposal.id, { action: proposal.action }); return send(res, 200, ok(updated.rows[0]))
    } catch (error) { await client.query('ROLLBACK'); if (error.status) return send(res, error.status, fail(error.message)); throw error } finally { client.release() }
  }
  return send(res, 404, fail('接口不存在', 'NOT_FOUND'))
}

const server = http.createServer(async (req, res) => { if (req.method === 'OPTIONS') return send(res, 204, null); try { const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`); await route(req, res, parsed.pathname, req.method, parsed.searchParams) } catch (error) { console.error(error); send(res, error.status || 500, fail(error.message || '服务器错误', error.code || 'INTERNAL_ERROR')) } })
server.listen(PORT, () => console.log(`Rainbow-Cats web server listening on ${PORT}`))
