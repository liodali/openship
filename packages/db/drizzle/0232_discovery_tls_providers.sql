-- Selectable managed TLS providers for discovery
-- (docs/cloudflare-origin-ca-discovery-plan.md §1: persist explicit TLS
-- policy). Purely ADDITIVE: no ssl_* column, certificate material, issuer
-- label, or route state is modified — existing certificates stay unchanged.
-- Backfill marks EXISTING server-scoped discovery domains as letsencrypt so
-- they keep their current behavior under the new policy vocabulary.
ALTER TABLE "discovery_settings" ADD COLUMN IF NOT EXISTS "tls_default_provider" text DEFAULT 'letsencrypt' NOT NULL;
--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "tls_provider" text;
--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "tls_provider_source" text;
--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "tls_active_provider" text;
--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "tls_policy_generation" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "tls_cf_credential_id" text REFERENCES "credential"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "tls_cf_zone_id" text;
--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "tls_cf_zone_name" text;
--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "tls_validity_days" integer;
--> statement-breakpoint
-- Data backfill: existing server-scoped discovery domains resolve to
-- letsencrypt (the provider that issued their material) with source=default.
-- Non-discovery owners (project/mail/webhook) stay NULL = outside this
-- managed selector. Generation starts at 1: a policy exists. tls_active_provider
-- is deliberately NOT guessed here — the TLS dispatch records it from actual
-- installed material.
UPDATE "domain"
SET "tls_provider" = 'letsencrypt',
    "tls_provider_source" = 'default',
    "tls_policy_generation" = 1
WHERE "owner_type" = 'server'
  AND "tls_provider" IS NULL;
