-- Shop database: operator abandon of a `dead` outbox row (spec 12.4 « l'abandonner, ce qui débloque la
-- suite et déclenche une réconciliation de l'objet concerné », 12.7 `outbox_dead`). Additive only
-- (spec 10.4): the `status` CHECK of `outbox` (0003) cannot change without rebuilding the table, so an
-- abandoned row ends in `failed` (a final status that no longer blocks its serial key) and these columns
-- tell it apart from a business refusal by Shopify. Conventions: timestamps in ms UTC (INTEGER).
ALTER TABLE outbox ADD COLUMN abandoned_at INTEGER;
-- Shopify user id of the administrator who abandoned the row (actor of the audit_log entry).
ALTER TABLE outbox ADD COLUMN abandoned_by TEXT;
