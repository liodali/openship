/**
 * SSL renewal — batch renewal of expiring certbot certificates.
 *
 * Wired to the shared JobRunner as the "ssl:renew" system job for customer hosts
 * on every control plane (registered via the generic jobs module — see
 * modules/jobs/job.registry.ts). Still callable directly from an admin endpoint
 * or external cron.
 *
 * Each expiring domain is renewed via `manageDomainSsl`, which resolves the SSL
 * provider on the SAME host that serves the domain (per-project, not the global
 * orchestrator) — so multi-server self-hosted renews on the right box. Manual
 * (BYO) certs are skipped: certbot never issued them, so they can't be renewed.
 */

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { repos, type Domain } from "@repo/db";
import { AppError, SYSTEM, currentMailCertificateHealth, mailHostname } from "@repo/core";
import { env } from "../config/env";
import { renewMailCertificate } from "../modules/mail/mail-certificate.service";
import {
  MAIL_DOMAIN_OWNER,
  DiscoveryBackendUnavailableError,
  manageDomainSsl,
  resolveMailOwner,
  tlsIssuedElsewhere,
} from "@repo/platform/engine/lib/domain-ssl";
import { notification } from "@repo/platform/engine/lib/notification-dispatcher";

// ─── Core renewal logic ──────────────────────────────────────────────────────

export interface RenewalResult {
  renewed: number;
  failed: number;
  total: number;
  details: Array<{ domain: string; status: "renewed" | "failed"; error?: string }>;
}

const managementAccessEnded = (error: unknown) =>
  error instanceof AppError && error.code === "MANAGEMENT_PLAN_REQUIRED";

/**
 * Renew all SSL certificates expiring within `SYSTEM.DOMAINS.SSL_RENEW_BEFORE_DAYS`.
 *
 * - Batched to `SYSTEM.DOMAINS.SSL_RENEW_BATCH_SIZE` per call
 * - De-duplicates project → user lookups
 * - Sends notifications on success / failure
 * - Returns a structured result for the caller to log or return to the client
 */
