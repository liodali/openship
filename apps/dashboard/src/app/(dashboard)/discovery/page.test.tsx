// @vitest-environment happy-dom
/**
 * The dedicated /discovery page — the rail's Discovery entry.
 *
 * Under test, against the REAL page, REAL scoped-resource hook and i18n copy
 * with only the network, router and Better Auth session mocked:
 *   - the URL owns the selection: `?server=<id>` deep links, selector switches
 *     write the URL, and a param-less landing adopts the first server,
 *   - a deep link to an INACCESSIBLE server renders the not-available notice
 *     and never fetches that server's discovery status,
 *   - managed (cloud-workspace) rows never enter the selector,
 *   - list failures degrade to a readable error with Retry, and a workspace
 *     with no servers offers the Add-server path,
 *   - switching servers remounts the card (keyed by server id), so a pending
 *     read for the previous server can never land in the new one,
 *   - an account/workspace scope change refetches the list under the new
 *     scope and remounts the card (keyed by scope AND server id), so a
 *     status read from one account can never survive into the next.
 */
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { ToastProvider } from "@/components/toast";
import { ModalProvider } from "@/context/ModalContext";
import { baseDictionary } from "@/i18n";
import { setActiveOrganizationId } from "@/lib/api/client";
import type { ServerInfo } from "@/lib/api/system";
import Page from "./page";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  search: "",
  /** The test harness subscribes: router.replace mutates `search` and re-renders. */
  onNavigate: null as (() => void) | null,
  userId: "user_a",
  replace: vi.fn(),
  listServers: vi.fn(),
  status: vi.fn(),
  /** The card's server-default TLS row (loads once per server). */
  tlsSettings: vi.fn(),
  configureTlsSettings: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: (url: string, opts?: unknown) => {
      h.replace(url, opts);
      h.search = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
      h.onNavigate?.();
    },
    push: vi.fn(),
  }),
  usePathname: () => "/discovery",
  useSearchParams: () => new URLSearchParams(h.search),
}));

// Better Auth's React client opens real auth traffic; the scoped-resource hook
// only needs the session identity. The active WORKSPACE comes from the real
// org store (`@/lib/api/client`), which is what an account switch mutates.
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: { user: { id: h.userId }, session: { activeOrganizationId: "" } },
  }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    systemApi: { ...original.systemApi, listServers: h.listServers },
    // tlsSettings is mocked too: the card's server-default row loads it once,
    // and a real read would hit the network from the test environment.
    discoveryApi: {
      ...original.discoveryApi,
      status: h.status,
      tlsSettings: h.tlsSettings,
      configureTlsSettings: h.configureTlsSettings,
    },
  };
});

function server(over: Partial<ServerInfo> = {}): ServerInfo {
  return {
    id: "srv_1",
    name: "Web server",
    isLocal: false,
    sshHost: "web.example.com",
    sshPort: 22,
    sshUser: "root",
    sshAuthMethod: null,
    sshKeyPath: null,
    hasStoredKeyMaterial: true,
    sshJumpHost: null,
    sshArgs: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    country: null,
    sshTransport: "direct" as const,
    projectCount: 0,
    hostChannel: null,
    ...over,
  } as ServerInfo;
}

/** A minimal valid DiscoveryStatus payload for the card's status read. */
function discoveryStatus(serverId: string, hostname?: string) {
  return {
    settings: {
      serverId,
      enabled: true,
      workspaceId: null,
      sweepIntervalSeconds: 60,
      lastScanAt: null,
      lastScanError: null,
    },
    services: hostname
      ? [
          {
            id: `dsb_${serverId}`,
            serviceKey: `id:${hostname}`,
            composeProject: null,
            composeService: null,
            hostname,
            port: 3000,
            networkName: null,
            observationStatus: "observed",
            containerName: hostname,
            containerRunning: true,
            upstreamStrategy: "network-ip",
            ipAddress: "172.20.0.5",
            hostPort: null,
            applyState: "applied",
            applyError: null,
            applyAttempts: 0,
            nextApplyAt: null,
            withdrawalPending: false,
            suppressed: false,
            desiredGeneration: 1,
            appliedGeneration: 1,
            updatedAt: "2026-01-01T00:00:00.000Z",
            tls: null,
          },
        ]
      : [],
  };
}

