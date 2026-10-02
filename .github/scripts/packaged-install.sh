#!/usr/bin/env bash
# Installs a packed appgraph tarball into a clean project pinned to one typescript version and runs
# the binary end to end. This exercises the PUBLISHED artifact against a peer the consumer chose,
# which the repo's own tests (run against the devDependency) never do.
#
#   packaged-install.sh <tarball> <typescript-version> <workdir>
set -euo pipefail

tarball="$1"
ts_version="$2"
workdir="$3"

mkdir -p "$workdir/src/routes/orders" "$workdir/src/server"
cd "$workdir"

cat > package.json <<'JSON'
{
  "name": "appgraph-consumer",
  "private": true,
  "version": "0.0.0",
  "type": "module"
}
JSON

cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src"]
}
JSON

cat > src/routes/__root.tsx <<'TSX'
import { createRootRoute, Outlet } from "@tanstack/react-router"
export const Route = createRootRoute({ component: () => <Outlet /> })
TSX

# A layout route beside its index child: the pair must map to distinct screen ids.
cat > src/routes/orders.tsx <<'TSX'
import { createFileRoute, Outlet } from "@tanstack/react-router"
export const Route = createFileRoute("/orders")({ component: OrdersLayout })
function OrdersLayout() { return <section><Outlet /></section> }
TSX

cat > src/routes/orders/index.tsx <<'TSX'
import { createFileRoute } from "@tanstack/react-router"
import { listOrders } from "@/server/orders"
export const Route = createFileRoute("/orders/")({ loader: () => listOrders(), component: () => null })
TSX

# Kebab-case server data layer: traversable by DIRECTORY rule, with no `useX` filename to lean on.
cat > src/server/orders.ts <<'TS'
import { createServerFn } from "@tanstack/react-start"
export const listOrders = createServerFn({ method: "GET" }).handler(async () => [])
TS

npm install --no-audit --no-fund "typescript@${ts_version}"
npm install --no-audit --no-fund "@tanstack/react-router@^1.100.0" "@tanstack/react-start@^1.100.0"
npm install --no-audit --no-fund "$tarball"

installed="$(node -p "require('typescript/package.json').version")"
echo "typescript resolved to ${installed}"
if [ "$installed" != "$ts_version" ]; then
  echo "expected typescript@${ts_version}, got ${installed} — a peer range or auto-install moved it"
  exit 1
fi

npx appgraph --root . --out docs/appgraph --format index
test -f docs/appgraph/appgraph.index.yaml

npx appgraph doctor --root . --json > doctor.json
node -e "const r=JSON.parse(require('node:fs').readFileSync('doctor.json','utf8')); if(r.exitCode!==0){console.error(r);process.exit(1)}"

# The layout route and its index child must not be reported as a duplicate screen.
if grep -q "duplicate-id" docs/appgraph/appgraph.index.yaml; then
  echo "a layout route and its index child were reported as duplicate screens"
  exit 1
fi

# --screen must be honest about the formats it does not restrict.
set +e
npx appgraph --root . --format index --screen /orders >screen.log 2>&1
screen_code=$?
set -e
test "$screen_code" -eq 2
grep -q -- "--screen requires --format detail" screen.log

assert_json_v2() {
  node -e "const r=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')); if(r.schemaVersion!==2){console.error('schemaVersion is not 2:',r.schemaVersion);process.exit(1)}" "$1"
}

# Query results live outside the analysed root: a file written into it changes the graph fingerprint.
results="$(mktemp -d)"

run_query() {
  local name="$1"
  shift
  echo "appgraph $*"
  npx appgraph "$@" > "${results}/${name}.json"
  assert_json_v2 "${results}/${name}.json"
}

run_query stats stats --json
run_query screens screens --json --limit 5
first_screen="$(node -p "const i=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).items; if(!i.length){process.exit(1)} i[0].id" "${results}/screens.json")"
run_query screen screen "$first_screen" --json
run_query stats-cached stats --cached --json

ts_dir="node_modules/typescript"
ts_aside="node_modules/.typescript-aside"
restore_typescript() {
  if [ -d "$ts_aside" ] && [ ! -e "$ts_dir" ]; then
    mv "$ts_aside" "$ts_dir"
  fi
}
trap restore_typescript EXIT

mv "$ts_dir" "$ts_aside"
run_query stats-cached-no-ts stats --cached --json
restore_typescript
test -d "$ts_dir"

echo "packaged install OK on typescript@${installed}"
