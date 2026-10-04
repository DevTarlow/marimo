#!/usr/bin/env bash
#
# Run a command with every tool cache pointed inside the repository.
#
# This exists because the environment this project is developed in only permits
# writes under the workspace, and several tools insist on writing to `$HOME`
# regardless of what the project asks for:
#
#   - pnpm's package store and npm's cache  -> set in `pnpm-workspace.yaml`
#   - Electron's binary download            -> `@electron/get` resolves
#                                              `env-paths('electron').cache`,
#                                              which on Linux is
#                                              `$XDG_CACHE_HOME/electron`
#   - Vite's dependency pre-bundle          -> `$XDG_CACHE_HOME`
#   - electron-builder's icon and tool      -> `ELECTRON_BUILDER_CACHE`, which
#     downloads                            it does *not* take from XDG
#
# The pnpm settings cover the first; the XDG variables here cover the rest, and
# Electron is the reason this script exists at all: without `XDG_CACHE_HOME` set
# its installer fails with `ENOENT: no such file or directory, mkdir
# ~/.cache/electron/...`, which reads like a corrupt download rather than a
# permission problem.
#
#   ./scripts/with-local-caches.sh pnpm install
#   ./scripts/with-local-caches.sh ./apps/desktop/node_modules/.bin/electron --version
#
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export XDG_CACHE_HOME="$repo_root/.xdg-cache"
export XDG_DATA_HOME="$repo_root/.xdg-data"
export XDG_CONFIG_HOME="$repo_root/.xdg-config"
export XDG_STATE_HOME="$repo_root/.xdg-state"
export PNPM_HOME="$repo_root/.pnpm-home"
export npm_config_cache="$repo_root/.npmcache"

# electron-builder extracts a small CommonJS helper here to turn a PNG into the
# `.ico` and `.icns` the Windows and macOS builds need. It does not honour XDG,
# so without this it lands in `~/.cache/electron-builder` — which the environment
# forbids — and with it pointed at the repository instead, it lands inside the
# root `package.json`'s `"type": "module"` scope and Node refuses to load it as
# the CommonJS it is:
#
#   ReferenceError: require is not defined in ES module scope
#
# The marker file is what makes that directory its own CommonJS package, so the
# helper loads. Both symptoms are about the environment rather than the app, and
# both look like a broken build.
export ELECTRON_BUILDER_CACHE="$repo_root/.electron-builder-cache"
mkdir -p "$ELECTRON_BUILDER_CACHE"
if [ ! -f "$ELECTRON_BUILDER_CACHE/package.json" ]; then
  printf '{"type":"commonjs"}\n' > "$ELECTRON_BUILDER_CACHE/package.json"
fi

mkdir -p "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" \
  "$XDG_STATE_HOME" "$PNPM_HOME" "$npm_config_cache"

exec "$@"
