// @vitest-environment happy-dom
/**
 * The per-service "Configure TLS" drawer — save vs ensure semantics, provider
 * -specific form fields, saved-credential selection, permission and preflight
 * failures, duplicate-submission guarding, and the read-only declaration
 * state (wildcard source, addressing). Real component + i18n copy; only the
 * network, router-adjacent identity and credential catalogue are mocked.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/components/i18n-provider";
import { ToastProvider } from "@/components/toast";
import { ModalProvider } from "@/context/ModalContext";
import { ApiError } from "@/lib/api/client";
import { ServiceTlsDrawer } from "./service-tls-drawer";
import type { DiscoveryService } from "@/lib/api";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const discoveryApi = vi.hoisted(() => ({
  serviceTls: vi.fn(),
  configureServiceTls: vi.fn(),
  ensureTls: vi.fn(),
}));
const credentialsApi = vi.hoisted(() => ({
  providers: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return { ...original, discoveryApi };
});
vi.mock("@/lib/api/credentials", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api/credentials")>();
  return { ...original, credentialsApi };
});
// The scoped-resource hook's identity inputs, fixed for determinism.
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: { user: { id: "user_1" }, session: { activeOrganizationId: "" } },
  }),
}));
vi.mock("@/context/CloudResourceContext", () => ({
  useCloudResourceKey: () => "local",
  useCloudResourceReady: () => true,
}));

const TEXT = (node: { textContent: string | null }) =>
  (node.textContent ?? "").replace(/\s+/g, " ");
const BUTTON = (match: (label: string) => boolean): HTMLButtonElement | undefined =>
  Array.from(document.querySelectorAll("button")).find((b) => match(b.textContent ?? ""));

function service(over: Partial<DiscoveryService> = {}): DiscoveryService {
  return {
    id: "dsb_1",
    serviceKey: "id:my-app",
    composeProject: "web",
    composeService: "app",
    hostname: "app.example.com",
    port: 3000,
    networkName: "web_default",
    observationStatus: "observed",
    containerName: "my-app",
    containerRunning: true,
    upstreamStrategy: "published-port",
    ipAddress: null,
    hostPort: "8080",
    applyState: "applied",
    applyError: null,
    applyAttempts: 0,
    nextApplyAt: null,
    withdrawalPending: false,
    suppressed: false,
    desiredGeneration: 2,
    appliedGeneration: 2,
    updatedAt: "2026-01-01T00:00:00.000Z",
    tls: {
      hostname: "app.example.com",
      verified: true,
      sslStatus: "active",
      sslExpiresAt: "2027-02-19T00:00:00.000Z",
      sslIssuer: "CloudFlare, Inc. Origin CA",
    },
    tlsOperation: null,
    ...over,
  };
}

/** One saved Cloudflare credential by NAME — the token never enters the UI. */
const CF_CREDENTIAL = {
  id: "cred_cf",
  provider: "cloudflare",
  providerLabel: "Cloudflare",
  name: "zone token",
  selector: null,
  publicFields: {},
  secretsMasked: { apiToken: "••••••••" },
  status: "active",
  lastVerifiedAt: null,
  lastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function letsEncryptPolicy(over: Record<string, unknown> = {}) {
  return {
    hostname: "app.example.com",
    provider: "letsencrypt",
    activeProvider: null,
    selectionSource: "default",
    state: "pending",
    cloudflare: null,
    error: null,
    ...over,
  };
}

function cloudflarePolicy(over: Record<string, unknown> = {}) {
  return {
    hostname: "app.example.com",
    provider: "cloudflare-origin-ca",
    activeProvider: "cloudflare-origin-ca",
    selectionSource: "explicit",
    state: "active",
    cloudflare: {
      credentialId: "cred_cf",
      zoneId: "zone_1",
      zoneName: "example.com",
      validityDays: 90,
    },
    error: null,
    ...over,
  };
}

function mount(ui: React.ReactElement): { root: Root; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <I18nProvider>
        <ToastProvider>
          <ModalProvider>{ui}</ModalProvider>
        </ToastProvider>
      </I18nProvider>,
    );
  });
  return { root, host };
}