export async function renewExpiringCerts(): Promise<RenewalResult> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + SYSTEM.DOMAINS.SSL_RENEW_BEFORE_DAYS);

  // Domains whose TLS isn't ours to re-issue: an uploaded cert (BYO / Cloudflare
  // Origin CA) certbot never issued, an upstream ingress ACME can't reach, or a
  // managed *.opsh.io host Cloud terminates. `manageDomainSsl` refuses all three
  // anyway — filtering here keeps them out of the batch and out of the "renewed"
  // count, which is what "0 of N renewed" should mean.
  //
  // Previously only `manualSsl` was excluded. The other two escaped by luck: their
  // rows carry no `sslExpiresAt`, and findExpiringSsl compares on it — so a single
  // `updateSsl({ sslExpiresAt })` anywhere would have handed them to certbot.
  let allDomains = (await repos.domain.findExpiringSsl(cutoff)).filter(
    (d) => !tlsIssuedElsewhere(d) && d.ownerType !== MAIL_DOMAIN_OWNER,
  );
  // Server-scoped discovery domains with a MISSING or FAILED certificate: no
  // expiry exists yet, so findExpiringSsl cannot see them, and they are
  // unverified by design (ACME-as-verification). Without this retry path a
  // failed first issuance would strand the service certificate-less forever.
  // Eligibility (discovery enabled, binding observed, container running, not
  // suppressed) plus the shared verify backoff live in the query itself.
  //
  // The two queues are kept SEPARATE and fair-merged into the batch: appending
  // retries after the expiring list and truncating would let a full batch of
  // expiring domains (e.g. fifty that keep deferring on a stopped backend)
  // starve first-issuance retries forever. Round-robin interleaving gives each
  // queue ~half the batch whenever both are non-empty.
  const pendingServerIssuance = (
    await repos.domain.findPendingServerIssuance(SYSTEM.DOMAINS.SSL_RENEW_BATCH_SIZE)
  ).filter((d) => !tlsIssuedElsewhere(d) && !allDomains.some((e) => e.id === d.id));
  // Cloud mode filters each queue independently so the fair merge below keeps
  // both queues' share of the batch.
  if (env.CLOUD_MODE) {
    const { assertManagementAccess } = await import("../modules/billing/management.service");
    const allowed = async (domain: Domain): Promise<boolean> => {
      // Server-scoped discovery domains: management access resolves through the
      // SERVER row (no project exists); workspace-managed hosts bill on the
      // workspace like project-managed ones and are skipped here.
      if (domain.ownerType === "server" && domain.serverId) {
        const server = await repos.server.get(domain.serverId);
        if (!server?.organizationId || server.workspaceId) return false;
        try {
          await assertManagementAccess(server.organizationId, server.id);
        } catch (error) {
          // diagnostics-ignore: An expired allowance is not a certificate failure.
          if (managementAccessEnded(error)) return false;
          throw error;
        }
        return true;
      }
      const project = domain.projectId ? await repos.project.findById(domain.projectId) : null;
      if (!project?.serverId || project.workspaceId) return false;
      try {
        await assertManagementAccess(project.organizationId, project.serverId);
      } catch (error) {
        // diagnostics-ignore: An expired allowance is not a certificate failure. Other errors reach the job runner.
        if (managementAccessEnded(error)) return false;
        throw error;
      }
      return true;
    };
    const keep = async (domains: Domain[]) => {
      const out: Domain[] = [];
      for (const domain of domains) {
        if (await allowed(domain)) out.push(domain);
      }
      return out;
    };
    allDomains = await keep(allDomains);
    pendingServerIssuance.splice(0, pendingServerIssuance.length, ...(await keep(pendingServerIssuance)));
  }

  /** Round-robin the two queues so both make progress inside the batch cap. */
  const fairMerge = (expiring: Domain[], retries: Domain[]): Domain[] => {
    const merged: Domain[] = [];
    let i = 0;
    let j = 0;
    while (i < expiring.length || j < retries.length) {
      if (i < expiring.length) merged.push(expiring[i++]);
      if (j < retries.length) merged.push(retries[j++]);
    }
    return merged;
  };
  const allDomainsFair = fairMerge(allDomains, pendingServerIssuance);

  // Mail installs are canonical even when an older setup never registered a
  // domain row. Use their cached observations to find missing/stale certificates;
  // the shared lifecycle below still owns every ACME order and its locks.
  const mailCandidates = (env.CLOUD_MODE ? [] : await repos.mailServer.list()).filter((mail) => {
    if (!mail.installedAt || !mail.certificateAutoRenew) return false;
    const health = currentMailCertificateHealth(
      mail.certificateHealth,
      SYSTEM.DOMAINS.SSL_RENEW_BEFORE_DAYS,
    );
    return !health || health.status !== "ok" || !!mail.certificateRenewalError;
  });

  if (allDomainsFair.length === 0 && mailCandidates.length === 0) {
    return { renewed: 0, failed: 0, total: 0, details: [] };
  }

  const batch = allDomainsFair.slice(0, SYSTEM.DOMAINS.SSL_RENEW_BATCH_SIZE);

  // Pre-fetch project → (org, project name) so the dispatcher knows
  // which org to fan out the notification to. Each org's members each
  // receive notifications via their configured channels. Server-scoped
  // domains resolve the same context through their server row.
  const projectIds = [
    ...new Set(batch.map((d) => d.projectId).filter((p): p is string => p !== null)),
  ];
  const projectCache = new Map<string, { organizationId: string; projectName: string }>();
  for (const pid of projectIds) {
    const project = await repos.project.findById(pid);
    if (!project) continue;
    projectCache.set(pid, {
      organizationId: project.organizationId,
      projectName: project.name,
    });
  }
  const serverDomainCache = new Map<string, { organizationId: string; projectName: string }>();
  for (const d of batch) {
    if (d.ownerType !== "server" || !d.serverId || serverDomainCache.has(d.serverId + d.hostname)) continue;
    const server = await repos.server.get(d.serverId);
    if (!server?.organizationId) continue;
    const binding = await repos.discovery.getBindingForDomain(d.serverId, d.hostname);
    serverDomainCache.set(d.serverId + d.hostname, {
      organizationId: server.organizationId,
      projectName: binding ? `Discovered service (${binding.serviceKey})` : `Discovered service (${d.hostname})`,
    });
  }

  const details: RenewalResult["details"] = [];
  let renewed = 0;
  let failed = 0;

  for (const domain of batch) {
    const ctx = domain.projectId
      ? projectCache.get(domain.projectId)
      : domain.ownerType === "server" && domain.serverId
        ? serverDomainCache.get(domain.serverId + domain.hostname)
        : undefined;

    try {
      // manageDomainSsl resolves the provider on the serving host and persists
      // the outcome (no-clobber). A non-verified result means no valid cert
      // landed means failure. Provision reads before issuing, so another renewal
      // that already updated the disk does not open a duplicate ACME order.
      const result = await manageDomainSsl(domain.hostname, {
        action: "provision",
        projectId: domain.projectId ?? undefined,
        serverId: domain.ownerType === "server" ? (domain.serverId ?? undefined) : undefined,
        // Server domains verify THROUGH issuance (ACME-as-verification); the
        // verified flag only exists after the first success.
        allowUnverified: domain.ownerType === "server" ? true : undefined,
      });
      if (!result.verified) {
        throw new Error(
          result.reason === "missing"
            ? "no certificate present after renew"
            : "renew did not produce a valid certificate",
        );
      }

      renewed++;
      details.push({ domain: domain.hostname, status: "renewed" });

      // ssl_renewed isn't a notification category (renewal success is
      // expected — only failures are noteworthy). Skip dispatch.
    } catch (err) {
      // A deliberate stop defers the order — it is not a renewal failure: the
      // certificate, its expiry and the retry state are retained untouched, and
      // the next successful inventory + start resumes (docs).
      if (err instanceof DiscoveryBackendUnavailableError) continue;
      // The allowance can end after selection but before the host operation.
      if (managementAccessEnded(err)) continue;
      observeCaughtError(err, "platform/engine/lib/ssl-scheduler");
      failed++;
      const message = err instanceof Error ? err.message : "Unknown error";
      details.push({ domain: domain.hostname, status: "failed", error: message });

      await repos.domain.updateSsl(domain.id, { sslStatus: "error" }).catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "platform/engine/lib/ssl-scheduler");
      });

      if (ctx) {
        const daysLeft = Math.ceil(
          ((domain.sslExpiresAt?.getTime() ?? 0) - Date.now()) / 86_400_000,
        );
        notification.emit({
          organizationId: ctx.organizationId,
          eventType: "ssl.renewal_failed",
          resourceType: "domain",
          resourceId: domain.id,
          payload: {
            projectName: ctx.projectName,
            domain: domain.hostname,
            daysLeft,
            errorMessage: message,
          },
        });
      }
    }
  }

  for (const mail of mailCandidates.slice(0, SYSTEM.DOMAINS.SSL_RENEW_BATCH_SIZE)) {
    const hostname = mailHostname(mail.domain);
    try {
      const result = await renewMailCertificate(mail.serverId, true);
      if (!result) continue; // Disabled while queued, or a fresh cert was rediscovered.
      renewed++;
      details.push({ domain: hostname, status: "renewed" });
    } catch (error) {
      observeCaughtError(error, "platform/engine/lib/ssl-scheduler");
      const message = error instanceof Error ? error.message : "Mail certificate renewal failed";
      failed++;
      details.push({ domain: hostname, status: "failed", error: message });
      const owner = await resolveMailOwner(hostname).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/lib/ssl-scheduler"); return null; });
      const row = await repos.domain.findByHostname(hostname).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/lib/ssl-scheduler"); return null; });
      if (owner)
        notification.emit({
          organizationId: owner.organizationId,
          eventType: "ssl.renewal_failed",
          resourceType: "domain",
          resourceId: row?.id ?? mail.serverId,
          payload: {
            projectName: `Mail (${hostname})`,
            domain: hostname,
            daysLeft: Math.ceil(
              ((mail.certificateHealth?.certificate
                ? new Date(mail.certificateHealth.certificate.expiresAt).getTime()
                : 0) -
                Date.now()) /
                86_400_000,
            ),
            errorMessage: message,
          },
        });
    }
  }

  return { renewed, failed, total: allDomainsFair.length + mailCandidates.length, details };
}