/** Same element position across navigations — replace() re-renders in place,
 *  exactly what a client-side router does to a page component. */
function TestApp() {
  const [, setTick] = useState(0);
  useEffect(() => {
    h.onNavigate = () => setTick((t) => t + 1);
    return () => {
      h.onNavigate = null;
    };
  }, []);
  return <Page />;
}

let root: Root;
let host: HTMLElement;

function mount(): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root.render(
      <I18nProvider initialLocale="en" initialDictionary={baseDictionary}>
        <ToastProvider>
          <ModalProvider>
            <TestApp />
          </ModalProvider>
        </ToastProvider>
      </I18nProvider>,
    );
  });
}

const TEXT = () => (document.body.textContent ?? "").replace(/\s+/g, " ");

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  h.search = "";
  h.onNavigate = null;
  // The org store is module-global and persists across tests in this file.
  setActiveOrganizationId("org_a");
  h.listServers.mockResolvedValue([
    server(),
    server({ id: "srv_2", name: "DB server", sshHost: "db.example.com" }),
  ]);
  h.status.mockImplementation((serverId: string) => Promise.resolve(discoveryStatus(serverId)));
  h.tlsSettings.mockResolvedValue({ defaultProvider: "letsencrypt" });
  h.configureTlsSettings.mockImplementation(
    async (_serverId: string, input: { defaultProvider: string }) => input,
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("/discovery", () => {
  it("lands on the first accessible server and writes the deep link into the URL", async () => {
    mount();
    await act(async () => {});
    expect(h.status.mock.calls.map((call) => call[0])).toContain("srv_1");
    expect(h.replace).toHaveBeenCalledWith("/discovery?server=srv_1", { scroll: false });
    const trigger = document.querySelector('button[aria-label="Server"]') as HTMLButtonElement;
    expect(trigger.textContent).toContain("Web server");
  });

  it("resolves a ?server= deep link to that server", async () => {
    h.search = "server=srv_2";
    mount();
    await act(async () => {});
    expect(h.status.mock.calls.map((call) => call[0])).toContain("srv_2");
    // The URL is already scoped — no auto-select write on top of it.
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("renders the not-available notice for an inaccessible deep-linked server and reads nothing", async () => {
    h.search = "server=srv_gone";
    mount();
    await act(async () => {});
    expect(h.status).not.toHaveBeenCalled();
    expect(TEXT()).toContain("This server isn't available here");
    // The selector is still live for a manual pick.
    expect(document.querySelector('button[aria-label="Server"]')).not.toBeNull();
  });

  it("switches servers through the selector, updating the URL and remounting the card", async () => {
    h.search = "server=srv_1";
    // A pending read for srv_1 that resolves only AFTER the switch.
    let releaseStale: ((v: unknown) => void) | null = null;
    h.status.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseStale = resolve;
        }),
    );
    mount();
    await act(async () => {});
    expect(h.status.mock.calls.map((call) => call[0])).toContain("srv_1");

    const trigger = document.querySelector('button[aria-label="Server"]') as HTMLButtonElement;
    await act(async () => trigger.click());
    const option = Array.from(document.querySelectorAll("button[role='option']")).find((node) =>
      node.textContent?.includes("DB server"),
    ) as HTMLButtonElement;
    await act(async () => option.click());

    expect(h.replace).toHaveBeenLastCalledWith("/discovery?server=srv_2", { scroll: false });
    // The keyed remount fires a fresh read for the new server…
    expect(h.status.mock.calls.at(-1)![0]).toBe("srv_2");

    // …and the stale srv_1 answer, landing after the switch, must not leak
    // into srv_2's card.
    await act(async () => {
      releaseStale?.(discoveryStatus("srv_1", "old-srv1-host.example.com"));
    });
    expect(TEXT()).not.toContain("old-srv1-host.example.com");
  });

  it("an account/workspace scope change refetches the list and remounts the card, dropping the previous scope's status read", async () => {
    // The interesting case: the SAME server id is visible from both scopes
    // (a server can be shared across workspaces), so only the scope half of
    // the card key can distinguish the old account's state.
    h.search = "server=srv_shared";
    h.listServers.mockResolvedValue([server({ id: "srv_shared", name: "Web server" })]);

    // The first scope's status read hangs — it must never land anywhere.
    let releaseStale: ((v: unknown) => void) | null = null;
    h.status
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseStale = resolve;
          }),
      )
      .mockImplementation((serverId: string) =>
        Promise.resolve(discoveryStatus(serverId, "fresh-scope-host.example.com")),
      );

    mount();
    await act(async () => {});
    expect(h.status.mock.calls.map((call) => call[0])).toEqual(["srv_shared"]);

    // Another tab switches the workspace — NO page reload, the org store
    // notifies in place, exactly the stale-data vector this guards against.
    await act(async () => setActiveOrganizationId("org_b"));
    await act(async () => {});
    // The list refetched under the new scope, and the card REMOUNTED (scope is
    // part of its key) → a fresh status read for the shared server.
    expect(h.listServers).toHaveBeenCalledTimes(2);
    expect(h.status.mock.calls.at(-1)![0]).toBe("srv_shared");

    // The stale first-scope answer lands last and must be discarded.
    await act(async () => {
      releaseStale?.(discoveryStatus("srv_shared", "stale-scope-host.example.com"));
    });
    const text = TEXT();
    expect(text).not.toContain("stale-scope-host.example.com");
    expect(text).toContain("fresh-scope-host.example.com");
  });

  it("a scope change that loses the deep-linked server shows the not-available notice, not the old card", async () => {
    h.search = "server=srv_1";
    h.listServers.mockResolvedValueOnce([server()]).mockResolvedValue([]);
    mount();
    await act(async () => {});
    const statusCallsBefore = h.status.mock.calls.length;
    expect(statusCallsBefore).toBeGreaterThan(0);

    await act(async () => setActiveOrganizationId("org_b"));
    await act(async () => {});
    expect(h.listServers).toHaveBeenCalledTimes(2);
    expect(TEXT()).toContain("This server isn't available here");
    // No status read for a server the new scope cannot see.
    expect(h.status.mock.calls.length).toBe(statusCallsBefore);
  });

  it("keeps managed (cloud) servers out of the selector", async () => {
    h.listServers.mockResolvedValue([
      server(),
      server({
        id: "srv_managed",
        name: "Cloud space",
        managed: { id: "ws_1" } as ServerInfo["managed"],
      }),
    ]);
    mount();
    await act(async () => {});
    const trigger = document.querySelector('button[aria-label="Server"]') as HTMLButtonElement;
    await act(async () => trigger.click());
    const text = document.body.textContent ?? "";
    expect(text).toContain("Web server");
    expect(text).not.toContain("Cloud space");
  });

  it("degrades a failed server list to an error with Retry, and the retry reloads", async () => {
    h.listServers.mockRejectedValue(new Error("network down"));
    mount();
    await act(async () => {});
    expect(TEXT()).toContain("network down");
    expect(h.status).not.toHaveBeenCalled();

    const retry = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Retry"),
    );
    h.listServers.mockResolvedValue([server()]);
    await act(async () => retry!.click());
    await act(async () => {});
    expect(h.status.mock.calls.map((call) => call[0])).toContain("srv_1");
  });

  it("offers the Add-server path when no accessible server exists", async () => {
    h.listServers.mockResolvedValue([]);
    mount();
    await act(async () => {});
    expect(h.status).not.toHaveBeenCalled();
    expect(TEXT()).toContain("No servers yet");
    const cta = document.querySelector<HTMLAnchorElement>('a[href="/servers/new"]');
    expect(cta).not.toBeNull();
    expect(cta!.textContent).toContain("Add a server");
  });

  it("shows skeletons while the list loads, not the card of a guessed server", async () => {
    let release: ((v: ServerInfo[]) => void) | null = null;
    h.listServers.mockImplementation(
      () =>
        new Promise<ServerInfo[]>((resolve) => {
          release = resolve;
        }),
    );
    mount();
    await act(async () => {});
    expect(h.status).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => release!([server()]));
    await act(async () => {});
    expect(h.status.mock.calls.map((call) => call[0])).toContain("srv_1");
  });
});
