# Openship fork.3 — wildcard TLS validation recap & handbook

Working note for follow-up sessions. Written 2026-11-22 after remote validation on
the Contabo VPS (`rocky@contabo`, Tailscale `100.123.76.106`, public `185.182.184.116`).
Everything below was verified live unless marked otherwise. Four behaviors are
NOT TESTED live (no recorded session evidence): due rotation actually firing,
crash recovery mid-install, failed-reload rollback, and policy-change races
against queued work. A retired issuance row alone does not prove rollback
behavior — see "NOT TESTED live" below the validation table.

## Current deployment state

| Item | Value |
|---|---|
| Release live on VPS | **`1.0.1-fork.3`** (api + dashboard + edge, `podman-compose` project `openship` in `~/.openship/compose`) |
| Fix shipped | PR [#24](https://github.com/liodali/openship/pull/24) — TLS reuse must prove the route serves the material; release PR [#25](https://github.com/liodali/openship/pull/25), tag `fork-v1.0.1-fork.3` (commit `c2a5d631a`) |
| Rollback | `.env.bak-openship-tls-canary-pre-fork3` + `docker-compose.yml.bak-openship-tls-canary-pre-fork3` in `~/.openship/compose`; fork.2 images still on the box. Rollback = restore `.env` (`OPENSHIP_VERSION=1.0.1-fork.2`) + `podman-compose up -d` |
| Openship server ID | `4e78e93f-baf6-4de2-9bb7-c3e32b7d9bd0` |
| Cloudflare zone | `containerpub.com` = `b2f04038fb95e595498567547ffe748a` (NS holly/leland.ns.cloudflare.com; SSL mode strict) |
| Cloudflare credential (Openship ref) | `cred_4tFBS7OSEMW759xB` (token value never printed/handled) |
| Dashboard/API | https://openship.dev.kahuna.adetify.com/ (edge `openresty/1.31.9.1`, host network :80/:443); API loopback `127.0.0.1:4001` |
| Test domain (exact) | `test.dev.containerpub.com` — proxied through Cloudflare (188.114.96.x/97.x) |
| Wildcard pattern (validated) | `*.sites.tests.dev.containerpub.com` and `*.canary2.sites.tests.dev.containerpub.com` — both have **proxied wildcard DNS** in the zone; children: `site1/site2.<base>` |
| Edge cert paths | vhosts in `/var/lib/openship/edge/sites-enabled/<slug>.conf`; shared wildcards live once under `/etc/letsencrypt/live/*.\<pattern\>/`; enrollment bootstrap self-signed under `/etc/letsencrypt/openship-bootstrap/<host>/` |

> Consumer naming rule (enforced by the parser, code `tls-wildcard-coverage`): the
> wildcard must cover the declared hostname with exactly one leftmost label.
> `*.sites.tests.dev.containerpub.com` covers `a.sites.tests…` — NOT `a.b.sites…`,
> NOT the base, NOT sibling suffixes like `site2.sites.dev.containerpub.com`.
> `adetify.com` is NOT on Cloudflare (OVH NS) — CF Origin CA only for `containerpub.com` hosts.

## What works (validated live on fork.3)

| Area | Evidence / how to check |
|---|---|
| Wildcard covers sites: ONE cert per pattern, N children share it (same serial + SAN) | `openssl s_client -connect 185.182.184.116:443 -servername <child> 2>/dev/null \| openssl x509 -noout -serial -ext subjectAltName` — both children identical |
| Discovery lifecycle: labels → route → rootless upstream (published-port on 127.0.0.1) → 60 s sweeps | `GET /api/discovery/servers/$SRV/discovery` → `applyState: applied`, `upstreamStrategy: published-port`, `hostPort` |
| Exact TLS: LE default; CF Origin CA per-domain (credential reference + zone); preflight (zone active/membership/proxied/strict/ruleset) runs on PUT | `PUT .../services/<key>/tls` body `{"provider":"cloudflare-origin-ca","cloudflare":{"credentialId":"cred_…","zoneId":"…"}}` → 200 with verified `zoneName` |
| Provider switching both directions; revoke-after-replacement | issuance row → `state: retired`, `reason: "certificate revoked after replacement"`. This row proves the switch and the revoke ran — NOT rollback behavior (failed-activation restore is NOT TESTED live, see "NOT TESTED live" below) |
| `ensure` idempotency: `skipped/already_valid` when healthy (LE and CF, exact AND wildcard), `already_queued` returns SAME op id, `deferred` while backend stopped | `POST .../services/<key>/tls/ensure -d '{}'` → HTTP 200 skipped / 202 |
| **fork.3 fix**: reuse path activates the requesting child (late consumer's vhost rewritten off bootstrap immediately; no manual route cycle) | `grep ssl_certificate /var/lib/openship/edge/sites-enabled/<child>.conf` → `/etc/letsencrypt/live/*.…/`, not `openship-bootstrap/` |
| Stopped service: 503 + `Cache-Control: no-store` + neutral unbranded page; cert retained; zero new issuance; healthy cert reused on start | origin curl below → 503; DB issuance count unchanged |
| UI improvements: discovery hostnames are https links (new tab, noopener noreferrer) in every phase; neutral 503 page (light/dark, sentinel comment only) | `curl --resolve <host>:443:185.182.184.116 https://<host>/` while stopped |
| Dedup: concurrent ensures for the same pattern collapse to one op (`queued` + `already_queued`, same id) | `discovery_tls_operation` table |
| No exact-host fallback when wildcard source is missing/mismatched; shared material never revoked by per-site forget | `discovery_tls_issuance` — one row per pattern |
| Zero-issuance reuse for new consumers under an existing healthy pattern (fork.3) | new canary under `*.sites.tests…` → REUSE, no new CF cert |

### NOT TESTED live — suite-covered logic only

No recorded session exercised these; the validated-live table above must not be
read as covering them:

| Behavior | Supporting evidence (unit level only) |
|---|---|
| Due rotation firing near expiry | exact flow: `origin-ca-issuance.test.ts` (inside/outside the rotation horizon → issue vs reuse). **The shared-wildcard dispatch's own near-expiry branch (`activeMaterialHealthy=false` from `sslExpiresAt`) has no focused test at any level** |
| Crash recovery mid-install | `discovery-tls-queue.test.ts` — "a crash between install and commit recovers through the served fingerprint — no reinstall" |
| Failed-reload rollback | `discovery-tls-queue.test.ts` — "an installation failure defers with rollback preserved — nothing commits"; "an unverified install result defers honestly (prior certificate preserved on the edge)". The inventory table's `retired` row proves revoke-after-replacement ran — NOT that a failed activation restored the previous pair |
| Policy-change races against queued/in-flight work | `discovery-tls-queue.test.ts` — stale-generation supersede, activation fence, under-lock sibling re-check; `discovery-tls-issuance.repo.test.ts` — fenced `markActive` |

## Still broken / not implemented

| Gap | How to check | Fix path |
|---|---|
| **Public HTTPS via Cloudflare for deep hostnames** — Universal SSL covers only `containerpub.com` + `*.containerpub.com`; `*.dev.containerpub.com`-depth hostnames get TLS alert 40 (no edge cert) | `curl -I https://test.dev.containerpub.com/` → handshake failure, while origin-direct works | Cloudflare ACM / Total TLS or custom edge cert — **operator action at Cloudflare, not an Openship defect** |
| **[P1] Shared wildcard renewal can stay pinned to a stopped consumer** (the `1.0.1-fork.3` release): the worker ran its fresh-backend gate on the operation's ORIGINAL hostname before consulting siblings, and every consumer deduplicates onto that one row (`ensureOperation` dedups by server+sourceHostname+generation) — so ONE stopped requester deferred renewal despite another consumer running | on the fork.3 release: stop the consumer that created the op, keep a sibling running, `POST .../tls/ensure` from the sibling → the op stays `deferred` across retries with the stopped requester's reason; no Cloudflare request fires | **fixed in PR [#26](https://github.com/liodali/openship/pull/26)** (the gate now SELECTS an eligible running consumer; requester keeps first claim; all-stopped defers pattern-scoped). Mixed state unit-tested; needs release + live revalidation on the VPS |
| **LE wildcard (DNS-01) not implemented** — declaration defers forever: "wildcard issuance waits for the shared-certificate dispatch (no exact-host fallback)" | label `openship.tls.provider=letsencrypt` + `openship.tls.wildcard` → `tlsOperation.state: deferred` with that reason | use `cloudflare-origin-ca` for wildcards today |
| **No wildcard pre-provisioning API** — cert issues on first eligible consumer; cannot provision before sites exist (Phase 5 gate) | no admin endpoint exists (only per-service `.../tls/ensure`) | planned Phase 5 |
| **No purge** — `DELETE` (forget) keeps domain row, cert files, inventory; response has no `"purged"` | `ls /etc/letsencrypt/live/*.<pattern>*` persists after forget | planned Phase 2 |
| **Vhost cert-path drift is undetected AND unrepaired — a remaining repair gap, not optional hardening.** Repair sweeps compare route state/sidecars; `ensure`'s `already_valid` skip compares certificate FILES (resolver: `certDir/<host>` exact, or inherited `certDir/<wildcard>`) against recorded inventory. Neither inspects the vhost's selected `ssl_certificate`. With files intact, a drifted vhost skips `already_valid` — the activation that would repair it never runs (the worker's reuse path DOES activate, but only when the fingerprint already fails to match) | manually rewrite a vhost `ssl_certificate` path → sweeps idle AND `ensure` → `skipped/already_valid` (no repair) | **fixed in PR [#26](https://github.com/liodali/openship/pull/26)**: adapter signal `readVhostCertSelection` (conf's `ssl_certificate` vs the expected exact/shared source; config-file proof, not a listener probe) consumed by BOTH the ensure skip decision AND the periodic certificate audit — confirmed drift with healthy files queues activation repair, no re-issue; unproven/missing-conf stay distinguishable. Unit-tested at adapter/platform/api levels; needs live revalidation (rewrite a vhost path → ensure must 202 and repair) |
| `ensure` skip proof is resolver-level (fingerprint equality vs recorded identity), not vhost-level. Sound for FIRST activation only: post-fork.3 the worker activates before committing `active` inventory, and a child without recorded identity cannot skip. It does NOT cover drift after activation — the row above | code: `packages/platform/src/discovery.ts` (ensureServiceTls); `packages/adapters/src/infra/nginx.ts` (readCertInfo/resolveCertificate) | **fixed by the same PR [#26](https://github.com/liodali/openship/pull/26) row above**: the skip now additionally requires the vhost's configured selection |
| Cosmetics: CF→LE switch creates `-0001` suffixed certbot lineage (served material == renewal-managed material, so harmless) | `ls /etc/letsencrypt/live/<host>*` | optional |
| 2 test-only CF Origin CA certs remain **active at Cloudflare** until 2027-11 (forget never revokes shared sources) | Cloudflare dashboard → SSL/TLS → Origin Servers (IDs below) | revoke manually if desired |

## TLS UI in Openship

- **Status: yes.** The Discovery card (server overview + dedicated `/discovery` page) renders
  per-service TLS: status chip (Verified/Issued/Provisioning/Expired/Error), provider label
  (`letsencrypt` / `cloudflare-origin-ca`), hover title with live operation state
  (queued/running/**deferred + reason**/error).
- **Configuration: yes as of PR [#26](https://github.com/liodali/openship/pull/26).** Every
  service's action menu has **Configure TLS** → a drawer wired to `serviceTls` /
  `configureServiceTls` / `ensureTls` + the saved-credential list (names only): provider,
  Cloudflare credential/zone/validity, read-only wildcard source & provenance, desired-vs-
  active provider, expiry, operation state/reason, and read-only addressing
  (container port / published host port / network — no port or wildcard overrides; those
  are container-declaration facts). The card also carries the server default-provider
  control (new enrollments only; nothing Cloudflare at server scope). Still no UI for
  `DELETE` (forget keeps material) or wildcard pre-provisioning.

## How to check (cheat sheet)

```bash
# --- API helper on the VPS (token read from operator config, never printed) ---
cat > /tmp/openship-api.sh <<'EOF'
#!/bin/bash
TOKEN=$(python3 -c "import json;print(json.load(open('/home/rocky/.openship/config.json'))['contexts']['default']['token'])")
curl -s -X "${1:-GET}" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "${@:2}"
EOF
chmod 700 /tmp/openship-api.sh
SRV=4e78e93f-baf6-4de2-9bb7-c3e32b7d9bd0

# Discovery status (all services + TLS + active op)
ssh rocky@contabo "/tmp/openship-api.sh GET http://127.0.0.1:4001/api/discovery/servers/$SRV/discovery"

# One service / its TLS policy / ensure / configure CF
ssh rocky@contabo "/tmp/openship-api.sh GET 'http://127.0.0.1:4001/api/discovery/servers/$SRV/discovery/services/id%3A<serviceId>'"
ssh rocky@contabo "/tmp/openship-api.sh GET 'http://127.0.0.1:4001/api/discovery/servers/$SRV/discovery/services/id%3A<serviceId>/tls'"
ssh rocky@contabo "/tmp/openship-api.sh POST 'http://127.0.0.1:4001/api/discovery/servers/$SRV/discovery/services/id%3A<serviceId>/tls/ensure' -d '{}'"
ssh rocky@contabo "/tmp/openship-api.sh PUT 'http://127.0.0.1:4001/api/discovery/servers/$SRV/discovery/services/id%3A<serviceId>/tls' \
  -d '{\"provider\":\"cloudflare-origin-ca\",\"cloudflare\":{\"credentialId\":\"cred_4tFBS7OSEMW759xB\",\"zoneId\":\"b2f04038fb95e595498567547ffe748a\"}}'"

# --- Origin cert (bypass Cloudflare, keep SNI; roots extracted from repo constants) ---
# build the CAfile once from packages/platform/src/engine/modules/discovery/origin-ca-trust-roots.ts
# (RSA pin D3:C7:E8:5C:…:76:20, ECC pin AA:63:69:7A:…:D8:0D)
curl --cacert cf-origin-roots.pem --resolve <host>:443:185.182.184.116 https://<host>/   # or Tailscale 100.123.76.106
echo | openssl s_client -connect 185.182.184.116:443 -servername <host> \
  -CAfile cf-origin-roots.pem -verify_hostname <host> -verify_return_error </dev/null

# --- Inventory (DB, read-only) ---
ssh rocky@contabo "podman exec openship_postgres_1 psql -U openship -d openship \
  -P pager=off -c 'select hostname,state,certificate_id,fingerprint,expires_on from discovery_tls_issuance'"
ssh rocky@contabo "podman exec openship_postgres_1 psql -U openship -d openship \
  -P pager=off -c 'select left(id,18) op,state,provider,source,created_at from discovery_tls_operation order by created_at desc limit 10'"

# --- Edge vhost material ---
ssh rocky@contabo "sudo grep ssl_certificate /var/lib/openship/edge/sites-enabled/<slug>.conf"
```

Container declaration (labels; env equivalents `OPENSHIP_*` exist):

```text
openship.discovery=true
openship.service.id=<id>                  # or compose project/service labels
openship.domain=<child-hostname>
openship.port=80
openship.tls.provider=cloudflare-origin-ca   # or letsencrypt
openship.tls.wildcard=*.<pattern-base>       # optional shared-source declaration
```

## Certificate inventory from the validation sessions

| Cert | Pattern/host | CF cert ID (decimal) / serial (hex) | Fingerprint (SHA-256) | Expiry | State |
|---|---|---|---|---|---|
| exact CF (fork.2 test) | test.dev.containerpub.com | 720804099642371954152841981368442208236994427759 / `7E41F943…DFB6F` | `26:D5:BB:D0…14:37:74` | 2027-11-21 | **revoked** after replacement |
| exact LE (switch-back) | test.dev.containerpub.com | serial `05E46A43…A3274D` | `67:E2:C3:55…3F:43:2F` | 2027-02-19 | retained on edge (files kept) |
| wildcard #1 | `*.sites.tests.dev.containerpub.com` | 551215747971432994102300709393870536892291725344 / `608D5E76…8FB820` | `6C:DD:21:EB…83:59:64` | 2027-11-21 | **active at Cloudflare** (test-only; revoke manually if desired) |
| wildcard #2 | `*.canary2.sites.tests.dev.containerpub.com` | 336717145650775266089221687871816549154472380607 / `3AFAEB44…F94C8BF` | `28:9B:03:27…D1:AD:30` | 2027-11-22 | **active at Cloudflare** (test-only; revoke manually if desired) |

## For the function-subdomain plan

The shared wildcard model already supports it: any new `<name>` under a declared
pattern base enrolls with the two TLS labels and **reuses** the certificate with zero
new issuance (validated: second consumer = reuse, same op id, one row). Remember:

- Coverage is exactly one label under the base (no deeper nesting, not the base itself).
- Consumers must be effectively proxied in the Cloudflare zone + Full (strict) — the
  proxied wildcard DNS record satisfies this for all children.
- Wildcards require `cloudflare-origin-ca` today (LE wildcard = DNS-01, not implemented).
- Shared renewal needs ≥1 fresh RUNNING consumer among the declaring
  bindings. Since the working-tree fix the worker selects an eligible running
  consumer when the operation's original requester is stopped (the requester
  keeps first claim; an all-stopped consumer set defers with a
  pattern-scoped reason; the mixed state is unit-tested). The fork.3 release
  deployed on the VPS still pins renewal to the original requester — upgrade
  and revalidate live before relying on the mixed state.
- Public browser HTTPS still needs the Cloudflare edge-cert fix (ACM/Total TLS) — independent
  of origin TLS, which is valid and verified.
