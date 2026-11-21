import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { parseInput, DiscoveryTlsEnsureInputSchema } from "@repo/contracts";
import { operationContext, operationData } from "../../lib/operation-context";
import { param } from "../../lib/controller-helpers";

/** The discovery operations for the (frozen) platform kernel. */
const operations = () => getPlatformKernel().discovery;

export async function getDiscovery(c: Context) {
  return c.json(await operationData(c, operations().status(operationContext(c), param(c, "id"))));
}

/** The service key arrives URL-encoded in the path (`id:my-app`, `compose:proj/serv`). */
export async function getDiscoveryService(c: Context) {
  return c.json(await operationData(c, operations().getService(operationContext(c), param(c, "id"), { serviceKey: param(c, "serviceKey") })));
}

export async function configureDiscovery(c: Context) {
  return c.json(
    await operationData(c, operations().configure(operationContext(c), param(c, "id"), await c.req.json())),
  );
}

export async function rescanDiscovery(c: Context) {
  return c.json(await operationData(c, operations().rescan(operationContext(c), param(c, "id"))));
}

/** The service key arrives URL-encoded in the path; the HTTP body is EMPTY
 *  ({} — the contract rejects anything else; identity is the service key). */
export async function ensureDiscoveryServiceTls(c: Context) {
  parseInput(DiscoveryTlsEnsureInputSchema, await c.req.json().catch(() => ({})));
  const data = await operationData(
    c,
    operations().ensureServiceTls(operationContext(c), param(c, "id"), { serviceKey: param(c, "serviceKey") }),
  );
  // skipped = nothing to do (200); queued/already_queued/deferred = accepted
  // asynchronous work (202). The response body always carries the outcome.
  return c.json(data, data.outcome === "skipped" ? 200 : 202);
}

/** Server managed TLS defaults (the default provider for NEW enrollments). */
export async function getServerTlsSettings(c: Context) {
  return c.json(await operationData(c, operations().getServerTlsSettings(operationContext(c), param(c, "id"))));
}

export async function configureServerTls(c: Context) {
  return c.json(await operationData(c, operations().configureServerTls(operationContext(c), param(c, "id"), await c.req.json())));
}

/** Per-domain managed TLS policy (the service key arrives URL-encoded). */
export async function getServiceTls(c: Context) {
  return c.json(await operationData(c, operations().getServiceTls(operationContext(c), param(c, "id"), { serviceKey: param(c, "serviceKey") })));
}

export async function setServiceTls(c: Context) {
  return c.json(
    await operationData(
      c,
      operations().setServiceTls(operationContext(c), param(c, "id"), {
        serviceKey: param(c, "serviceKey"),
        ...(await c.req.json()),
      }),
    ),
  );
}

/** The service key arrives URL-encoded in the path (`id:my-app`). */
export async function suppressDiscoveryService(c: Context) {
  return c.json(await operationData(c, operations().suppress(operationContext(c), param(c, "id"), { serviceKey: param(c, "serviceKey") })));
}

export async function unsuppressDiscoveryService(c: Context) {
  return c.json(await operationData(c, operations().unsuppress(operationContext(c), param(c, "id"), { serviceKey: param(c, "serviceKey") })));
}

export async function forgetDiscoveryService(c: Context) {
  return c.json(await operationData(c, operations().forget(operationContext(c), param(c, "id"), { serviceKey: param(c, "serviceKey") })));
}
