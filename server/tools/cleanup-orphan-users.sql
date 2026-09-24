\encoding UTF8
\set ON_ERROR_STOP on

BEGIN;
LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE space_members IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE cleanup_orphan_users ON COMMIT DROP AS
SELECT u.id
FROM users u
WHERE NOT EXISTS (SELECT 1 FROM space_members sm WHERE sm.user_id = u.id);

SELECT set_config('rainbow.expected_orphan_users', :'expected_count', true);

DO $$
DECLARE
  actual_count integer;
  blocking_references integer;
BEGIN
  SELECT count(*) INTO actual_count FROM cleanup_orphan_users;
  IF actual_count <> current_setting('rainbow.expected_orphan_users')::integer THEN
    RAISE EXCEPTION 'Orphan user count changed: expected %, found %',
      current_setting('rainbow.expected_orphan_users'), actual_count;
  END IF;

  SELECT
    (SELECT count(*) FROM spaces s JOIN cleanup_orphan_users c ON c.id = s.owner_user_id) +
    (SELECT count(*) FROM missions m JOIN cleanup_orphan_users c ON c.id IN (m.creator_id, m.completed_by)) +
    (SELECT count(*) FROM market_items m JOIN cleanup_orphan_users c ON c.id IN (m.creator_id, m.purchased_by)) +
    (SELECT count(*) FROM storage_items i JOIN cleanup_orphan_users c ON c.id = i.owner_id) +
    (SELECT count(*) FROM recipes r JOIN cleanup_orphan_users c ON c.id = r.creator_id) +
    (SELECT count(*) FROM calendar_connections x JOIN cleanup_orphan_users c ON c.id = x.user_id) +
    (SELECT count(*) FROM calendar_events e JOIN cleanup_orphan_users c ON c.id = e.updated_by) +
    (SELECT count(*) FROM expenses e JOIN cleanup_orphan_users c ON c.id = e.created_by) +
    (SELECT count(*) FROM photos p JOIN cleanup_orphan_users c ON c.id = p.uploaded_by) +
    (SELECT count(*) FROM ai_action_proposals p JOIN cleanup_orphan_users c ON c.id IN (p.created_by, p.confirmed_by_user_id))
  INTO blocking_references;

  IF blocking_references <> 0 THEN
    RAISE EXCEPTION 'Orphan users still have % business references; cleanup cancelled', blocking_references;
  END IF;
END $$;

WITH deleted AS (
  DELETE FROM users u
  USING cleanup_orphan_users c
  WHERE u.id = c.id
  RETURNING u.id
)
SELECT count(*) AS deleted_users FROM deleted;

COMMIT;
