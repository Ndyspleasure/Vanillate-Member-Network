-- Additive upgrade. Keep schema.sql unchanged once its initial checksum is recorded.
ALTER TABLE member_network.members ALTER COLUMN discord_id DROP NOT NULL;
ALTER TABLE member_network.members ADD COLUMN IF NOT EXISTS delete_requested_at timestamptz;
ALTER TABLE member_network.members ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS members_retention ON member_network.members(updated_at) WHERE connection_status='revoked';
