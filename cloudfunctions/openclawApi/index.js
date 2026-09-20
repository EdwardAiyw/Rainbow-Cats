const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const MAX_CREDIT = 500

function fail(error, code = 'BAD_REQUEST') {
  return { ok: false, code, error }
}

function text(value, max) {
  const result = String(value || '').trim()
  return max && result.length > max ? result.slice(0, max) : result
}

function actorMap() {
  try {
    const raw = process.env.OPENCLAW_ACTOR_MAP || '{}'
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    console.error('OPENCLAW_ACTOR_MAP 配置无效', error)
    return {}
  }
}

async function authenticate(event) {
  const expected = process.env.OPENCLAW_API_TOKEN
  if (!expected || event.token !== expected) return { error: fail('OpenClaw API 未授权', 'UNAUTHORIZED') }
  const actorId = text(event.actorId, 80)
  const openId = actorMap()[actorId]
  if (!actorId || !openId) return { error: fail('未绑定的 OpenClaw 用户', 'ACTOR_NOT_BOUND') }
  const result = await db.collection('Memberships').where({ _openid: openId }).limit(1).get()
  if (!result.data.length) return { error: fail('该用户尚未加入双人空间', 'NO_SPACE') }
  return { actorId, openId, membership: result.data[0] }
}

async function listItems(list, spaceId, openId) {
  const where = { spaceId }
  if (list === 'StorageList') where._openid = openId
  const result = await db.collection(list).where(where).orderBy('date', 'desc').limit(100).get()
  return { ok: true, data: result.data }
}

async function createMission(input, openId, spaceId) {
  const title = text(input.title, 12)
  const desc = text(input.desc, 100)
  const credit = Number(input.credit)
  if (!title || !Number.isFinite(credit) || credit <= 0 || credit > MAX_CREDIT) return fail('任务标题或积分不合法')
  const created = await db.collection('MissionList').add({ data: {
    _openid: openId, spaceId, date: db.serverDate(), title, desc, credit, available: true, star: false
  } })
  return { ok: true, id: created._id, data: { title, desc, credit } }
}

async function completeMission(id, openId) {
  if (!id) return fail('缺少任务 ID')
  await db.runTransaction(async transaction => {
    const mission = await transaction.collection('MissionList').doc(id).get()
    if (!mission.data || !mission.data.spaceId) throw new Error('任务不存在')
    const member = await transaction.collection('Memberships').where({ _openid: openId, spaceId: mission.data.spaceId }).limit(1).get()
    if (!member.data.length) throw new Error('无权操作该任务')
    if (mission.data._openid === openId) throw new Error('不能完成自己发布的任务')
    if (!mission.data.available) throw new Error('任务已经完成')
    await transaction.collection('MissionList').doc(id).update({ data: { available: false, completedAt: db.serverDate(), completedBy: openId } })
    await transaction.collection('Memberships').where({ _openid: mission.data._openid, spaceId: mission.data.spaceId }).update({ data: { credit: _.inc(Number(mission.data.credit) || 0) } })
  })
  return { ok: true, id }
}

async function purchaseGift(id, openId) {
  if (!id) return fail('缺少礼物 ID')
  await db.runTransaction(async transaction => {
    const item = await transaction.collection('MarketList').doc(id).get()
    if (!item.data || !item.data.spaceId) throw new Error('礼物不存在')
    const buyer = await transaction.collection('Memberships').where({ _openid: openId, spaceId: item.data.spaceId }).limit(1).get()
    if (!buyer.data.length) throw new Error('无权兑换该礼物')
    if (item.data._openid === openId) throw new Error('不能兑换自己发布的礼物')
    if (!item.data.available) throw new Error('礼物已被兑换')
    const credit = Number(item.data.credit) || 0
    if (Number(buyer.data[0].credit) < credit) throw new Error('积分不足')
    await transaction.collection('MarketList').doc(id).update({ data: { available: false, purchasedAt: db.serverDate(), purchasedBy: openId } })
    await transaction.collection('Memberships').doc(buyer.data[0]._id).update({ data: { credit: _.inc(-credit) } })
    await transaction.collection('StorageList').add({ data: {
      _openid: openId, spaceId: item.data.spaceId, sourceItemId: id, sellerOpenId: item.data._openid,
      date: db.serverDate(), credit, title: item.data.title, desc: item.data.desc, available: true, star: false
    } })
  })
  return { ok: true, id }
}

exports.main = async (event = {}) => {
  try {
    const auth = await authenticate(event)
    if (auth.error) return auth.error
    const { openId, membership } = auth
    const action = text(event.action, 40)
    if (action === 'listMissions') return listItems('MissionList', membership.spaceId, openId)
    if (action === 'listMarket') return listItems('MarketList', membership.spaceId, openId)
    if (action === 'listStorage') return listItems('StorageList', membership.spaceId, openId)
    if (action === 'createMission') return createMission(event, openId, membership.spaceId)
    if (action === 'completeMission') return await completeMission(text(event.id, 100), openId)
    if (action === 'purchaseGift') return await purchaseGift(text(event.id, 100), openId)
    return fail('不支持的 OpenClaw 操作', 'UNKNOWN_ACTION')
  } catch (error) {
    console.error('OpenClaw API 调用失败', error)
    return fail(error.message || '操作失败', 'OPERATION_FAILED')
  }
}
