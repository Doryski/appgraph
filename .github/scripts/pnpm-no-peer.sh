#!/usr/bin/env bash
# With pnpm's `auto-install-peers=false` setting, `pnpm add appgraph` leaves `typescript` absent.
# The binary must then say what to install; a bare `Cannot find package 'typescript'` is not a fix.
#
#   pnpm-no-peer.sh <tarball> <workdir>
set -euo pipefail

tarball="$1"
workdir="$2"

mkdir -p "$workdir/src"
cd "$workdir"

cat > package.json <<'JSON'
{ "name": "appgraph-consumer-pnpm", "private": true, "version": "0.0.0", "type": "module" }
JSON

cat > tsconfig.json <<'JSON'
{ "compilerOptions": { "target": "ES2022", "module": "ESNext" }, "include": ["src"] }
JSON

echo 'export const noop = () => null' > src/index.ts

pnpm add --ignore-scripts --config.auto-install-peers=false "$tarball"

if node -e "require.resolve('typescript')" 2>/dev/null; then
  echo "typescript resolved after all — this check needs a package manager that skips peers"
  exit 1
fi

set +e
./node_modules/.bin/appgraph --root . >guard.log 2>&1
code=$?
set -e

cat guard.log
test "$code" -eq 5
grep -q "required peer dependency" guard.log
grep -q "do not auto-install peer dependencies" guard.log
grep -q 'pnpm add -D "typescript@>=5.0.0 <7.0.0"' guard.log

echo "pnpm no-peer guard OK"
