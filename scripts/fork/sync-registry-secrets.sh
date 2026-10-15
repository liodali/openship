#!/usr/bin/env bash
# Populate fork.env from OpenBao — the only place tokens should originate.
#
#   scripts/fork/sync-registry-secrets.sh            # write push creds into fork.env
#   scripts/fork/sync-registry-secrets.sh --pull     # print the READ-ONLY pull token
#                                                     # (for podman login on the VPS)
#
# Requires: `bao-login` (userpass; see ~/.openbao/environment) and the KV
# entries from the bootstrap in docs/fork-maintenance.md:
#   secret/registry/gitea-push  { username, token }   (write:package)
#   secret/registry/gitea-pull  { username, token }   (read:package, VPS only)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/fork.env"
MOUNT="${BAO_KV_MOUNT:-secret}"

need_login() {
  bao token lookup >/dev/null 2>&1 || {
    echo "not logged in to OpenBao — run: bao-login" >&2
    exit 1
  }
}

fetch() { # path field
  bao kv get -mount="$MOUNT" -field="$2" "$1"
}

if [ "${1:-}" = "--pull" ]; then
  need_login
  user="$(fetch registry/gitea-pull username)"
  token="$(fetch registry/gitea-pull token)"
  echo "# VPS pull credentials (read-only):"
  echo "podman login gitea.example.com -u '$user' --password-stdin <<< '$token'"
  exit 0
fi

need_login
user="$(fetch registry/gitea-push username)"
token="$(fetch registry/gitea-push token)"
[ -n "$user" ] && [ -n "$token" ] || { echo "OpenBao returned empty credentials" >&2; exit 1; }

# Write credentials into fork.env, preserving the non-secret lines.
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
tmp="$(mktemp)"
{
  grep -vE '^FORK_REGISTRY_(USER|TOKEN)=' "$ENV_FILE" || true
  echo "FORK_REGISTRY_USER=$user"
  echo "FORK_REGISTRY_TOKEN=$token"
} > "$tmp" && mv "$tmp" "$ENV_FILE"
echo "fork.env updated from OpenBao (push credentials)."
