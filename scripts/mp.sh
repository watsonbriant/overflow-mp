#!/usr/bin/env bash
# Reusable read helper:  ./scripts/mp.sh '/tables/Donations?$top=1'
# Read-only by design — refuses anything but GET.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

[ $# -ge 1 ] || { echo "usage: mp.sh '<api-path>'" >&2; exit 1; }

MP_DOMAIN= MP_CLIENT_ID= MP_CLIENT_SECRET=
while IFS= read -r line || [ -n "$line" ]; do
  line=${line%$'\r'}
  case "$line" in ''|'#'*) continue ;; *'='*) ;; *) continue ;; esac
  key=${line%%=*}; val=${line#*=}
  case "$val" in \"*\") val=${val#\"}; val=${val%\"} ;; \'*\') val=${val#\'}; val=${val%\'} ;; esac
  case "$key" in
    MP_DOMAIN) MP_DOMAIN=$val ;; MP_CLIENT_ID) MP_CLIENT_ID=$val ;; MP_CLIENT_SECRET) MP_CLIENT_SECRET=$val ;;
  esac
done < .env

MP_BASE="https://${MP_DOMAIN}/ministryplatformapi"

TOKEN=$(curl -sS -X POST "${MP_BASE}/oauth/connect/token" \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode "client_id=${MP_CLIENT_ID}" \
  --data-urlencode "client_secret=${MP_CLIENT_SECRET}" \
  --data-urlencode 'scope=http://www.thinkministry.com/dataplatform/scopes/all' \
  | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("access_token",""))
except Exception: print("")')

[ -n "$TOKEN" ] || { echo "✗ token request failed" >&2; exit 1; }

curl -sS -H "Authorization: Bearer ${TOKEN}" -H 'Accept: application/json' \
  "${MP_BASE}$1" | python3 -m json.tool 2>/dev/null || true
