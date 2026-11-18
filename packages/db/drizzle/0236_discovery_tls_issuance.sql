-- Origin CA issuance inventory (docs/cloudflare-origin-ca-discovery-plan.md §3):
-- durable intent + encrypted pending material BEFORE the create request, and
-- the recovered/issued candidate after. Key material lives ONLY in key_enc
-- (enc1: envelope). Additive; plus the active-certificate inventory columns on
-- the domain row (provider certificate id + fingerprint for the INSTALLED
-- managed certificate).
CREATE TABLE IF NOT EXISTS "discovery_tls_issuance" (
  "id" text PRIMARY KEY NOT NULL DEFAULT 'dti_' || gen_random_uuid()::text,
  "domain_id" text NOT NULL REFERENCES "domain"("id") ON DELETE CASCADE,
  "operation_id" text,
  "hostname" text NOT NULL,
  "zone_id" text NOT NULL,
  "state" text DEFAULT 'pending_create' NOT NULL,
  "csr" text NOT NULL,
  "key_enc" text NOT NULL,
  "validity_days" integer NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "certificate_id" text,
  "certificate_pem" text,
  "fingerprint" text,
  "expires_on" timestamp,
  "reason" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_discovery_tls_issuance_live" ON "discovery_tls_issuance" ("domain_id") WHERE "discovery_tls_issuance"."state" IN ('pending_create','candidate');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_discovery_tls_issuance_cert" ON "discovery_tls_issuance" ("certificate_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_discovery_tls_issuance_domain" ON "discovery_tls_issuance" ("domain_id","state");
--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "tls_certificate_id" text;
--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "tls_certificate_fingerprint" text;
