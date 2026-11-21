import { describe, expect, it } from "vitest";
import {
  DISCOVERY_TLS_DEFAULT_PROVIDER,
  DISCOVERY_TLS_ORIGIN_CA_DEFAULT_VALIDITY_DAYS,
  DISCOVERY_TLS_ORIGIN_CA_VALIDITY_DAYS,
  DISCOVERY_TLS_PROVIDERS,
  DISCOVERY_TLS_PROVIDER_SOURCES,
  isDiscoveryTlsProvider,
  isSupportedOriginCaValidityDays,
} from "./discovery-tls";

/** The canonical managed TLS vocabulary (docs/cloudflare-origin-ca-discovery-plan.md). */
describe("discovery TLS provider vocabulary", () => {
  it("supports exactly the two managed IDs, defaulting to Let's Encrypt", () => {
    expect(DISCOVERY_TLS_PROVIDERS).toEqual(["letsencrypt", "cloudflare-origin-ca"]);
    expect(DISCOVERY_TLS_DEFAULT_PROVIDER).toBe("letsencrypt");
    expect(isDiscoveryTlsProvider("letsencrypt")).toBe(true);
    expect(isDiscoveryTlsProvider("cloudflare-origin-ca")).toBe(true);
    // Everything else — including plausible shorthands — is refused.
    for (const bad of ["cloudflare", "Cloudflare-Origin-CA", "zero_ssl", "", null, undefined, 1]) {
      expect(isDiscoveryTlsProvider(bad)).toBe(false);
    }
  });

  it("tracks how a provider choice was made", () => {
    expect(DISCOVERY_TLS_PROVIDER_SOURCES).toEqual(["default", "explicit"]);
  });

  it("accepts ONLY Cloudflare's discrete Origin CA validity values", () => {
    expect([...DISCOVERY_TLS_ORIGIN_CA_VALIDITY_DAYS]).toEqual([7, 30, 90, 365, 730, 1095, 5475]);
    expect(DISCOVERY_TLS_ORIGIN_CA_DEFAULT_VALIDITY_DAYS).toBe(365);
    for (const supported of DISCOVERY_TLS_ORIGIN_CA_VALIDITY_DAYS) {
      expect(isSupportedOriginCaValidityDays(supported), `${supported}d`).toBe(true);
    }
    // In-range-looking integers the API rejects…
    for (const unsupported of [8, 29, 31, 89, 364, 366, 729, 1094, 1096, 3650, 5474, 5476]) {
      expect(isSupportedOriginCaValidityDays(unsupported), `${unsupported}d`).toBe(false);
    }
    // …and non-durations entirely.
    for (const bad of [0, -7, 7.5, Number.NaN, Number.POSITIVE_INFINITY, "365", null, undefined]) {
      expect(isSupportedOriginCaValidityDays(bad)).toBe(false);
    }
  });
});
