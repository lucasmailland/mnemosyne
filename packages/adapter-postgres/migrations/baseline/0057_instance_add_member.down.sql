-- Reverts 0057. Memberships added through it stay.
DROP FUNCTION IF EXISTS mnemosyne.mnemo_instance_add_member(text, text, text, text);
