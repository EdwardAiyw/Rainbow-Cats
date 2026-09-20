const fs = require('fs')
const crypto = require('crypto')
const { Pool } = require('pg')

const inputPath = process.argv[2]
const apply = process.argv.includes('--apply')
const databaseUrl = process.env.DATABASE_URL
if (!inputPath) throw new Error('用法：node tools/migrate-cloudbase.js <脱敏 JSON 文件> [--apply]')
if (apply && !databaseUrl) throw new Error('执行写入时必须设置 DATABASE_URL')

const source = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
const names = ['Spaces', 'Memberships', 'MissionList', 'MarketList', 'StorageList', 'RecipeList']
const collections = source.collections || source
function rows(name) {
  const value = collections[name] || []
  if (Array.isArray(value)) return value.map(item => item.data || item)
  if (Array.isArray(value.data)) return value.data.map(item => item.data || item)
  throw new Error(`${name} 必须是数组或 { data: [] }`)
}
function text(value, fallback = '') { return value == null ? fallback : String(value).trim() }
function date(value) { const result = value && value.$date ? value.$date : value; return result ? new Date(result) : null }
function uuid() { return crypto.randomUUID() }
function requireValue(value, label) { if (!value) throw new Error(`${label} 缺少必要字段`); return value }

const data = Object.fromEntries(names.map(name => [name, rows(name)]))
const spaces = new Map()
const users = new Map()
const memberships = new Map()
const marketIds = new Map()
const errors = []
for (const item of data.Spaces) {
  const id = requireValue(text(item._id), 'Spaces._id')
  if (spaces.has(id)) errors.push(`Spaces._id 重复：${id}`)
  spaces.set(id, { id: uuid(), inviteCode: requireValue(text(item.inviteCode), `Spaces ${id} 的 inviteCode`), ownerOpenId: text(item.ownerOpenId), createdAt: date(item.createdAt) })
}
for (const item of data.Memberships) {
  const openId = requireValue(text(item._openid), 'Memberships._openid')
  const spaceId = requireValue(text(item.spaceId), `Memberships ${openId} 的 spaceId`)
  if (!spaces.has(spaceId)) errors.push(`Memberships ${openId} 引用了不存在的空间：${spaceId}`)
  if (users.has(openId)) errors.push(`一个 openId 属于多个成员记录：${openId}`)
  const user = { id: uuid(), openId, displayName: text(item.displayName, '未命名').slice(0, 12), credit: Math.max(0, Math.min(500, Number(item.credit) || 0)), createdAt: date(item.createdAt) }
  users.set(openId, user)
  memberships.set(text(item._id), { ...user, spaceId, membershipId: text(item._id) })
}
for (const [openId, space] of spaces) {
  if (space.ownerOpenId && !users.has(space.ownerOpenId)) errors.push(`空间 ${openId} 的 ownerOpenId 无对应成员：${space.ownerOpenId}`)
  if (space.inviteCode.length > 12) errors.push(`邀请码过长：${space.inviteCode}`)
}
const memberCount = new Map()
for (const member of memberships.values()) memberCount.set(member.spaceId, (memberCount.get(member.spaceId) || 0) + 1)
for (const [spaceId, count] of memberCount) if (count > 2) errors.push(`空间 ${spaceId} 成员超过 2 人：${count}`)
for (const name of ['MissionList', 'MarketList']) for (const item of data[name]) {
  const credit = Number(item.credit)
  if (!Number.isFinite(credit) || credit <= 0 || credit > 500) errors.push(`${name} ${text(item._id)} 的积分不在 1-500 范围内`)
  if (text(item.title).length > 12) errors.push(`${name} ${text(item._id)} 的标题超过 12 个字符`)
}

