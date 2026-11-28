#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
case "${1:-}" in
  "") exec docker compose up -d hub ;;
  --with-node) docker compose --profile node up -d hub node ;;
  *) echo 'usage: install.sh [--with-node]' >&2; exit 2 ;;
esac
# The Node shares the Hub network namespace. Pairing can use loopback HTTP
# without trusting a private network address or writing a ticket into .env.
if [[ -t 0 ]]; then
  read -rsp 'One-time Hub workstation code (Enter to pair later): ' pair_code
  echo
else
  IFS= read -r pair_code || pair_code=""
fi
if [[ -n "$pair_code" ]]; then
  # Wait for the running Node's local management socket before consuming the
  # one-time code. A cold volume may still be initializing its database.
  ready_by=$((SECONDS + 30))
  until docker compose exec -T node lever remote status --json >/dev/null 2>&1; do
    if (( SECONDS >= ready_by )); then
      echo 'Node did not become ready. Check docker compose logs node and retry pairing.' >&2
      exit 1
    fi
    sleep 1
  done
  hub_domain=$(docker compose config --environment | sed -n 's/^LEVER_HUB_DOMAIN=//p')
  pair_origin=http://127.0.0.1:8090
  if [[ -n "$hub_domain" ]]; then pair_origin="https://$hub_domain"; fi
  printf '%s\n' "$pair_code" | docker compose exec -T node lever remote pair --hub "$pair_origin" --code-stdin --role workstation --access admin --expose-all
fi
