#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 2 ]]; then
  echo "usage: $0 <dump-file> <target-database-url>" >&2
  exit 1
fi
pg_restore --no-owner --dbname="$2" "$1"
echo "restored $1 into $2"
