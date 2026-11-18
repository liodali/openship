import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { DiscoveryTlsProvider, DiscoveryTlsProviderSource, DiscoveryTlsPolicyOrigin } from "@repo/core";
import { project } from "./project";
import { service } from "./service";
import { webhookSource } from "./webhook-source";
import { servers } from "./servers";
import { credential } from "./credential";

// ─── Domains ─────────────────────────────────────────────────────────────────

/**
 * Custom domains linked to a project, a webhook source, OR a mail server
 * (polymorphic owner). Each domain goes through a verification flow (DNS TXT
 * record check) before becoming active and getting SSL provisioned.
 */
export const domain = pgTable(
  "domain",
  {
    id: text("id").primaryKey(), // "dom_..."
    /**
     * Owner discriminator: "project" (the default — routes to a deployed app),
     * "webhook" (routes to the inbound webhook receiver for `webhookSourceId`), or
     * "mail" (the `mail.<domain>` host of a mail server — `mailServerId`).
     * Existing rows backfill to "project" via the column default.
     */
    ownerType: text("owner_type").notNull().default("project"),
    /** Owning project — NULL for a webhook- or mail-owned domain. */
    projectId: text("project_id").references(() => project.id, { onDelete: "cascade" }),
    /** Owning webhook source — set when ownerType='webhook'; routes to the receiver. */
    webhookSourceId: text("webhook_source_id").references(() => webhookSource.id, {
      onDelete: "cascade",
    }),
    /**
     * Owning server — set when ownerType='server' (Docker service discovery).
     * Server-scoped domains need neither a project nor a deployment: the
     * serving Edge and management access derive from this server row, and the
     * certificate lifecycle gates on a running discovered container (tracked by
     * the matching `discovery_binding` row, linked by serverId + hostname — not
     * by FK, so forgetting a binding can retain the domain's certificate
     * material). Cascade: a removed server takes its domains with it.
     */
    serverId: text("server_id").references(() => servers.id, { onDelete: "cascade" }),
    //
    // NOTE: a mail-owned row (ownerType='mail') carries NO owner FK. Its server is
    // derived from the hostname instead — `mail.<domain>` → `mail_servers.domain` →
    // `server_id` — because `mail.<base>` is already the system-wide convention (the
    // wizard builds it, and step 13 symlinks certs by it). That keeps this table free
    // of a fourth owner column, and the mail_servers row is already the canonical
    // "this server is a mail server for this domain" record, so the two cannot drift.
    // Why a mail host is in this table at all: it's what the renewal sweep reads
    // (`findExpiringSsl` → `renewExpiringCerts`), and without a row the mail
    // certificate was invisible to the renewer and expired ~90 days after install.
    /** Service ID for service-scoped domain routing (null = project-level / main service) */
    serviceId: text("service_id").references(() => service.id, { onDelete: "cascade" }),

    /** The custom domain (e.g. "app.example.com") */
    hostname: text("hostname").notNull().unique(),
    /** Internal target port this hostname should route to */
    targetPort: integer("target_port"),
    /** Static output subpath this hostname should serve */
    targetPath: text("target_path"),
    /** Route kind: managed/free subdomain or custom domain */
    domainType: text("domain_type"),
    /** Is this the primary domain for the project? */
    isPrimary: boolean("is_primary").notNull().default(false),

    /**
     * Canonical redirect: when set, this hostname does NOT serve the app — its
     * vhost answers `redirect_status` (null = 301) pointing at
     * `https://<redirect_to><original path+query>`.
     *
     * The target must be ANOTHER hostname of the same project (enforced by
     * lib/domain-redirect.ts, which also rejects self-targets and redirect cycles —
     * a cycle is an instant outage, and an unconstrained target would turn the
     * operator's own verified domain into an open redirect).
     *
     * A redirecting host still needs its own DNS record, its own verification and
     * its own certificate: it has to serve a valid `https://` before it can 301.
     * That independence is the point — this is how `www.example.com` becomes an
     * ordinary domain that happens to point at its apex, instead of a flag on it.
     */
    redirectTo: text("redirect_to"),
    /** 301 | 302 | 307 | 308. Null = 301. */
    redirectStatus: integer("redirect_status"),

    /**
     * Externally-managed ingress + TLS. When true, an upstream (Cloudflare Tunnel,
     * a load balancer, etc.) terminates TLS and forwards HTTP to this box, so the
     * hostname does NOT resolve to the server's (possibly Tailscale) SSH address.
     * Openship then: verifies ownership via TXT only (no A-record check), skips
     * certbot, and serves a plain-HTTP OpenResty route. DNS/LB/firewall stay
     * outside Openship.
     */
    externalIngress: boolean("external_ingress").notNull().default(false),

    /**
     * Origin TLS from an operator-supplied certificate (bring-your-own /
     * Cloudflare Origin CA) instead of certbot. When true we serve HTTPS from
     * the uploaded cert and never run ACME — this is what lets an
     * externalIngress domain (Cloudflare Full-strict, L4 passthrough LB) hold a
     * real cert at origin even though DNS points upstream. Orthogonal to
     * externalIngress; also valid on a direct domain that supplies its own cert.
     * The cert itself lives on disk (see the SSL block); this flag is the
     * route-planner signal and survives verify/recheck (which would otherwise
     * relabel sslIssuer back to "certbot").
     */
    manualSsl: boolean("manual_ssl").notNull().default(false),

    /* ── Verification ───────────────────────────────────────────────────── */
    /** pending (not checked yet) | active | failed (last check failed) | removing */
    status: text("status").notNull().default("pending"),
    /** DNS TXT verification value (e.g. "openship-verify=abc123") */
    verificationToken: text("verification_token"),
    /** Whether DNS verification has passed */
    verified: boolean("verified").notNull().default(false),
    verifiedAt: timestamp("verified_at"),
    /**
     * Verification/TLS retry state. `verifyAttempts`
     * counts consecutive failed checks (reset to 0 on success); `lastVerifyError`
     * is the most recent human-readable failure reason; `lastCheckedAt` is when
     * a check last completed (manual or automatic). Failed checks remain eligible
     * for automatic retry with persisted backoff; success resets the counter.
     */
    verifyAttempts: integer("verify_attempts").notNull().default(0),
    lastVerifyError: text("last_verify_error"),
    lastCheckedAt: timestamp("last_checked_at"),

    /* ── SSL ─────────────────────────────────────────────────────────────── */
    /** SSL status: none | provisioning | active | expired | error */
    sslStatus: text("ssl_status").notNull().default("none"),
    /** SSL challenge mechanism: http-01 | dns-01 */
    sslChallenge: text("ssl_challenge").notNull().default("http-01"),
    /** Manual DNS needs a new TXT confirmation at renewal; never start it in a sweep. */
    sslDnsMode: text("ssl_dns_mode").$type<"automatic" | "manual">().notNull().default("automatic"),
    /** Issuer (e.g. "letsencrypt", "oblien") */
    sslIssuer: text("ssl_issuer"),
    /** When the current certificate expires */
    sslExpiresAt: timestamp("ssl_expires_at"),

    /* ── Managed TLS provider policy (server-scoped discovery domains) ────
     *
     * Operator INTENT for discovery's managed TLS selection
     * (docs/cloudflare-origin-ca-discovery-plan.md). All columns are NULL on
     * non-discovery owners (project/mail/webhook): the policy is server-scoped
     * discovery only, and project/manual/external TLS paths stay unchanged.
     *
     * These columns never describe certificate material: `sslIssuer` keeps
     * describing installed certificates, and no writer here may touch the
     * ssl_* columns — existing certificates are unchanged by policy writes.
     */
    /**
     * The RESOLVED, desired managed provider persisted at enrollment (explicit
     * override or server default) or by an explicit policy change. Authoritative
     * once set: a server default change never rewrites it.
     */
    tlsProvider: text("tls_provider").$type<DiscoveryTlsProvider>(),
    /** Whether the persisted provider came from the server default or an explicit override (UI/audit). */
    tlsProviderSource: text("tls_provider_source").$type<DiscoveryTlsProviderSource>(),
    /**
     * DURABLE provenance of the explicit policy: `admin` (API/UI write) or
     * `declaration` (container label/env write). Null while the policy is
     * default-resolved (or absent). Recorded by every policy writer — never
     * inferred from value agreement — so a disagreeing declaration can only
     * evolve a policy the declaration itself owns; an admin-selected policy
     * (including admin credential/zone configuration under a declared provider)
     * conflicts instead of being overwritten. Pre-0234 explicit rows backfill
     * to `admin`: the policy API was their only writer.
     */
    tlsPolicyOrigin: text("tls_policy_origin").$type<DiscoveryTlsPolicyOrigin>(),
    /**
     * The provider whose certificate is actually INSTALLED and managed. Lags
     * tlsProvider while a staged provider switch is pending; null before any
     * managed installation is recorded.
     */
    tlsActiveProvider: text("tls_active_provider").$type<DiscoveryTlsProvider>(),
    /** Bumped on every policy change; expected-generation checks keep stale writers and in-flight work from winning races. */
    tlsPolicyGeneration: integer("tls_policy_generation").notNull().default(0),
    /** Origin CA references — required TOGETHER when tlsProvider is cloudflare-origin-ca. Null for letsencrypt. */
    tlsCfCredentialId: text("tls_cf_credential_id").references(() => credential.id, {
      onDelete: "set null",
    }),
    /** The exact authorized Cloudflare zone id (never a zone selector or automatic match). */
    tlsCfZoneId: text("tls_cf_zone_id"),
    /** Zone display name, recorded only after verification through Cloudflare — never a submitted name. */
    tlsCfZoneName: text("tls_cf_zone_name"),
    /** Requested Origin CA validity in days; null = provider default (365). */
    tlsValidityDays: integer("tls_validity_days"),

    /* ── Active certificate inventory (managed providers) ───────────────── */
    /** The provider certificate ID for the INSTALLED managed certificate (Origin CA id; null for ACME). */
    tlsCertificateId: text("tls_certificate_id"),
    /** SHA-256 fingerprint of the installed managed certificate. */
    tlsCertificateFingerprint: text("tls_certificate_fingerprint"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // A primary is a project-wide routing choice, including service-scoped
    // domain rows. NULL project ids belong to webhook/mail owners and are not
    // part of this invariant.
    uniqueIndex("uq_domain_project_primary")
      .on(t.projectId)
      .where(sql`${t.isPrimary} = true AND ${t.projectId} IS NOT NULL`),
    // Routing hot path — every request that resolves a hostname hits this.
    index("idx_domain_project").on(t.projectId),
    index("idx_domain_project_hostname").on(t.projectId, t.hostname),
    index("idx_domain_webhook_source").on(t.webhookSourceId),
    // Server-scoped domains: certificate sweep + server status reads by server.
    index("idx_domain_server").on(t.serverId),
    // The binding↔domain join (see schema/discovery.ts): one row per (server, hostname).
    index("idx_domain_server_hostname").on(t.serverId, t.hostname),
  ],
);
