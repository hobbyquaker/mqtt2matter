#!/usr/bin/env bash
set -euo pipefail

# Build mqtt2matter, ship it to a Linux host and install it where `npm install -g` would put it
# (/usr/local/lib/node_modules/mqtt2matter, the command /usr/local/bin/mqtt2matter), then run
# `mqtt2matter --install` there again if the service is installed (units rewritten, service restarted).
#
# Usage:
#   bash deploy.sh                 # deploys to the host "mqtt2matter" (an ssh host name or alias)
#   bash deploy.sh root@myhost
#   npm run deploy -- root@myhost
#
# Optional environment variables:
#   REMOTE_DIR   install directory (default: /usr/local/lib/node_modules/mqtt2matter)
#   REMOTE_TMP   where the tarball is copied to (default: /tmp)
#   SKIP_TESTS   1 skips lint, typecheck and tests before packing
#   INSTALL      1 runs `mqtt2matter --install` on the host when the service is not installed yet
#   MQTT_URL     the broker for that first --install (e.g. mqtt://broker:1883); later changes go
#                through the UI or /etc/mqtt2matter/mqtt2matter.json
#
# The host needs ssh access (as root or with sudo), node and npm satisfying package.json's
# "engines", and systemd for the service.

PKG=mqtt2matter
REMOTE_HOST="${1:-mqtt2matter}"
REMOTE_DIR="${REMOTE_DIR:-/usr/local/lib/node_modules/$PKG}"
REMOTE_TMP="${REMOTE_TMP:-/tmp}"
INSTALL="${INSTALL:-0}"
MQTT_URL="${MQTT_URL:-}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command '$1' not found." >&2
    exit 1
  fi
}

require_cmd npm
require_cmd node
require_cmd scp
require_cmd ssh

# load the ssh key into an agent if keychain is installed (non-interactive deploys from WSL)
if command -v keychain >/dev/null 2>&1 && [[ -f ~/.ssh/id_ed25519 ]]; then
  keychain -q --nogui ~/.ssh/id_ed25519
  # shellcheck disable=SC1090
  source ~/.keychain/"$(hostname)-sh"
fi

cd "$(dirname "$0")"

# "engines": {"node": ">=22.13"} — the only form this script checks
NODE_MIN="$(node -p 'require("./package.json").engines.node')"
if [[ ! "$NODE_MIN" =~ ^\>=([0-9]+)(\.([0-9]+))?(\.[0-9]+)?$ ]]; then
  echo "Error: cannot check engines.node \"$NODE_MIN\" (expected >=<major>.<minor>)." >&2
  exit 1
fi
NODE_MIN="${BASH_REMATCH[1]}.${BASH_REMATCH[3]:-0}"

echo "Checking node on ${REMOTE_HOST} (needs >= ${NODE_MIN})..."
# shellcheck disable=SC2087 # NODE_MIN is expanded here on purpose
if ! ssh "$REMOTE_HOST" "NODE_MIN='$NODE_MIN' bash -s" <<'EOF'
set -euo pipefail
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Error: node and npm are not installed on $(hostname)." >&2
  exit 1
fi
if ! node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  const [needMajor, needMinor] = process.argv[1].split(".").map(Number);
  process.exit(major > needMajor || (major === needMajor && minor >= needMinor) ? 0 : 1);
' "$NODE_MIN"; then
  echo "Error: node $(node --version) on $(hostname) is too old; mqtt2matter needs >= $NODE_MIN." >&2
  exit 1
fi
if [[ "$(id -u)" != "0" ]] && ! command -v sudo >/dev/null 2>&1; then
  echo "Error: not root on $(hostname) and no sudo." >&2
  exit 1
fi
EOF
then
  exit 1
fi

if [[ "${SKIP_TESTS:-0}" != "1" ]]; then
  echo "Running lint, typecheck and tests..."
  npm run --silent lint
  npm run --silent typecheck
  npm test --silent
fi

