#!/usr/bin/env bash
# Reusable Overflow read helper:  ./scripts/of.sh '/api/v3/campaigns'
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

[ $# -ge 1 ] || { echo "usage: of.sh '<api-path>'" >&2; exit 1; }

OVERFLOW_BASE= OVERFLOW_CLIENT_ID= OVERFLOW_API_KEY=
while IFS= read -r line || [ -n "$line" ]; do
  line=${line%$'\r'}
  case "$line" in ''|'#'*) continue ;; *'='*) ;; *) continue ;; esac
  key=${line%%=*}; val=${line#*=}
  case "$val" in \"*\") val=${val#\"}; val=${val%\"} ;; \'*\') val=${val#\'}; val=${val%\'} ;; esac
  case "$key" in
    OVERFLOW_BASE)      OVERFLOW_BASE=$val ;;
    OVERFLOW_CLIENT_ID) OVERFLOW_CLIENT_ID=$val ;;
    OVERFLOW_API_KEY)   OVERFLOW_API_KEY=$val ;;
  esac
done < .env

[ -n "$OVERFLOW_CLIENT_ID" ] || { echo "OVERFLOW_CLIENT_ID is empty in .env" >&2; exit 1; }
[ -n "$OVERFLOW_API_KEY" ]   || { echo "OVERFLOW_API_KEY is empty in .env" >&2; exit 1; }

RESP=$(curl -sS -w $'\n%{http_code}' \
  -H "x-client-id: ${OVERFLOW_CLIENT_ID}" \
  -H "x-api-key: ${OVERFLOW_API_KEY}" \
  -H 'Accept: application/json' \
  "${OVERFLOW_BASE}$1")

CODE=$(printf '%s' "$RESP" | tail -n1)
BODY=$(printf '%s' "$RESP" | sed '$d')

printf '[HTTP %s]  %s\n' "$CODE" "$1"
printf '%s' "$BODY" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$BODY"
