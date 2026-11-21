-- Discovery TLS declaration intent
-- (docs/cloudflare-origin-ca-discovery-plan.md, "Discovery TLS labels and
-- wildcard certificate sources"): the normalized container-declared TLS
-- provider/wildcard request on the binding, plus the declaration-vs-explicit
-- policy conflict marker. Purely ADDITIVE: NULL = no declaration, so existing
-- bindings keep their persisted per-domain policy and installed certificates
-- are untouched. No ssl_* column or certificate material is modified.
ALTER TABLE "discovery_binding" ADD COLUMN IF NOT EXISTS "tls_declared_provider" text;
--> statement-breakpoint
ALTER TABLE "discovery_binding" ADD COLUMN IF NOT EXISTS "tls_declared_wildcard" text;
--> statement-breakpoint
ALTER TABLE "discovery_binding" ADD COLUMN IF NOT EXISTS "tls_policy_conflict" text;
