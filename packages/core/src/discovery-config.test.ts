import { describe, expect, it } from "vitest";
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_SERVICE_LABEL,
  DISCOVERY_ENV,
  DISCOVERY_LABEL,
  discoveryConfigHash,
  findDuplicateDiscoveryIdentities,
  isUsableDiscoveryNetwork,
  parseDiscoveryDeclaration,
  type DiscoveryCandidateInput,
  type DiscoveryParseResult,
} from "./discovery-config";

function candidate(overrides: Partial<DiscoveryCandidateInput> = {}): DiscoveryCandidateInput {
  return {
    env: [
      `${DISCOVERY_ENV.discovery}=true`,
      `${DISCOVERY_ENV.serviceId}=my-app`,
      `${DISCOVERY_ENV.domain}=app.example.com`,
      `${DISCOVERY_ENV.port}=3000`,
    ],
    labels: {},
    networks: [{ name: "frontend", driver: "bridge", id: "net_frontend" }],
    ...overrides,
  };
}

function declarationOf(result: DiscoveryParseResult) {
  if (!result.eligible) throw new Error(`expected eligible, got ${JSON.stringify(result.rejection)}`);
  return result.declaration;
}

function rejectionOf(result: DiscoveryParseResult) {
  if (result.eligible) throw new Error(`expected rejection, got ${JSON.stringify(result.declaration)}`);
  return result.rejection;
}

describe("discovery opt-in flag", () => {
  it("treats absent flag as undiscovered", () => {
    const result = parseDiscoveryDeclaration({ env: [`${DISCOVERY_ENV.domain}=app.example.com`] });
    expect(rejectionOf(result)).toEqual({ kind: "not-opted-in" });
  });

  it("treats false and 0 (any case) as undiscovered", () => {
    for (const value of ["false", "FALSE", "False", "0", ""]) {
      const result = parseDiscoveryDeclaration(candidate({ env: [`${DISCOVERY_ENV.discovery}=${value}`] }));
      expect(rejectionOf(result)).toEqual({ kind: "not-opted-in" });
    }
  });

  it("accepts true and 1 via env or label", () => {
    const fromEnv = declarationOf(parseDiscoveryDeclaration(candidate()));
    expect(fromEnv.hostname).toBe("app.example.com");
    const fromLabel = declarationOf(
      parseDiscoveryDeclaration(
        candidate({
          env: [
            `${DISCOVERY_ENV.serviceId}=my-app`,
            `${DISCOVERY_ENV.domain}=app.example.com`,
            `${DISCOVERY_ENV.port}=3000`,
          ],
          labels: { [DISCOVERY_LABEL.discovery]: "TRUE" },
        }),
      ),
    );
    expect(fromLabel.hostname).toBe("app.example.com");
    const fromOne = declarationOf(
      parseDiscoveryDeclaration(
        candidate({
          env: [
            `${DISCOVERY_ENV.discovery}=1`,
            `${DISCOVERY_ENV.serviceId}=my-app`,
            `${DISCOVERY_ENV.domain}=app.example.com`,
            `${DISCOVERY_ENV.port}=3000`,
          ],
        }),
      ),
    );
    expect(fromOne.port).toBe(3000);
  });

  it("rejects a non-boolean flag value", () => {
    const rejection = rejectionOf(parseDiscoveryDeclaration(candidate({ env: [`${DISCOVERY_ENV.discovery}=yes`] })));
    expect(rejection).toMatchObject({ kind: "invalid", code: "invalid-discovery-flag" });
  });
});

describe("env/label conflicts", () => {
  it("rejects overlapping env and label values that disagree", () => {
    const rejection = rejectionOf(
      parseDiscoveryDeclaration(
        candidate({ labels: { [DISCOVERY_LABEL.domain]: "other.example.com" } }),
      ),
    );
    expect(rejection).toMatchObject({ kind: "invalid", code: "conflict" });
    expect((rejection as { message: string }).message).toContain(DISCOVERY_LABEL.domain);
  });

  it("rejects conflicting ports", () => {
    const rejection = rejectionOf(
      parseDiscoveryDeclaration(candidate({ labels: { [DISCOVERY_LABEL.port]: "8080" } })),
    );
    expect(rejection).toMatchObject({ kind: "invalid", code: "conflict" });
  });

  it("accepts overlapping values that agree", () => {
    const declaration = declarationOf(
      parseDiscoveryDeclaration(
        candidate({
          labels: {
            [DISCOVERY_LABEL.domain]: "app.example.com",
            [DISCOVERY_LABEL.port]: "3000",
            [DISCOVERY_LABEL.serviceId]: "my-app",
          },
        }),
      ),
    );
    expect(declaration.hostname).toBe("app.example.com");
  });

  it("uses the label alone when env omits the field", () => {
    const declaration = declarationOf(
      parseDiscoveryDeclaration(
        candidate({
          env: [`${DISCOVERY_ENV.discovery}=true`],
          labels: {
            [DISCOVERY_LABEL.serviceId]: "label-app",
            [DISCOVERY_LABEL.domain]: "label.example.com",
            [DISCOVERY_LABEL.port]: "80",
          },
        }),
      ),
    );
    expect(declaration.hostname).toBe("label.example.com");
    expect(declaration.port).toBe(80);
  });

  it("ignores empty-string values as unset", () => {
    // Empty env domain is unset; the label supplies the value — no conflict.
    const declaration = declarationOf(
      parseDiscoveryDeclaration(
        candidate({
          env: [
            `${DISCOVERY_ENV.discovery}=true`,
            `${DISCOVERY_ENV.serviceId}=my-app`,
            `${DISCOVERY_ENV.port}=3000`,
            `${DISCOVERY_ENV.domain}=`,
          ],
          labels: { [DISCOVERY_LABEL.domain]: "app.example.com" },
        }),
      ),
    );
    expect(declaration.hostname).toBe("app.example.com");
  });
});

