#!/usr/bin/env bash
# Builds the preview and deploys it to Azure App Service (Linux, Node).
#
#   scripts/azure-deploy.sh            build + deploy code only
#   scripts/azure-deploy.sh --setup    first run: create resources, push settings, then deploy
#
# Needs the Azure CLI, logged in (`az login`). Override names with env vars:
#   AZ_RG, AZ_APP, AZ_PLAN, AZ_LOCATION, AZ_SKU
#
# Secrets go to App Service application settings, never into the zip: `next build`
# copies .env into .next/standalone, so it is deleted before packaging.
set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

RG=${AZ_RG:-overflow-mp-rg}
APP=${AZ_APP:-overflow-mp-preview}   # must be globally unique: <APP>.azurewebsites.net
PLAN=${AZ_PLAN:-overflow-mp-plan}
LOCATION=${AZ_LOCATION:-northcentralus}
SKU=${AZ_SKU:-B1}
RUNTIME='NODE:24-lts'

command -v az >/dev/null || { echo "Azure CLI not found — brew install azure-cli" >&2; exit 1; }
az account show >/dev/null 2>&1 || { echo "Not logged in — run: az login" >&2; exit 1; }

if [ "${1:-}" = "--setup" ]; then
  [ -f .env ] || { echo "Missing .env — settings are pushed from it." >&2; exit 1; }

  # A subscription that has never hosted a web app has App Service unregistered.
  az provider register -n Microsoft.Web --wait -o none
  az group create -n "$RG" -l "$LOCATION" -o none
  az appservice plan create -g "$RG" -n "$PLAN" --is-linux --sku "$SKU" -o none
  az webapp create -g "$RG" -p "$PLAN" -n "$APP" --runtime "$RUNTIME" -o none
  az webapp update -g "$RG" -n "$APP" --https-only true -o none
  az webapp config set -g "$RG" -n "$APP" --startup-file 'sh startup.sh' \
    --always-on true --min-tls-version 1.2 --ftps-state Disabled -o none

  # Settings go through a temp file, not argv, so secrets stay out of `ps`.
  # Parsed without sourcing .env, as in verify-mp.sh: secrets contain shell metacharacters.
  settings=$(mktemp)
  trap 'rm -f "$settings"' EXIT
  node -e '
    const fs = require("fs");
    const out = { SCM_DO_BUILD_DURING_DEPLOYMENT: "false" };
    for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const k = t.slice(0, t.indexOf("=")).trim();
      let v = t.slice(t.indexOf("=") + 1).trim();
      if (/^(".*"|'"'"'.*'"'"')$/.test(v)) v = v.slice(1, -1);
      out[k] = v;
    }
    fs.writeFileSync(process.argv[1], JSON.stringify(out));
  ' "$settings"
  az webapp config appsettings set -g "$RG" -n "$APP" --settings "@$settings" -o none

  if ! grep -q '^PREVIEW_PASSWORD=' .env; then
    echo
    echo "PREVIEW_PASSWORD is not in .env, so the site will be LOCKED (503) until you set it:"
    echo "  Portal → $APP → Settings → Environment variables → add PREVIEW_PASSWORD"
  fi
fi

npm run build

out=.next/standalone
rm -f "$out/.env" "$out/.env.local"
cp -r public "$out/"
cp -r .next/static "$out/.next/"
# App Service sets HOSTNAME to the container name; Next's server binds to it.
printf '#!/bin/sh\nexport HOSTNAME=0.0.0.0\nexec node server.js\n' > "$out/startup.sh"

zip=$(mktemp -d)/app.zip
(cd "$out" && zip -qr "$zip" .)
if unzip -l "$zip" | grep -qE '(^|/)\.env'; then
  echo "Refusing to deploy: an .env file ended up in the package." >&2; exit 1
fi

# The CLI's status poll often reports HTTP 502 while the container restarts, even
# after a good deploy, so the site itself decides success: a locked gate (401).
az webapp deploy -g "$RG" -n "$APP" --src-path "$zip" --type zip -o none ||
  echo "az reported a deploy error; checking the site itself..." >&2
rm -f "$zip"

url="https://$APP.azurewebsites.net"
for _ in $(seq 1 12); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "$url/")" = 401 ] &&
    { echo "Deployed: $url"; exit 0; }
  sleep 15
done
echo "Site did not come up behind the gate. Logs: az webapp log tail -g $RG -n $APP" >&2
exit 1
