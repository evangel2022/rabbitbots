-- The deployment outbound proxy choice. Null mode preserves the environment proxy behavior.
ALTER TABLE "deployment_settings"
  ADD COLUMN "outbound_proxy_mode" TEXT,
  ADD COLUMN "outbound_proxy_cipher" TEXT;
