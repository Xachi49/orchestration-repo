#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 1 ]]; then
  echo "usage: $0 <dump-file>" >&2
  exit 1
fi
: "${DATABASE_URL:?DATABASE_URL is required}"
pg_dump --format=custom --no-owner --file="$1" "$DATABASE_URL"
echo "wrote $1"
