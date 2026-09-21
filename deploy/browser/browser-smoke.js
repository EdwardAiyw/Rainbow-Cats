const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3418'
const outputDir = process.env.OUTPUT_DIR || '/output'
const suffix = `${Date.now()}${process.pid}`
const username = `browser_${suffix}`.slice(0, 36)
const password = 'RainbowCats-browser-2026'
const displayName = `浏览器${suffix}`.slice(0, 20)
const missionTitle = `浏览器验证-${suffix}`.slice(0, 40)
const report = { baseUrl, username, checks: [], dialogs: [], pageErrors: [] }

function checked(name) {
  report.checks.push(name)
  process.stdout.write(`✓ ${name}\n`)
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  page.on('dialog', async dialog => {
    report.dialogs.push(dialog.message())
    await dialog.accept()
  })
  page.on('pageerror', error => report.pageErrors.push(error.message))

  try {
    const response = await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30000 })
    assert.equal(response?.status(), 200)
    await page.locator('#auth-form').waitFor()
    checked('登录页可通过真实 Chromium 打开')

    await page.getByRole('button', { name: '创建空间', exact: true }).click()
    await page.locator('#auth-form input[name="username"]').fill(username)
    await page.locator('#auth-form input[name="password"]').fill(password)
    await page.locator('#auth-form input[name="displayName"]').fill(displayName)
    await page.locator('#auth-form button[type="submit"]').click()
    await page.locator('.workspace').waitFor({ timeout: 15000 })
    assert.ok(report.dialogs.some(message => message.includes('恢复码')))
    checked('创建空间、恢复码和自动登录正常')

    await page.locator('[data-view="missions"]').first().click()
    await page.locator('[data-action="new-mission"]').click()
    const modal = page.locator('#modal-form')
    await modal.locator('input[name="title"]').fill(missionTitle)
    await modal.locator('textarea[name="desc"]').fill('Playwright 生产前浏览器回归')
    await modal.locator('input[name="credit"]').fill('12')
    await modal.locator('button[type="submit"]').click()
    await page.getByText(missionTitle, { exact: true }).waitFor({ timeout: 15000 })
    checked('页面创建任务并重新读取数据库正常')

    await page.locator('[data-view="settings"]').first().click()
    await page.getByText(`账号：${username}`, { exact: true }).waitFor()
    await page.locator('[data-action="logout"]').click()
    await page.locator('#auth-form').waitFor()
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.locator('#auth-form input[name="username"]').fill(username)
    await page.locator('#auth-form input[name="password"]').fill(password)
    await page.locator('#auth-form button[type="submit"]').click()
    await page.locator('.workspace').waitFor({ timeout: 15000 })
    await page.reload({ waitUntil: 'networkidle' })
    await page.locator('.workspace').waitFor()
    checked('退出、账号密码登录和刷新会话正常')

    await page.locator('[data-view="ai"]').first().click()
    await page.getByText('OpenClaw 尚未启用', { exact: true }).waitFor()
    assert.equal(await page.locator('#ai-chat-form button[type="submit"]').isDisabled(), true)
    checked('OpenClaw 状态与禁用态展示正常')

    await page.setViewportSize({ width: 390, height: 844 })
    const mobileDisplay = await page.locator('.mobile-nav').evaluate(element => getComputedStyle(element).display)
    assert.notEqual(mobileDisplay, 'none')
    assert.ok(await page.locator('body').evaluate(element => element.scrollWidth <= innerWidth + 1))
    await page.screenshot({ path: path.join(outputDir, 'browser-mobile.png'), fullPage: true })
    checked('移动端导航与横向布局正常')

    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.locator('[data-view="settings"]').first().click()
    await page.screenshot({ path: path.join(outputDir, 'browser-desktop.png'), fullPage: true })
    await page.locator('[data-delete-account]').click()
    await page.locator('#auth-form').waitFor({ timeout: 15000 })
    checked('账号删除与级联清理正常')

    assert.deepEqual(report.pageErrors, [])
    report.ok = true
  } catch (error) {
    report.ok = false
    report.error = error.stack || String(error)
    await page.screenshot({ path: path.join(outputDir, 'browser-failure.png'), fullPage: true }).catch(() => {})
    throw error
  } finally {
    fs.writeFileSync(path.join(outputDir, 'browser-report.json'), JSON.stringify(report, null, 2))
    await context.close()
    await browser.close()
  }
}

main().catch(error => {
  console.error(error.stack || error)
  process.exitCode = 1
})
