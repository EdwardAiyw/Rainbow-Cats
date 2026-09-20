const { Pool } = require('pg')

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('请先设置 DATABASE_URL，再运行 npm run audit:db')

const pool = new Pool({ connectionString: databaseUrl })

async function scalar(sql) {
  const result = await pool.query(sql)
  return Number(result.rows[0].count)
}

async function main() {
  const [users, spaces, memberships, missions, marketItems, storageItems, recipes, sessions, apiUsage, usersWithoutSpace, orphanMembers, oversizedSpaces, orphanMissions, orphanMarketItems, orphanStorage, expiredSessions, spaceSizes] = await Promise.all([
    scalar('SELECT count(*) FROM users'),
    scalar('SELECT count(*) FROM spaces'),
    scalar('SELECT count(*) FROM space_members'),
    scalar('SELECT count(*) FROM missions'),
    scalar('SELECT count(*) FROM market_items'),
    scalar('SELECT count(*) FROM storage_items'),
    scalar('SELECT count(*) FROM recipes'),
    scalar('SELECT count(*) FROM sessions'),
    scalar('SELECT count(*) FROM api_usage'),
    scalar('SELECT count(*) FROM users u LEFT JOIN space_members sm ON sm.user_id=u.id WHERE sm.user_id IS NULL'),
    scalar('SELECT count(*) FROM space_members sm LEFT JOIN spaces s ON s.id=sm.space_id WHERE s.id IS NULL'),
    scalar('SELECT count(*) FROM (SELECT space_id FROM space_members GROUP BY space_id HAVING count(*) > 2) spaces'),
    scalar('SELECT count(*) FROM missions m LEFT JOIN users u ON u.id=m.creator_id WHERE u.id IS NULL'),
    scalar('SELECT count(*) FROM market_items m LEFT JOIN users u ON u.id=m.creator_id WHERE u.id IS NULL'),
    scalar('SELECT count(*) FROM storage_items si LEFT JOIN users u ON u.id=si.owner_id WHERE u.id IS NULL'),
    scalar('SELECT count(*) FROM sessions WHERE revoked_at IS NULL AND expires_at <= now()'),
    pool.query('SELECT count(*)::int AS members FROM space_members GROUP BY space_id ORDER BY members')
  ])

  const summary = { users, spaces, memberships, missions, marketItems, storageItems, recipes, sessions, apiUsage }
  const integrity = { usersWithoutSpace, orphanMembers, oversizedSpaces, orphanMissions, orphanMarketItems, orphanStorage, expiredSessions }
  const memberDistribution = spaceSizes.rows.map(row => Number(row.members))
  console.log(JSON.stringify({ summary, integrity, memberDistribution, healthy: Object.values(integrity).every(value => value === 0) }, null, 2))
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1 }).finally(() => pool.end())