TGZ_FILE=""
cleanup() {
  if [[ -n "$TGZ_FILE" ]]; then
    rm -f "$TGZ_FILE"
  fi
}
trap cleanup EXIT

# npm pack runs the prepack script: the server (dist/) and the UI (ui/dist/) are built fresh
echo "Building and packing..."
TGZ_FILE="$(npm pack --silent | tail -n 1)"
if [[ ! -f "$TGZ_FILE" ]]; then
  echo "Error: npm pack did not produce a tarball." >&2
  exit 1
fi
echo "Created tarball: $TGZ_FILE"

# the lock file travels along so the host installs the dependency versions that were tested
REMOTE_TGZ="${REMOTE_TMP}/$(basename "$TGZ_FILE")"
REMOTE_LOCK="${REMOTE_TMP}/${PKG}-package-lock.json"
echo "Copying to ${REMOTE_HOST}:${REMOTE_TMP}/..."
scp -q "$TGZ_FILE" "${REMOTE_HOST}:${REMOTE_TGZ}"
scp -q package-lock.json "${REMOTE_HOST}:${REMOTE_LOCK}"

echo "Installing on ${REMOTE_HOST}..."
# shellcheck disable=SC2087 # the variables are passed on the remote command line
ssh "$REMOTE_HOST" "PKG='$PKG' REMOTE_TGZ='$REMOTE_TGZ' REMOTE_LOCK='$REMOTE_LOCK' REMOTE_DIR='$REMOTE_DIR' INSTALL='$INSTALL' MQTT_URL='$MQTT_URL' bash -s" <<'EOF'
set -euo pipefail
SUDO=""
[[ "$(id -u)" == "0" ]] || SUDO="sudo"

if [[ ! -f "$REMOTE_TGZ" ]]; then
  echo "Error: remote tarball not found: $REMOTE_TGZ" >&2
  exit 1
fi

$SUDO mkdir -p "$REMOTE_DIR"
# replace the package, keep node_modules: npm install below brings it to the lock file and prunes the rest
$SUDO find "$REMOTE_DIR" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
$SUDO tar -xzf "$REMOTE_TGZ" -C "$REMOTE_DIR" --strip-components=1
$SUDO cp "$REMOTE_LOCK" "$REMOTE_DIR/package-lock.json"
$SUDO npm install --omit=dev --no-audit --no-fund --prefix "$REMOTE_DIR"
$SUDO rm -f "$REMOTE_TGZ" "$REMOTE_LOCK"
# npm install -g would create the bin link; a plain tar extract does not
$SUDO chmod +x "$REMOTE_DIR/dist/main.js"
$SUDO ln -sfn "$REMOTE_DIR/dist/main.js" "/usr/local/bin/$PKG"
echo "Installed $PKG $("/usr/local/bin/$PKG" --version) in $REMOTE_DIR"

if systemctl list-unit-files --no-legend "$PKG.service" 2>/dev/null | grep -q "^$PKG.service"; then
  # --install again: it keeps the configuration and the storage, rewrites the units this version expects
  # (the restart and update from the UI) and restarts the service
  echo "Updating the units and restarting $PKG.service"
  $SUDO "/usr/local/bin/$PKG" --install
  sleep 3
  systemctl is-active --quiet "$PKG.service" || {
    echo "Error: $PKG.service did not stay up:" >&2
    $SUDO journalctl -u "$PKG.service" -n 30 --no-pager >&2
    exit 1
  }
elif [[ "$INSTALL" == "1" ]]; then
  $SUDO "/usr/local/bin/$PKG" --install ${MQTT_URL:+--mqtt-url "$MQTT_URL"}
else
  echo "No $PKG.service yet: install it with  sudo $PKG --install --mqtt-url mqtt://<broker>:1883"
  echo "(or deploy again with INSTALL=1 MQTT_URL=mqtt://<broker>:1883)"
fi
EOF

echo "Deployment complete. The pairing code: ssh ${REMOTE_HOST} journalctl -u ${PKG} -n 50"
