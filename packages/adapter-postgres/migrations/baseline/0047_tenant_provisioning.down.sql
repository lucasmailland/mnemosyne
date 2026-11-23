-- migrate:allow-drop reason=reverts the provisioned_by_tenant_id column 0047 adds

-- Reverts 0047. Tenant-bound keys go back to 500 on POST /tenants, POST /users,
-- createIfMissing invitations and workspaces created with an owner, and a
-- caller with no user sees every workspace's memberships again. Roll the
-- server back first: the routes of this change call these functions.
-- Memberships seeded through the policy stay: they are ordinary rows.

-- The two membership policies go back to their 0022 and 0012 shape, with the
-- empty-user branch that admits every row.
DROP POLICY IF EXISTS mnemo_workspace_member_read ON mnemosyne.mnemo_workspace_member;
CREATE POLICY mnemo_workspace_member_read ON mnemosyne.mnemo_workspace_member FOR SELECT USING (
  mnemosyne.is_workspace_member(workspace_id, current_setting('mnemosyne.actor_user_id', true))
  OR (user_id = current_setting('mnemosyne.actor_user_id', true))
  OR mnemosyne.is_tenant_admin_for_workspace(workspace_id, current_setting('mnemosyne.actor_user_id', true))
  OR (current_setting('mnemosyne.actor_user_id', true) = ''::text)
  OR (current_setting('mnemosyne.actor_user_id', true) IS NULL)
);
DROP POLICY IF EXISTS mnemo_workspace_member_write ON mnemosyne.mnemo_workspace_member;
CREATE POLICY mnemo_workspace_member_write ON mnemosyne.mnemo_workspace_member USING (
  mnemosyne.is_workspace_admin(workspace_id, current_setting('mnemosyne.actor_user_id', true))
  OR (current_setting('mnemosyne.actor_user_id', true) = ''::text)
  OR (current_setting('mnemosyne.actor_user_id', true) IS NULL)
);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_workspace_tenant_id(text);

DROP POLICY IF EXISTS mnemo_workspace_member_seed_owner ON mnemosyne.mnemo_workspace_member;
DROP FUNCTION IF EXISTS mnemosyne.mnemo_can_seed_workspace_owner(text, text, text, text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_find_user_id_by_email(text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_provision_user(text, text, text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_provision_tenant(text, text, text, text);
ALTER TABLE mnemosyne.mnemo_user DROP COLUMN IF EXISTS provisioned_by_tenant_id;
DROP FUNCTION IF EXISTS mnemosyne.mnemo_actor_may_provision();
