#!/usr/bin/env bash
# SmartExit 24x7 Demo Trading Worker — Amazon Lightsail Ubuntu 24.04 LTS Setup Script
# Run as root (sudo) on a freshly provisioned ap-southeast-2 Lightsail 1 GB Ubuntu instance.
# Defaults to 24h SafeMode soak (zero order mutations).

set -euo pipefail

REPO_DIR="/opt/smartexit"
BRANCH="functional-staging"
ENV_DIR="/etc/smartexit"
ENV_FILE="${ENV_DIR}/demo-worker.env"

echo "[1/7] Creating dedicated non-root user 'smartexit'..."
id -u smartexit >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin smartexit

echo "[2/7] Installing Node.js 22 LTS..."
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v22.* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs git
fi
node -v

echo "[3/7] Preparing application directory ${REPO_DIR}..."
mkdir -p "${REPO_DIR}/storage/demo-worker"
chown -R smartexit:smartexit "${REPO_DIR}"
echo "NOTE: Sync or clone branch '${BRANCH}' into ${REPO_DIR}, then run 'npm ci --omit=dev' as smartexit."

echo "[4/7] Installing journald log retention limits..."
mkdir -p /etc/systemd/journald.conf.d
cp "${REPO_DIR}/deploy/demo-worker/journald-retention.conf" /etc/systemd/journald.conf.d/smartexit-demo-worker.conf
systemctl restart systemd-journald

echo "[5/7] Creating protected environment directory ${ENV_DIR}..."
mkdir -p "${ENV_DIR}"
chmod 750 "${ENV_DIR}"
chown root:smartexit "${ENV_DIR}"
if [[ ! -f "${ENV_FILE}" ]]; then
  cp "${REPO_DIR}/deploy/demo-worker/demo-worker.env.example" "${ENV_FILE}"
  chmod 640 "${ENV_FILE}"
  chown root:smartexit "${ENV_FILE}"
  echo "ACTION REQUIRED: Edit ${ENV_FILE} with Staging secrets before starting service."
fi

echo "[6/7] Installing systemd service unit..."
cp "${REPO_DIR}/deploy/demo-worker/smartexit-demo-worker.service" /etc/systemd/system/smartexit-demo-worker.service
systemctl daemon-reload
systemctl enable smartexit-demo-worker

echo "[7/7] Setup complete. To start 24h SafeMode soak after populating ${ENV_FILE}:"
echo "  sudo touch ${ENV_DIR}/worker-activation-approved"
echo "  sudo systemctl start smartexit-demo-worker"
echo "  sudo journalctl -u smartexit-demo-worker -f"