describe("hostname and port validation", () => {
  it("requires a hostname", () => {
    const rejection = rejectionOf(
      parseDiscoveryDeclaration(candidate({ env: [`${DISCOVERY_ENV.discovery}=true`, `${DISCOVERY_ENV.serviceId}=my-app`, `${DISCOVERY_ENV.port}=3000`] })),
    );
    expect(rejection).toMatchObject({ kind: "invalid", code: "missing-domain" });
  });

  it("rejects invalid hostnames", () => {
    for (const hostname of ["app", "-app.example.com", "app..example.com", "app .example.com", "*.example.com", "app.example.com.", "https://app.example.com", "exa_mple.example.com", "app_example.com"]) {
      const rejection = rejectionOf(
        parseDiscoveryDeclaration(
          candidate({ env: [`${DISCOVERY_ENV.discovery}=true`, `${DISCOVERY_ENV.serviceId}=x`, `${DISCOVERY_ENV.port}=80`, `${DISCOVERY_ENV.domain}=${hostname}`] }),
        ),
      );
      expect(rejection).toMatchObject({ kind: "invalid", code: "invalid-domain" });
    }
  });

  it("normalizes hostname case", () => {
    const declaration = declarationOf(
      parseDiscoveryDeclaration(candidate({ env: [`${DISCOVERY_ENV.discovery}=true`, `${DISCOVERY_ENV.serviceId}=x`, `${DISCOVERY_ENV.port}=80`, `${DISCOVERY_ENV.domain}=App.Example.COM`] })),
    );
    expect(declaration.hostname).toBe("app.example.com");
  });

  it("requires a port", () => {
    const rejection = rejectionOf(
      parseDiscoveryDeclaration(candidate({ env: [`${DISCOVERY_ENV.discovery}=true`, `${DISCOVERY_ENV.serviceId}=my-app`, `${DISCOVERY_ENV.domain}=app.example.com`] })),
    );
    expect(rejection).toMatchObject({ kind: "invalid", code: "missing-port" });
  });

  it("rejects non-integer and out-of-range ports", () => {
    for (const port of ["abc", "3.5", "0", "-1", "65536", "99999", "http"]) {
      const rejection = rejectionOf(
        parseDiscoveryDeclaration(
          candidate({ env: [`${DISCOVERY_ENV.discovery}=true`, `${DISCOVERY_ENV.serviceId}=x`, `${DISCOVERY_ENV.domain}=app.example.com`, `${DISCOVERY_ENV.port}=${port}`] }),
        ),
      );
      expect(rejection).toMatchObject({ kind: "invalid", code: expect.stringMatching(/^invalid-port$/) });
    }
  });

  it("accepts boundary ports 1 and 65535", () => {
    for (const port of [1, 65535]) {
      const declaration = declarationOf(
        parseDiscoveryDeclaration(candidate({ env: [`${DISCOVERY_ENV.discovery}=true`, `${DISCOVERY_ENV.serviceId}=x`, `${DISCOVERY_ENV.domain}=app.example.com`, `${DISCOVERY_ENV.port}=${port}`] })),
      );
      expect(declaration.port).toBe(port);
    }
  });
});

