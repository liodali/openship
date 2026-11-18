/** Server discovery API (docs/docker-service-discovery-plan.md, step 3 tail). */
import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./discovery.controller";

const r = secureRouter(new Hono(), { module: "discovery", basePath: "/api/discovery" });

r.get(
  "/servers/:id/discovery",
  { tag: "server:read", mcp: { description: "Read a server's discovery settings and every discovered service with its route state and TLS status." } },
  ctrl.getDiscovery,
);
r.get(
  "/servers/:id/discovery/services/:serviceKey/tls",
  { tag: "server:read", mcp: { description: "Read ONE discovered service's managed TLS policy (non-secret view): desired provider, installed provider, selection source, state (configuration_required/pending/active/error), and its Cloudflare credential/zone references. Never contains tokens or private keys." } },
  ctrl.getServiceTls,
);
r.put(
  "/servers/:id/discovery/services/:serviceKey/tls",
  { tag: "server:admin", auditHandledByOperation: true, mcp: { description: "Set ONE discovered service's managed TLS policy. Strict discriminated body: {provider:'letsencrypt'} or {provider:'cloudflare-origin-ca', cloudflare:{credentialId, zoneId, validityDays?}}. Cloudflare selections run read-only preflight (zone membership, proxied DNS, Full (strict), rule overrides) BEFORE any write — an invalid configuration leaves the previous policy and working certificate intact. The zone name is verified through Cloudflare, never trusted from input." } },
  ctrl.setServiceTls,
);
r.get(
  "/servers/:id/discovery/services/:serviceKey",
  { tag: "server:read", mcp: { description: "Read ONE discovered service by its stable identity (e.g. \"id:my-app\"), with its route state and TLS status — a constant-size read instead of the full server status. The service key travels URL-encoded as one path segment, including its colon and slash characters." } },
  ctrl.getDiscoveryService,
);
r.put(
  "/servers/:id/discovery",
  { tag: "server:admin", auditHandledByOperation: true, mcp: { description: "Enable or disable server discovery. Disable schedules retirement of every applied route (they are removed, certificates retained) and expires the event watchers." } },
  ctrl.configureDiscovery,
);
r.get(
  "/servers/:id/discovery/tls",
  { tag: "server:read", mcp: { description: "Read a server's managed TLS defaults for newly enrolled discovery domains. Existing domains keep their own persisted provider; no Cloudflare credential or zone is stored at server scope." } },
  ctrl.getServerTlsSettings,
);
r.put(
  "/servers/:id/discovery/tls",
  { tag: "server:admin", auditHandledByOperation: true, mcp: { description: "Set a server's managed TLS default provider for NEWLY enrolled discovery domains only. Changing the default never switches existing certificates. Accepted values: letsencrypt, cloudflare-origin-ca. No Cloudflare credentials are stored by this endpoint." } },
  ctrl.configureServerTls,
);
r.post(
  "/servers/:id/discovery/rescan",
  { tag: "server:write", readOnly: true, mcp: { description: "Run a fresh discovery scan, route reconciliation, and route repair for this server right now, through the serialized per-server sweep queue." } },
  ctrl.rescanDiscovery,
);
r.post(
  "/servers/:id/discovery/services/:serviceKey/tls/ensure",
  { tag: "server:write", mcp: { description: "Idempotently request TLS work for ONE discovered service: skips when valid material for the desired provider is already installed, otherwise persists a durable paced issuance operation and returns its stable operation id (queued/already_queued) or a deferred state with the reason. Never waits for issuance and never bypasses preflight." } },
  ctrl.ensureDiscoveryServiceTls,
);
r.post(
  "/servers/:id/discovery/services/:serviceKey/suppress",
  { tag: "server:write", auditHandledByOperation: true, mcp: { description: "Opt a discovered service out: it stays visible, its live route is removed outright, and no route is reconciled until re-accepted. Certificate material is retained." } },
  ctrl.suppressDiscoveryService,
);
r.post(
  "/servers/:id/discovery/services/:serviceKey/unsuppress",
  { tag: "server:write", auditHandledByOperation: true, mcp: { description: "Re-accept a suppressed discovered service; the next scan re-applies its route." } },
  ctrl.unsuppressDiscoveryService,
);
r.delete(
  "/servers/:id/discovery/services/:serviceKey",
  { tag: "server:admin", auditHandledByOperation: true, mcp: { description: "Forget a discovered service: its route is removed now and the binding deleted. The certificate record and files are retained." } },
  ctrl.forgetDiscoveryService,
);

export const discoveryRoutes = r.hono;
