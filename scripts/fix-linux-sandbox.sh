#!/usr/bin/env bash
#
# Let Electron's sandbox start on Ubuntu 24.04 and later.
#
# Ubuntu 24.04 turned `kernel.apparmor_restrict_unprivileged_userns` on, which
# refuses an ordinary process the user namespace Chromium's sandbox is built on.
# Chromium then falls back to the setuid helper, `chrome-sandbox`, and Electron
# ships that as a plain user-owned 0755 file — so the fallback aborts rather than
# silently running unsandboxed:
#
#   FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:166] The SUID sandbox
#   helper binary was found, but is not configured correctly.
#
# `pnpm --filter @marimo/desktop dev` dies there, *after* Vite has printed its
# URL, so it reads like a renderer that failed to paint rather than a host policy
# that refused a syscall. That misreading is the reason this script exists: it is
# not a container problem, and on a stock 24.04-or-later laptop it is the default.
#
# The fix is the one Ubuntu ships for its own browsers — an AppArmor profile that
# names this binary and grants `userns,`. Compare `/etc/apparmor.d/chrome`. It
# leaves the sandbox switched *on*, which is what separates it from
# `--no-sandbox`. The alternative, `chown root:root` plus `chmod 4755` on
# chrome-sandbox, also works, but the next `pnpm install` that re-extracts
# Electron undoes it, and a setuid-root binary inside a writable `node_modules`
# is precisely what the namespace sandbox was introduced to avoid.
#
# Run it once. Re-run it whenever the Electron version changes, because the
# profile is attached to the versioned path inside `.pnpm` — a profile pointing
# at `electron@44.5.1` does not cover `electron@45.0.0`, and it fails the same
# silent way it did before:
#
#   ./scripts/fix-linux-sandbox.sh
#
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
profile_name="marimo-agent-dev"
profile_path="/etc/apparmor.d/$profile_name"
restrict="/proc/sys/kernel/apparmor_restrict_unprivileged_userns"

# Not Linux, or a kernel without the restriction, or a distribution that has not
# switched it on: in all three cases user namespaces are unrestricted and
# Electron's own sandbox starts without help. Exiting 0 rather than erroring
# matters, because a contributor on such a machine should be able to run this
# and be told there is nothing to do.
if [ "$(uname -s)" != "Linux" ]; then
  echo "Not Linux — Electron's sandbox is already available. Nothing to do."
  exit 0
fi

if [ ! -e "$restrict" ]; then
  echo "This kernel has no AppArmor user-namespace restriction. Nothing to do."
  exit 0
fi

if [ "$(cat "$restrict")" != "1" ]; then
  echo "AppArmor is not restricting user namespaces here. Nothing to do."
  exit 0
fi

# The restriction is on, so the profile is the only thing that will help — which
# makes a missing parser a real failure rather than a reason to shrug.
if ! command -v apparmor_parser >/dev/null 2>&1; then
  echo "apparmor_parser is not installed, so the profile cannot be loaded." >&2
  echo "Install AppArmor, or accept the loss of isolation with --no-sandbox." >&2
  exit 1
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo is not installed; run this script as root instead." >&2
  exit 1
fi

# `require('electron')` from the desktop package is the version-independent way
# to find the binary: it is the same resolution the dev launcher does when it
# spawns the app, so the profile cannot attach to a path the launcher never uses.
electron_bin="$(cd "$repo_root/apps/desktop" && node -e "process.stdout.write(require('electron'))" 2>/dev/null || true)"
if [ -z "$electron_bin" ] || [ ! -x "$electron_bin" ]; then
  echo "Could not find the Electron binary; run 'pnpm install' first." >&2
  exit 1
fi

# One profile, parameterised by the abi version, because the abi is the parser's
# rather than the distribution's: 24.04 knows abi/4.0 and 26.04 knows abi/5.0,
# and naming one the installed parser does not have is a hard error. Both are
# still out there, so the version is discovered rather than assumed.
profile_for_abi() {
  cat <<EOF
abi <abi/$1>,
include <tunables/global>

profile $profile_name "$electron_bin" flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/$profile_name>
}
EOF
}

abi=""
if [ -d /etc/apparmor.d/abi ]; then
  for candidate in $(ls /etc/apparmor.d/abi | grep -E '^[0-9]+\.[0-9]+$' | sort -rV); do
    # A parse with no kernel load is the whole safety net: it proves the profile
    # is well formed and the abi is one this parser accepts, before anything is
    # written under /etc or a reload is attempted.
    if profile_for_abi "$candidate" | apparmor_parser --skip-kernel-load --debug /dev/stdin >/dev/null 2>&1; then
      abi="$candidate"
      break
    fi
  done
fi

if [ -z "$abi" ]; then
  echo "No AppArmor abi version this parser accepts was found; is AppArmor intact?" >&2
  exit 1
fi

echo "Electron binary: $electron_bin"
echo "AppArmor abi:    $abi"
echo "Profile:         $profile_path"
echo
echo "This grants that one binary permission to create user namespaces, which is"
echo "what Chromium's sandbox needs. It is being written under /etc, so it needs"
echo "root."
echo

profile_for_abi "$abi" | sudo tee "$profile_path" >/dev/null
sudo apparmor_parser --replace --write-cache --skip-read-cache "$profile_path"

echo
echo "done — 'pnpm --filter @marimo/desktop dev' should now open a window."
echo "Re-run this script after anything that changes the Electron version."