describe("stable identity", () => {
  it("uses an explicit service id with an id: prefixed key", () => {
    const declaration = declarationOf(parseDiscoveryDeclaration(candidate()));
    expect(declaration.serviceKey).toBe("id:my-app");
    expect(declaration.serviceId).toBe("my-app");
  });

  it("derives identity from Compose project + service labels", () => {
    const declaration = declarationOf(
      parseDiscoveryDeclaration(
        candidate({
          env: [`${DISCOVERY_ENV.discovery}=true`, `${DISCOVERY_ENV.domain}=app.example.com`, `${DISCOVERY_ENV.port}=3000`],
          labels: { [COMPOSE_PROJECT_LABEL]: "shop", [COMPOSE_SERVICE_LABEL]: "web" },
        }),
      ),
    );
    expect(declaration.serviceKey).toBe("compose:shop/web");
    expect(declaration.composeProject).toBe("shop");
    expect(declaration.composeService).toBe("web");
  });

  it("requires an explicit id for standalone containers without Compose identity", () => {
    const rejection = rejectionOf(
      parseDiscoveryDeclaration(
        candidate({
          env: [`${DISCOVERY_ENV.discovery}=true`, `${DISCOVERY_ENV.domain}=app.example.com`, `${DISCOVERY_ENV.port}=3000`],
        }),
      ),
    );
    expect(rejection).toMatchObject({ kind: "invalid", code: "identity-required" });
  });

  it("rejects half a Compose identity", () => {
    const rejection = rejectionOf(
      parseDiscoveryDeclaration(
        candidate({
          env: [`${DISCOVERY_ENV.discovery}=true`, `${DISCOVERY_ENV.domain}=app.example.com`, `${DISCOVERY_ENV.port}=3000`],
          labels: { [COMPOSE_SERVICE_LABEL]: "web" },
        }),
      ),
    );
    expect(rejection).toMatchObject({ kind: "invalid", code: "compose-identity-partial" });
  });

  it("rejects invalid explicit service ids", () => {
    for (const serviceId of ["-app", "app app", "spaced id", "a".repeat(64)]) {
      const rejection = rejectionOf(
        parseDiscoveryDeclaration(
          candidate({ env: [`${DISCOVERY_ENV.discovery}=true`, `${DISCOVERY_ENV.domain}=app.example.com`, `${DISCOVERY_ENV.port}=80`, `${DISCOVERY_ENV.serviceId}=${serviceId}`] }),
        ),
      );
      expect(rejection).toMatchObject({ kind: "invalid", code: "invalid-service-id" });
    }
  });

  it("rejects duplicate live identities", () => {
    const a = declarationOf(parseDiscoveryDeclaration(candidate()));
    const b = declarationOf(
      parseDiscoveryDeclaration(
        candidate({ env: [`${DISCOVERY_ENV.discovery}=true`, `${DISCOVERY_ENV.serviceId}=my-app`, `${DISCOVERY_ENV.domain}=other.example.com`, `${DISCOVERY_ENV.port}=4000`] }),
      ),
    );
    const duplicates = findDuplicateDiscoveryIdentities([a, b]);
    expect(duplicates.get("id:my-app")).toHaveLength(2);
    expect(findDuplicateDiscoveryIdentities([a]).size).toBe(0);
  });
});

