const assert = require('node:assert/strict')
const { test } = require('node:test')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')

function client() {
  const element = { innerHTML: '', dataset: {}, classList: { add() {}, remove() {} }, setAttribute() {}, removeAttribute() {} }
  const context = vm.createContext({
    document: { querySelector: selector => ['#app', '#toast'].includes(selector) ? element : null, querySelectorAll: () => [], addEventListener() {} },
    sessionStorage: { getItem: () => '', removeItem() {} },
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
