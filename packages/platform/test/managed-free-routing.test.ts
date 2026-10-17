import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The fork's "own domain only for hosted" rule (the *.opsh.io rows that kept
 * appearing next to users' custom domains on self-hosted):
 *
 * A SYNTHESIZED managed (free) route may only be planned when this box can
 * actually serve one — the operator's HOST_DOMAIN, or CLOUD_MODE (Cloud's
 * edge). On a self-hosted box with no HOST_DOMAIN the routing base falls back
 * to CLOUD_DOMAIN, so a synthesized free route would be a dead *.opsh.io
 * hostname: the platform's own domain, which only hosted deployments route.
 *
 * Custom domains are never gated — the user named them.
 */

const envState = vi.hoisted(() => ({ HOST_DOMAIN: "", CLOUD_MODE: false }));

vi.mock("../src/engine/config/env", () => ({
  env: envState,
}));

import {
  managedFreeRoutingAvailable,
  resolveServiceEndpointHostname,
} from "../src/engine/lib/routing-domains";
import { resolveServiceRouteHostname } from "../src/engine/lib/public-endpoints";

const project = { slug: "cronsearch", name: "cronsearch" } as never;
const service = { name: "cronsearch", kind: "compose" } as never;

beforeEach(() => {
  envState.HOST_DOMAIN = "";
  envState.CLOUD_MODE = false;
});

describe("managedFreeRoutingAvailable", () => {
  it("is false on a self-hosted box without HOST_DOMAIN (base falls back to opsh.io)", () => {
    expect(managedFreeRoutingAvailable()).toBe(false);
  });

  it("is true with an operator HOST_DOMAIN (their edge serves slug.<hostdomain>)", () => {
    envState.HOST_DOMAIN = "op.dev.kahuna.adetify.com";
    expect(managedFreeRoutingAvailable()).toBe(true);
  });

  it("is true under CLOUD_MODE (Cloud's edge serves *.opsh.io)", () => {
    envState.CLOUD_MODE = true;
    expect(managedFreeRoutingAvailable()).toBe(true);
  });
});

describe("resolveServiceEndpointHostname (free synthesis gate)", () => {
  it("plans NO free hostname next to a custom domain on a self-hosted box", () => {
    expect(
      resolveServiceEndpointHostname(
        project,
        service,
        { domainType: "free", domain: undefined, customDomain: undefined },
        true,
      ),
    ).toBeNull();
  });

  it("still routes the custom domain on a self-hosted box", () => {
    expect(
      resolveServiceEndpointHostname(
        project,
        service,
        { domainType: "custom", domain: undefined, customDomain: "app.op.dev.kahuna.adetify.com" },
        true,
      ),
    ).toBe("app.op.dev.kahuna.adetify.com");
  });

  it("synthesizes <label>.<hostdomain> when the operator set HOST_DOMAIN", () => {
    envState.HOST_DOMAIN = "op.dev.kahuna.adetify.com";
    expect(
      resolveServiceEndpointHostname(
        project,
        service,
        { domainType: "free", domain: undefined, customDomain: undefined },
        true,
      ),
    ).toBe("cronsearch-cronsearch.op.dev.kahuna.adetify.com");
  });

  it("synthesizes <label>.opsh.io under CLOUD_MODE (hosted)", () => {
    envState.CLOUD_MODE = true;
    const hostname = resolveServiceEndpointHostname(
      project,
      service,
      { domainType: "free", domain: undefined, customDomain: undefined },
      true,
    );
    expect(hostname).toMatch(/^cronsearch-cronsearch\./);
    expect(hostname).toMatch(/opsh\.io$/);
  });
});

describe("resolveServiceRouteHostname (preflight projection)", () => {
  it("projects no free hostname on a self-hosted box without HOST_DOMAIN", () => {
    expect(resolveServiceRouteHostname({ name: "web", exposed: true }, "cronsearch")).toBeNull();
  });

  it("still projects an explicit custom domain on a self-hosted box", () => {
    expect(
      resolveServiceRouteHostname(
        { name: "web", exposed: true, customDomain: "app.op.dev.kahuna.adetify.com" },
        "cronsearch",
      ),
    ).toEqual({ hostname: "app.op.dev.kahuna.adetify.com", isCustom: true, label: null });
  });

  it("projects the synthesized free hostname when HOST_DOMAIN is set", () => {
    envState.HOST_DOMAIN = "op.dev.kahuna.adetify.com";
    // "web" is a shortcut name → the bare project label (no <project>- prefix).
    expect(resolveServiceRouteHostname({ name: "web", exposed: true }, "cronsearch")).toEqual({
      hostname: "cronsearch.op.dev.kahuna.adetify.com",
      isCustom: false,
      label: "cronsearch",
    });
    // Any other service name namespaces under the project.
    expect(resolveServiceRouteHostname({ name: "api", exposed: true }, "cronsearch")).toEqual({
      hostname: "cronsearch-api.op.dev.kahuna.adetify.com",
      isCustom: false,
      label: "cronsearch-api",
    });
  });
});
