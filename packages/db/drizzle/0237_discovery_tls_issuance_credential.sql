-- The ISSUING credential reference on certificate inventory (plan §4 cleanup):
-- revocation must use the credential that ISSUED the certificate, not whatever
-- the domain's CURRENT policy names — that reference is cleared on a provider
-- switch and may change across Cloudflare reconfigurations, stranding the
-- replaced certificate until natural expiry. Nullable: legacy rows predate it.
ALTER TABLE "discovery_tls_issuance" ADD COLUMN "credential_id" text;
--> statement-breakpoint
-- The cleanup selector (activated rows whose certificate no domain references)
-- runs per server sweep; a partial index keeps it cheap as history grows.
CREATE INDEX IF NOT EXISTS "idx_discovery_tls_issuance_cleanup" ON "discovery_tls_issuance" ("state") WHERE "discovery_tls_issuance"."certificate_id" IS NOT NULL;
