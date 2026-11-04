#!/usr/bin/env bash
set -euo pipefail

# Also serves as the SSH key's forced command. No request text is evaluated.
request="${SSH_ORIGINAL_COMMAND-$*}"
pattern='^deploy ([0-9a-f]{40})$'
[[ "$request" =~ $pattern ]] || { echo 'Expected: deploy <full lowercase commit SHA>' >&2; exit 2; }
sha="${BASH_REMATCH[1]}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$repo"

# The checkout is installed by the operator, never reset by this key.
exec 9>"$repo/.git/breinhap-web-deploy.lock"
flock -w 300 9 || { echo 'Another website deployment holds the lock' >&2; exit 75; }
git fetch --prune origin main
git merge-base --is-ancestor "$sha" origin/main || { echo 'Commit is not on main' >&2; exit 1; }
docker network inspect edge_net > /dev/null

tag="ghcr.io/alisafari-it/breinhap:web-$sha"
docker pull "$tag"
revision=$(docker image inspect "$tag" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
[[ "$revision" == "$sha" ]] || { echo 'Image revision does not match requested commit' >&2; exit 1; }
digest=$(docker image inspect "$tag" --format '{{index .RepoDigests 0}}')
[[ "$digest" =~ ^ghcr.io/alisafari-it/breinhap@sha256:[0-9a-f]{64}$ ]] || { echo 'Image digest is invalid' >&2; exit 1; }
export BREINHAP_SITE_IMAGE="$digest"
compose=(docker compose -p breinhap-web -f "$here/compose.yml")
current=$("${compose[@]}" ps -aq site)
previous=''
if [[ -n "$current" ]]; then
  previous=$(docker inspect "$current" --format '{{.Config.Image}}')
fi
if ! "${compose[@]}" up -d --no-deps --wait --wait-timeout 90 site; then
  echo 'Website failed its health check' >&2
  if [[ -n "$previous" ]]; then
    echo 'Restoring the previous website image' >&2
    BREINHAP_SITE_IMAGE="$previous" "${compose[@]}" up -d --no-deps --wait --wait-timeout 90 site ||
      echo 'Restoring the previous image also failed; operator investigation required' >&2
  else
    "${compose[@]}" stop site || true
  fi
  exit 1
fi
printf 'Deployed Breinhap website %s (%s)\n' "$sha" "$digest"