const drawer = (srv: DiscoveryService, onClose = () => {}, onChanged = () => {}) => (
  <ServiceTlsDrawer serverId="srv_1" service={srv} onClose={onClose} onChanged={onChanged} />
);

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  discoveryApi.serviceTls.mockResolvedValue(letsEncryptPolicy());
  discoveryApi.configureServiceTls.mockResolvedValue(
    letsEncryptPolicy({ selectionSource: "explicit" }),
  );
  discoveryApi.ensureTls.mockResolvedValue({
    outcome: "queued",
    hostname: "app.example.com",
    operationId: "dtop_x",
  });
  credentialsApi.providers.mockResolvedValue({ data: [{ id: "cloudflare", name: "Cloudflare" }] });
  credentialsApi.list.mockResolvedValue({
    data: [
      CF_CREDENTIAL,
      { ...CF_CREDENTIAL, id: "cred_ghcr", provider: "docker-registry", name: "ghcr" },
    ],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ServiceTlsDrawer", () => {
  it("loads the policy for the service's stable identity (one URL segment — the api encodes it)", async () => {
    const composeService = service({ serviceKey: "compose:web/app" });
    const { root } = mount(drawer(composeService));
    await act(async () => {});
    expect(discoveryApi.serviceTls).toHaveBeenCalledWith("srv_1", "compose:web/app");
    root.unmount();
  });

  it("renders the read-only declaration state: wildcard source, provenance, addressing", async () => {
    discoveryApi.serviceTls.mockResolvedValue(letsEncryptPolicy({ selectionSource: "explicit" }));
    const srv = service({
      tlsDeclaredWildcard: "*.example.com",
      tlsPolicyConflict: "tls-policy-conflict: provider mismatch",
    });
    const { root } = mount(drawer(srv));
    await act(async () => {});
    const text = TEXT(document.body);
    expect(text).toContain("Shared wildcard *.example.com");
    // Read-only explanation names the controlling declaration.
    expect(text).toContain("openship.tls.wildcard");
    expect(text).toContain("Set explicitly for this domain");
    expect(text).toContain("tls-policy-conflict: provider mismatch");
    // Addressing is displayed read-only, ports and network separate.
    expect(text).toContain("Container port");
    expect(text).toContain(":3000");
    expect(text).toContain("Published host port");
    expect(text).toContain(":8080");
    expect(text).toContain("Network");
    expect(text).toContain("web_default");
    expect(text).toContain("openship.port");
    root.unmount();
  });

  it("shows Let's Encrypt fields only — no credential, zone, or validity inputs", async () => {
    const { root } = mount(drawer(service()));
    await act(async () => {});
    const text = TEXT(document.body);
    expect(text).not.toContain("Cloudflare credential");
    expect(text).not.toContain("Zone ID");
    expect(text).not.toContain("Validity period");
    root.unmount();
  });

  it("shows Cloudflare fields seeded from the policy, and credentials by NAME only", async () => {
    discoveryApi.serviceTls.mockResolvedValue(cloudflarePolicy());
    const { root } = mount(drawer(service()));
    await act(async () => {});
    expect(credentialsApi.list).toHaveBeenCalled(); // the saved-credential read
    const text = TEXT(document.body);
    expect(text).toContain("Cloudflare credential");
    expect(text).toContain("zone token"); // the credential NAME, never its id or token
    expect(text).not.toContain("cred_cf");
    expect(text).toContain("Zone ID");
    expect(text).toContain("90 days"); // the seeded validity
    // Origin CA coverage stays distinct from browser-facing TLS.
    expect(text).toContain("never by browsers connecting directly");
    root.unmount();
  });

  it("SAVE persists the policy only — it never calls ensure, and its note says so", async () => {
    const { root } = mount(drawer(service()));
    await act(async () => {});
    const save = BUTTON((label) => label.includes("Save configuration"));
    await act(async () => {
      save!.click();
    });
    expect(discoveryApi.configureServiceTls).toHaveBeenCalledTimes(1);
    expect(discoveryApi.configureServiceTls).toHaveBeenCalledWith("srv_1", "id:my-app", {
      provider: "letsencrypt",
    });
    expect(discoveryApi.ensureTls).not.toHaveBeenCalled(); // saving is not issuance
    expect(TEXT(document.body)).toContain("stores the policy only");
    root.unmount();
  });

  it("a Cloudflare save sends the selected credential/zone/validity from the form", async () => {
    discoveryApi.serviceTls.mockResolvedValue(cloudflarePolicy());
    const { root } = mount(drawer(service()));
    await act(async () => {});
    const save = BUTTON((label) => label.includes("Save configuration"));
    await act(async () => {
      save!.click();
    });
    expect(discoveryApi.configureServiceTls).toHaveBeenCalledWith("srv_1", "id:my-app", {
      provider: "cloudflare-origin-ca",
      cloudflare: { credentialId: "cred_cf", zoneId: "zone_1", validityDays: 90 },
    });
    root.unmount();
  });

  it("a PREFLIGHT failure shows inline, keeps the user's input, and never queues work", async () => {
    discoveryApi.serviceTls.mockResolvedValue(cloudflarePolicy());
    discoveryApi.configureServiceTls.mockRejectedValueOnce(
      new ApiError(409, "Conflict", { error: "The zone is not proxied with Full (strict)." }),
    );
    const { root } = mount(drawer(service()));
    await act(async () => {});
    // The operator edits the zone id before saving (React's tracked input
    // needs the native value setter for the change to register).
    const zone = document.querySelector<HTMLInputElement>('input[placeholder^="b2f04038"]');
    expect(zone).not.toBeNull();
    const zoneInput = zone!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(zoneInput, "zone_edited");
      zoneInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = BUTTON((label) => label.includes("Save configuration"));
    await act(async () => {
      save!.click();
    });
    await act(async () => {});
    const text = TEXT(document.body);
    expect(text).toContain("The zone is not proxied with Full (strict).");
    expect(zoneInput.value).toBe("zone_edited"); // retained — not cleared, not reset
    expect(discoveryApi.ensureTls).not.toHaveBeenCalled(); // a failed save never "falls through" to issuance
    root.unmount();
  });

  it("a PERMISSION failure shows the permission copy, not the raw error", async () => {
    discoveryApi.configureServiceTls.mockRejectedValueOnce(
      new ApiError(403, "Forbidden", { error: "server admin required" }),
    );
    const { root } = mount(drawer(service()));
    await act(async () => {});
    const save = BUTTON((label) => label.includes("Save configuration"));
    await act(async () => {
      save!.click();
    });
    await act(async () => {});
    const text = TEXT(document.body);
    expect(text).toContain("You don't have permission for this action.");
    expect(text).not.toContain("server admin required");
    root.unmount();
  });

  it("duplicate submissions are impossible while a write is in flight", async () => {
    let release: (() => void) | null = null;
    discoveryApi.ensureTls.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ outcome: "queued", hostname: "app.example.com", operationId: "dtop_x" });
        }),
    );
    const { root } = mount(drawer(service()));
    await act(async () => {});
    const ensure = BUTTON((label) => label.includes("Ensure certificate"));
    await act(async () => {
      ensure!.click();
    });
    // In flight: the action is disabled, and a second click cannot land.
    expect(ensure!.disabled).toBe(true);
    ensure!.click();
    await act(async () => {});
    expect(discoveryApi.ensureTls).toHaveBeenCalledTimes(1);
    await act(async () => {
      release!();
    });
    root.unmount();
  });

  it("ENSURE is a separate explicit action and reports each outcome honestly", async () => {
    const { root } = mount(drawer(service()));
    await act(async () => {});
    const ensure = BUTTON((label) => label.includes("Ensure certificate"));
    await act(async () => {
      ensure!.click();
    });
    expect(discoveryApi.ensureTls).toHaveBeenCalledWith("srv_1", "id:my-app");
    expect(discoveryApi.configureServiceTls).not.toHaveBeenCalled();
    expect(TEXT(document.body)).toContain("Certificate work queued.");

    // Skipped: already valid — the honest no-op outcome.
    discoveryApi.ensureTls.mockResolvedValueOnce({
      outcome: "skipped",
      reason: "already_valid",
      hostname: "app.example.com",
      source: "exact",
    });
    await act(async () => {
      BUTTON((label) => label.includes("Ensure certificate"))!.click();
    });
    expect(TEXT(document.body)).toContain("Already valid");

    // Deferred: the durable reason is surfaced, never invented as success.
    discoveryApi.ensureTls.mockResolvedValueOnce({
      outcome: "deferred",
      hostname: "app.example.com",
      operationId: "dtop_x",
      reason: "The discovered backend is not running",
    });
    await act(async () => {
      BUTTON((label) => label.includes("Ensure certificate"))!.click();
    });
    expect(TEXT(document.body)).toContain("Deferred: The discovered backend is not running");
    root.unmount();
  });

  it("the action reads RETRY while a durable operation is active, and shows its state and reason", async () => {
    const srv = service({
      tlsOperation: {
        operationId: "dtop_9",
        state: "deferred",
        source: "exact",
        provider: "letsencrypt",
        reason:
          "The discovered backend is not running; certificate work waits for a running backend.",
        attempts: 2,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      containerRunning: false,
    });
    const { root } = mount(drawer(srv));
    await act(async () => {});
    const text = TEXT(document.body);
    expect(text).toContain("Retry certificate work"); // state-dependent label
    expect(text).toContain("waiting"); // the durable operation state
    expect(text).toContain("certificate work waits for a running backend");
    expect(text).toContain("The container is not running"); // the stopped-backend explanation
    root.unmount();
  });

  it("displays desired versus installed provider during a transition, plus expiry", async () => {
    // Policy flipped to Cloudflare while Let's Encrypt material still serves.
    discoveryApi.serviceTls.mockResolvedValue(
      cloudflarePolicy({ activeProvider: "letsencrypt", state: "pending" }),
    );
    const { root } = mount(drawer(service()));
    await act(async () => {});
    const text = TEXT(document.body);
    expect(text).toContain("Installed provider");
    expect(text).toContain("Moving to Cloudflare Origin CA");
    expect(text).toContain("keeps serving until the new one is installed");
    expect(text).toContain("Certificate expiry");
    root.unmount();
  });

  it("explains that Let's Encrypt wildcard issuance is unsupported while a wildcard is declared", async () => {
    const srv = service({ tlsDeclaredWildcard: "*.example.com" });
    const { root } = mount(drawer(srv));
    await act(async () => {});
    const text = TEXT(document.body);
    expect(text).toContain(
      "Wildcard issuance through Let's Encrypt (DNS-01) is not implemented yet",
    );
    expect(text).toContain("choose Cloudflare Origin CA for wildcards today");
    root.unmount();
  });

  it("explains a configuration_required policy: the missing Cloudflare configuration blocks work", async () => {
    // Desired Cloudflare without a saved credential/zone: the policy view's
    // own state, surfaced as the explanation (the form below is the fix).
    discoveryApi.serviceTls.mockResolvedValue(
      cloudflarePolicy({
        activeProvider: null,
        state: "configuration_required",
        cloudflare: null,
      }),
    );
    const { root } = mount(drawer(service()));
    await act(async () => {});
    const text = TEXT(document.body);
    expect(text).toContain("Cloudflare Origin CA needs a saved credential and a zone");
    root.unmount();
  });

  it("a FAILED policy load degrades to an inline error with retry — never to a silent empty form", async () => {
    discoveryApi.serviceTls.mockRejectedValueOnce(
      new ApiError(502, "Bad Gateway", { error: "The server returned an invalid response." }),
    );
    const { root } = mount(drawer(service()));
    await act(async () => {});
    const text = TEXT(document.body);
    expect(text).toContain("The TLS policy could not be loaded.");
    expect(text).toContain("Retry");
    // No actions are offered on unknown state.
    expect(BUTTON((label) => label.includes("Save configuration"))).toBeUndefined();
    root.unmount();
  });

  it("close is guarded while a write is in flight, and the policy reloads after mutations", async () => {
    let release: (() => void) | null = null;
    discoveryApi.ensureTls.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ outcome: "queued", hostname: "app.example.com", operationId: "dtop_x" });
        }),
    );
    const onClose = vi.fn();
    const { root } = mount(drawer(service(), onClose));
    await act(async () => {});
    expect(discoveryApi.serviceTls).toHaveBeenCalledTimes(1);
    const ensure = BUTTON((label) => label.includes("Ensure certificate"));
    await act(async () => {
      ensure!.click();
    });
    // In flight: the drawer's own close control is disabled (guarded), and a
    // close request is refused rather than dropping the pending outcome.
    const close = document.querySelector('button[aria-label="Close panel"]') as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    await act(async () => {
      release!();
    });
    await act(async () => {});
    // After the mutation the policy re-reads so the form follows saved state.
    expect(discoveryApi.serviceTls).toHaveBeenCalledTimes(2);
    root.unmount();
  });
});