describe("network resolution", () => {
  it("selects the single usable network when no selector is set", () => {
    const declaration = declarationOf(
      parseDiscoveryDeclaration(
        candidate({
          env: [`${DISCOVERY_ENV.discovery}=true`, `${DISCOVERY_ENV.serviceId}=x`, `${DISCOVERY_ENV.domain}=app.example.com`, `${DISCOVERY_ENV.port}=80`],
          networks: [
            { name: "shop_default", driver: "bridge", id: "net_1" },
          ],
        }),
      ),
    );
    expect(declaration.network).toBe("shop_default");
    expect(declaration.networkId).toBe("net_1");
  });

  it("resolves an explicit selector by exact actual name", () => {
    const declaration = declarationOf(
      parseDiscoveryDeclaration(
        candidate({
          labels: { [DISCOVERY_LABEL.network]: "frontend" },
          networks: [
            { name: "backend", driver: "bridge" },
            { name: "frontend", driver: "bridge", id: "net_f" },
          ],
        }),
      ),
    );
    expect(declaration.network).toBe("frontend");
    expect(declaration.networkId).toBe("net_f");
  });

  it("rejects a selector for a network the container is not attached to", () => {
    const rejection = rejectionOf(
      parseDiscoveryDeclaration(
        candidate({
          labels: { [DISCOVERY_LABEL.network]: "missing-net" },
          networks: [{ name: "backend", driver: "bridge" }],
        }),
      ),
    );
    expect(rejection).toMatchObject({ kind: "invalid", code: "network-missing" });
  });

  it("never matches a Compose YAML alias — selector must be the real name", () => {
    const rejection = rejectionOf(
      parseDiscoveryDeclaration(
        candidate({
          labels: { [DISCOVERY_LABEL.network]: "front" }, // compose alias
          networks: [{ name: "shop_frontend", driver: "bridge" }],
        }),
      ),
    );
    expect(rejection).toMatchObject({ kind: "invalid", code: "network-missing" });
  });

  it("validates an EXPLICIT selector with the same usability rule — host, default bridge and overlays are rejected", () => {
    for (const net of [
      { name: "host", driver: "host" },
      { name: "bridge", driver: "bridge" },
      { name: "swarm-net", driver: "overlay" },
    ]) {
      const rejection = rejectionOf(
        parseDiscoveryDeclaration(
          candidate({
            env: [`${DISCOVERY_ENV.discovery}=true`, `${DISCOVERY_ENV.serviceId}=x`, `${DISCOVERY_ENV.domain}=app.example.com`, `${DISCOVERY_ENV.port}=80`, `${DISCOVERY_ENV.network}=${net.name}`],
            networks: [net],
          }),
        ),
      );
      expect(rejection).toMatchObject({ kind: "invalid", code: "network-unusable" }, net.name);
      expect((rejection as { message: string }).message).toContain(net.name);
    }
  });

  it("requires a selector when several usable networks are attached", () => {
    const rejection = rejectionOf(
      parseDiscoveryDeclaration(
        candidate({
          networks: [
            { name: "frontend", driver: "bridge" },
            { name: "backend", driver: "bridge" },
          ],
        }),
      ),
    );
    expect(rejection).toMatchObject({ kind: "invalid", code: "network-ambiguous" });
  });

  it("rejects when only unusable networks are attached", () => {
    const rejection = rejectionOf(
      parseDiscoveryDeclaration(
        candidate({
          networks: [{ name: "bridge", driver: "bridge" }, { name: "host", driver: "host" }],
        }),
      ),
    );
    expect(rejection).toMatchObject({ kind: "invalid", code: "network-unusable" });
  });

  it("reports unknown membership when the caller provides no networks", () => {
    const rejection = rejectionOf(parseDiscoveryDeclaration(candidate({ networks: null })));
    expect(rejection).toMatchObject({ kind: "invalid", code: "networks-unknown" });
  });

  it("treats default bridge, host, none and overlays as unusable", () => {
    expect(isUsableDiscoveryNetwork({ name: "bridge", driver: "bridge" })).toBe(false);
    expect(isUsableDiscoveryNetwork({ name: "host", driver: "host" })).toBe(false);
    expect(isUsableDiscoveryNetwork({ name: "none", driver: "null" })).toBe(false);
    expect(isUsableDiscoveryNetwork({ name: "swarm-net", driver: "overlay" })).toBe(false);
    expect(isUsableDiscoveryNetwork({ name: "shop_default", driver: "bridge" })).toBe(true);
    expect(isUsableDiscoveryNetwork({ name: "mystery", driver: undefined })).toBe(false); // unproven driver → not usable
    expect(isUsableDiscoveryNetwork({ name: "", driver: "bridge" })).toBe(false);
  });
});

describe("helper exclusions", () => {
  it("excludes Openship-owned containers even when they opt in", () => {
    for (const label of ["openship.project", "openship.deployment", "openship.service", "openship.build", "openship.role", "io.openship.managed-node-listener"]) {
      const rejection = rejectionOf(parseDiscoveryDeclaration(candidate({ labels: { [label]: "some-value" } })));
      expect(rejection).toEqual({ kind: "excluded", label });
    }
  });

  it("excludes before reading the opt-in flag", () => {
    const rejection = rejectionOf(
      parseDiscoveryDeclaration(
        candidate({
          env: [`${DISCOVERY_ENV.domain}=app.example.com`, `${DISCOVERY_ENV.port}=80`, `${DISCOVERY_ENV.serviceId}=x`],
          labels: { "openship.project": "existing-app" },
        }),
      ),
    );
    expect(rejection).toEqual({ kind: "excluded", label: "openship.project" });
  });
});

describe("determinism and config hash", () => {
  it("produces the same declaration for the same facts", () => {
    const input = candidate();
    expect(parseDiscoveryDeclaration(input)).toEqual(parseDiscoveryDeclaration({ ...input }));
  });

  it("hashes only hostname, port and network", () => {
    const base = declarationOf(parseDiscoveryDeclaration(candidate()));
    const same = discoveryConfigHash(base);
    expect(same).toBe(discoveryConfigHash({ hostname: base.hostname, port: base.port, network: base.network }));
    expect(same).not.toBe(discoveryConfigHash({ ...base, port: base.port + 1 }));
    expect(same).not.toBe(discoveryConfigHash({ ...base, hostname: "other.example.com" }));
    expect(same).not.toBe(discoveryConfigHash({ ...base, network: "backend" }));
    expect(same).toMatch(/^[0-9a-f]{8}$/);
  });
});
