#!/usr/bin/env bash
# Build + push the fork's control-plane images from a laptop — the local twin
# of .github/workflows/fork-images.yml, reading the same keys from `fork.env`
# (see fork.env.example). Use when you want images for a hand-pushed commit
# without waiting for Actions, or to test a Dockerfile change.
#
#   scripts/fork/build-images.sh                     # api + dashboard + edge
#   scripts/fork/build-images.sh api edge            # subset
#   scripts/fork/build-images.sh --no-push api       # build only
#   scripts/fork/build-images.sh --tag 0.9.3-rc1     # custom tag(s)
#
# Tags pushed (same contract as CI): <version>, <version>-<shortsha>, latest.
# NOTE: local builds target linux/amd64 (the VPS). On an arm64 machine that
# goes through emulation and is slow — CI is the cheap path.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

usage() {
  sed -n '2,12p' "$0"; exit 2
}

IMAGES=()
TAGS=()
PUSH=1
PLATFORM=linux/amd64
while [ $# -gt 0 ]; do
  case "$1" in
    api|dashboard|edge) IMAGES+=("$1") ;;
    --tag) shift; [ $# -gt 0 ] || usage; TAGS+=("$1") ;;
    --no-push) PUSH=0 ;;
    --platform) shift; [ $# -gt 0 ] || usage; PLATFORM="$1" ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
  shift
done
[ ${#IMAGES[@]} -gt 0 ] || IMAGES=(api dashboard edge)

# ── Config: environment wins over fork.env ───────────────────────────────────
ENV_FILE="$ROOT/fork.env"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi
: "${FORK_REGISTRY:?FORK_REGISTRY is not set — copy fork.env.example to fork.env and fill it in (or export it)}"
FORK_NAMESPACE="${FORK_NAMESPACE:-medali}"

VERSION="$(node -p "require('./package.json').version")"
SHA="$(git rev-parse --short HEAD)"
[ ${#TAGS[@]} -gt 0 ] || TAGS=("$VERSION" "$VERSION-$SHA" "latest")

ENGINE="$(command -v podman || command -v docker || true)"
: "${ENGINE:?neither podman nor docker is installed}"
echo "engine=$ENGINE  registry=$FORK_REGISTRY/$FORK_NAMESPACE  version=$VERSION  sha=$SHA  platform=$PLATFORM"

if [ "$PUSH" = 1 ] && [ -n "${FORK_REGISTRY_USER:-}" ] && [ -n "${FORK_REGISTRY_TOKEN:-}" ]; then
  "$ENGINE" login "$FORK_REGISTRY" -u "$FORK_REGISTRY_USER" --password-stdin <<<"$FORK_REGISTRY_TOKEN"
fi

for image in "${IMAGES[@]}"; do
  REFS=()
  for tag in "${TAGS[@]}"; do
    REFS+=(-t "$FORK_REGISTRY/$FORK_NAMESPACE/openship-$image:$tag")
  done
  echo "── building $image → ${TAGS[*]}"
  "$ENGINE" build --platform "$PLATFORM" -f "apps/$image/Dockerfile" "${REFS[@]}" .
  if [ "$PUSH" = 1 ]; then
    for tag in "${TAGS[@]}"; do
      "$ENGINE" push "$FORK_REGISTRY/$FORK_NAMESPACE/openship-$image:$tag"
    done
  fi
done
echo "done: ${IMAGES[*]} → ${TAGS[*]}"
