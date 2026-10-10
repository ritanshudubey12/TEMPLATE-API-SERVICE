-- Local-development rollback only. Never run automatically; review before using anywhere else.
DROP TABLE IF EXISTS outbox_events;
DROP TABLE IF EXISTS template_audit_logs;
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS template_apply_jobs;
DROP TABLE IF EXISTS template_tag_links;
DROP TABLE IF EXISTS template_tags;
ALTER TABLE IF EXISTS templates DROP CONSTRAINT IF EXISTS fk_templates_current_version;
DROP TABLE IF EXISTS template_versions;
DROP FUNCTION IF EXISTS prevent_published_version_mutation();
DROP TABLE IF EXISTS templates;
DROP TABLE IF EXISTS template_categories;
DELETE FROM schema_migrations WHERE filename = '001_init.sql';
