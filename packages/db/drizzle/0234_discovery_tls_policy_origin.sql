-- Durable provenance for explicit discovery TLS policies
-- (docs/cloudflare-origin-ca-discovery-plan.md, declaration conflict rule):
-- record WHO made the persisted explicit choice — an admin API/UI write or a
-- container declaration — instead of inferring ownership from value agreement.
-- Purely ADDITIVE: null = default-resolved (or absent) policy. Existing
-- certificate material and every ssl_* column are untouched.
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "tls_policy_origin" text;
--> statement-breakpoint
-- Backfill: before declarations existed, the explicit policy API was the ONLY
-- writer of tls_provider_source='explicit', so every existing explicit row is
-- admin-owned. A disagreeing declaration must conflict with these, never
-- overwrite them. Default-resolved rows stay null.
UPDATE "domain"
SET "tls_policy_origin" = 'admin'
WHERE "owner_type" = 'server'
  AND "tls_provider_source" = 'explicit'
  AND "tls_policy_origin" IS NULL;
