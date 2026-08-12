#!/usr/bin/env bash
# Verifies the MinistryPlatform API client + Overflow Integration security role.
# Read-only: every call is a GET. Nothing is created or modified.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

[ -f .env ] || { echo "Missing .env — copy .env.example to .env and fill it in." >&2; exit 1; }

# Parse .env without sourcing it: secrets routinely contain ; ( ) & $ ` which
# the shell would otherwise interpret. Values may be bare or quoted.
MP_DOMAIN= MP_CLIENT_ID= MP_CLIENT_SECRET=
while IFS= read -r line || [ -n "$line" ]; do
  line=${line%$'\r'}
  case "$line" in ''|'#'*) continue ;; *'='*) ;; *) continue ;; esac
  key=${line%%=*}; val=${line#*=}
  case "$val" in
    \"*\") val=${val#\"}; val=${val%\"} ;;
    \'*\') val=${val#\'}; val=${val%\'} ;;
  esac
  case "$key" in
    MP_DOMAIN)        MP_DOMAIN=$val ;;
    MP_CLIENT_ID)     MP_CLIENT_ID=$val ;;
    MP_CLIENT_SECRET) MP_CLIENT_SECRET=$val ;;
  esac
done < .env

[ -n "$MP_CLIENT_SECRET" ] || { echo "MP_CLIENT_SECRET is empty in .env" >&2; exit 1; }
case "$MP_CLIENT_SECRET" in PASTE_*) echo "MP_CLIENT_SECRET still has the placeholder value." >&2; exit 1 ;; esac

MP_BASE="https://${MP_DOMAIN}/ministryplatformapi"

# --- token ---------------------------------------------------------------
# --data-urlencode, not -d: the secret can contain / ; ^ ~ which must be encoded.
echo "→ Requesting token from ${MP_DOMAIN}"
RESP=$(curl -sS -X POST "${MP_BASE}/oauth/connect/token" \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode "client_id=${MP_CLIENT_ID}" \
  --data-urlencode "client_secret=${MP_CLIENT_SECRET}" \
  --data-urlencode 'scope=http://www.thinkministry.com/dataplatform/scopes/all')

TOKEN=$(printf '%s' "$RESP" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("access_token",""))
except Exception: print("")' 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "✗ Token request failed. Raw response:" >&2
  printf '%s\n' "$RESP" >&2
  exit 1
fi
echo "✓ Token acquired (${#TOKEN} chars)"

# --- probes --------------------------------------------------------------
probe () {
  local label="$1" path="$2" body code
  body=$(curl -sS -w $'\n%{http_code}' -H "Authorization: Bearer ${TOKEN}" \
          -H 'Accept: application/json' "${MP_BASE}${path}")
  code=$(printf '%s' "$body" | tail -n1)
  body=$(printf '%s' "$body" | sed '$d')
  printf '\n── %s  [HTTP %s]\n' "$label" "$code"
  printf '%s' "$body" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$body"
}

probe "Payment types in use" \
  '/tables/Donations?$select=Payment_Type_ID,Payment_Type_ID_Table.Payment_Type&$distinct=true'

probe "Campuses (Congregations)" \
  '/tables/Congregations?$select=Congregation_ID,Congregation_Name&$orderby=Congregation_Name'

probe "Active programs (funds)" \
  '/tables/Programs?$select=Program_ID,Program_Name,Congregation_ID&$top=50&$orderby=Program_Name'

probe "Donation shape (1 row)" '/tables/Donations?$top=1'
probe "Batch shape (1 row)"    '/tables/Batches?$top=1'

echo
echo "Done. 200 = permission granted; 403 = that page needs adjusting in the role."
