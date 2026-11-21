-- Durable TLS operation queue (docs/cloudflare-origin-ca-discovery-plan.md,
-- "Asynchronous queue, ensure API"): the ROW is the queue — waiting work
-- survives restarts, drains through worker leases, and dedupes by one ACTIVE
-- operation per serving server + certificate source + policy generation.
CREATE TABLE IF NOT EXISTS "discovery_tls_operation" (
  "id" text PRIMARY KEY NOT NULL DEFAULT 'dtop_' || gen_random_uuid()::text,
  "hostname" text NOT NULL,
  "source_hostname" text NOT NULL,
  "source" text DEFAULT 'exact' NOT NULL,
  "provider" text NOT NULL,
  "domain_id" text NOT NULL REFERENCES "domain"("id") ON DELETE CASCADE,
  "server_id" text NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL,
  "service_key" text NOT NULL,
  "policy_generation" integer NOT NULL,
  "state" text DEFAULT 'waiting' NOT NULL,
  "outcome" text,
  "reason" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp,
  "leased_by" text,
  "leased_until" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_discovery_tls_operation_active" ON "discovery_tls_operation" ("server_id","source_hostname","policy_generation") WHERE "discovery_tls_operation"."state" IN ('waiting','running','deferred','error');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_discovery_tls_operation_due" ON "discovery_tls_operation" ("state","next_attempt_at","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_discovery_tls_operation_server" ON "discovery_tls_operation" ("server_id","hostname");
