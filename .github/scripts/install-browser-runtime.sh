#!/usr/bin/env bash
set -euo pipefail

sources=/etc/apt/sources.list.d/ubuntu.sources
scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/zaovra-browser-apt.XXXXXX")
restore=false
cleanup() {
  if [[ "$restore" == true ]]; then
    sudo cp -- "$scratch/original.sources" "$sources"
  fi
  rm -f -- "$scratch/install.log" "$scratch/original.sources" "$scratch/fallback.sources"
  rmdir -- "$scratch"
}
trap cleanup EXIT

install=(bun x --no-install playwright-core install --with-deps --only-shell chromium)
if "${install[@]}" 2>&1 | tee "$scratch/install.log"; then
  exit 0
else
  status=$?
fi

# APT archive failures are distinct from browser download or setup failures.
if ! grep -Eq '^E: Failed to fetch https?://(azure\.archive|security)\.ubuntu\.com/ubuntu/' "$scratch/install.log"; then
  exit "$status"
fi

if ! sudo cat "$sources" > "$scratch/original.sources"; then
  exit "$status"
fi
# Retain every suite, component and signing key, including the security pocket.
sed -E '/^URIs:/ s#https?://(azure\.archive|security)\.ubuntu\.com/ubuntu/?([[:blank:]]|$)#https://archive.ubuntu.com/ubuntu\2#g' \
  "$scratch/original.sources" > "$scratch/fallback.sources"
if cmp -s "$scratch/original.sources" "$scratch/fallback.sources"; then
  exit "$status"
fi

echo 'Ubuntu archive fetch failed. Retrying the browser runtime once via https://archive.ubuntu.com/ubuntu.'
restore=true
sudo cp -- "$scratch/fallback.sources" "$sources"
"${install[@]}"