function owner(item, label) {
  const openId = requireValue(text(item._openid), `${label}._openid`)
  const member = users.get(openId)
  if (!member) throw new Error(`${label} 引用了不存在的成员：${openId}`)
  const space = spaces.get(requireValue(text(item.spaceId), `${label}.spaceId`))
  if (!space) throw new Error(`${label} 引用了不存在的空间`)
  return { member, space }
}
function common(item, label, maxTitle = 16) {
  const { member, space } = owner(item, label)
  return { id: uuid(), spaceId: space.id, userId: member.id, title: text(item.title).slice(0, maxTitle), description: text(item.desc).slice(0, 100), createdAt: date(item.date || item.createdAt) }
}

const counts = Object.fromEntries(names.map(name => [name, data[name].length]))
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', counts, users: users.size, errors }, null, 2))
if (errors.length) throw new Error(`迁移校验失败，共 ${errors.length} 个问题`)
if (!apply) { console.log('dry-run 完成：未写入数据库'); process.exit(0) }

async function run() {
  const pool = new Pool({ connectionString: databaseUrl })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const user of users.values()) await client.query('INSERT INTO users(id, legacy_open_id, display_name, created_at) VALUES($1,$2,$3,COALESCE($4,now()))', [user.id, user.openId, user.displayName, user.createdAt])
    for (const [legacyId, space] of spaces) {
      const ownerUser = users.get(space.ownerOpenId)
      if (!ownerUser) throw new Error(`空间 ${legacyId} 缺少创建者`)
      await client.query('INSERT INTO spaces(id, invite_code, owner_user_id, created_at) VALUES($1,$2,$3,COALESCE($4,now()))', [space.id, space.inviteCode, ownerUser.id, space.createdAt])
    }
    for (const member of memberships.values()) await client.query('INSERT INTO space_members(space_id,user_id,display_name,credit,created_at) VALUES($1,$2,$3,$4,COALESCE($5,now()))', [spaces.get(member.spaceId).id, member.id, member.displayName, member.credit, member.createdAt])
    for (const item of data.MissionList) { const row = common(item, 'MissionList', 12); await client.query('INSERT INTO missions(id,space_id,creator_id,title,description,credit,available,star,completed_by,created_at,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [row.id,row.spaceId,row.userId,row.title,row.description,Number(item.credit)||0,item.available !== false,item.star === true,users.get(text(item.completedBy))?.id || null,row.createdAt,date(item.completedAt)]) }
    for (const item of data.MarketList) { const row = common(item, 'MarketList', 12); marketIds.set(text(item._id), row.id); await client.query('INSERT INTO market_items(id,space_id,creator_id,title,description,credit,available,purchased_by,created_at,purchased_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [row.id,row.spaceId,row.userId,row.title,row.description,Number(item.credit)||0,item.available !== false,users.get(text(item.purchasedBy))?.id || null,row.createdAt,date(item.purchasedAt)]) }
    for (const item of data.StorageList) { const row = common(item, 'StorageList', 12); const sourceId = marketIds.get(text(item.sourceItemId)) || null; await client.query('INSERT INTO storage_items(id,space_id,owner_id,source_item_id,title,description,credit,available,created_at,used_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [row.id,row.spaceId,row.userId,sourceId,row.title,row.description,Number(item.credit)||0,item.available !== false,row.createdAt,date(item.usedAt)]) }
    for (const item of data.RecipeList) { const row = common(item, 'RecipeList'); await client.query('INSERT INTO recipes(id,space_id,creator_id,title,description,ingredients,steps,flavor,difficulty,minutes,cuisine,is_preset,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [row.id,row.spaceId,row.userId,row.title,row.description,text(item.ingredients).slice(0,200),text(item.steps).slice(0,500),text(item.flavor,'家常').slice(0,20),text(item.difficulty,'简单').slice(0,20),Number(item.minutes)||null,text(item.cuisine,'江西菜').slice(0,30),item.isPreset === true,row.createdAt]) }
    await client.query('COMMIT')
    console.log('migration applied successfully')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release(); await pool.end() }
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
