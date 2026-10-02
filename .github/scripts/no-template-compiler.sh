#!/usr/bin/env bash
# A template framework's compiler is an OPTIONAL peer: when the consumer declares the framework but has
# not installed it, the binary must degrade to one diagnostic and still map the screens, never crash.
#
#   no-template-compiler.sh <framework> <tarball> <typescript-version> <workdir>
set -euo pipefail

framework="$1"
tarball="$2"
ts_version="$3"
workdir="$4"

write_vue_fixture() {
  mkdir -p src/views

  cat > package.json <<'JSON'
{
  "name": "appgraph-consumer-vue",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "dependencies": { "vue": "^3.5.0", "vue-router": "^4.5.0" }
}
JSON

  cat > src/router.ts <<'TS'
import { createRouter, createWebHistory } from "vue-router"
import About from "./views/About.vue"

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: () => import("./views/Home.vue") },
    { path: "/about", component: About },
  ],
})
TS

  cat > src/views/Home.vue <<'VUE'
<template>
  <main data-testid="home"><router-link to="/about">About</router-link></main>
</template>
VUE

  cat > src/views/About.vue <<'VUE'
<template>
  <section data-testid="about"><h1>About</h1></section>
</template>
VUE
}

write_angular_fixture() {
  mkdir -p src/app

  cat > package.json <<'JSON'
{
  "name": "appgraph-consumer-angular",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "dependencies": { "@angular/core": "^20.0.0", "@angular/router": "^20.0.0" }
}
JSON

  cat > tsconfig.json <<'JSON'
{
  "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler", "strict": true, "experimentalDecorators": true },
  "include": ["src"]
}
JSON

  cat > src/main.ts <<'TS'
import { bootstrapApplication } from "@angular/platform-browser"
import { provideRouter } from "@angular/router"
import { AppComponent } from "./app/app.component"
import { routes } from "./app/app.routes"

bootstrapApplication(AppComponent, { providers: [provideRouter(routes)] })
TS

  cat > src/app/app.routes.ts <<'TS'
import type { Routes } from "@angular/router"
import { AboutComponent } from "./about.component"
import { HomeComponent } from "./home.component"

export const routes: Routes = [
  { path: "", component: HomeComponent },
  { path: "about", component: AboutComponent },
]
TS

  cat > src/app/app.component.ts <<'TS'
import { Component } from "@angular/core"
import { RouterOutlet } from "@angular/router"

@Component({ selector: "app-root", imports: [RouterOutlet], templateUrl: "./app.component.html" })
export class AppComponent {}
TS

  cat > src/app/app.component.html <<'HTML'
<router-outlet></router-outlet>
HTML

  cat > src/app/home.component.ts <<'TS'
import { Component } from "@angular/core"

@Component({ selector: "app-home", template: `<main data-testid="home">Home</main>` })
export class HomeComponent {}
TS

  cat > src/app/about.component.ts <<'TS'
import { Component } from "@angular/core"

@Component({ selector: "app-about", template: `<section data-testid="about"><h1>About</h1></section>` })
export class AboutComponent {}
TS
}

case "$framework" in
  vue)
    fixture=write_vue_fixture
    expected_code="project/template-compiler-missing"
    absent_packages=(vue @vue/compiler-sfc @vue/compiler-dom)
    forbidden_code=""
    ;;
  angular)
    fixture=write_angular_fixture
    expected_code="project/template-compiler-missing"
    absent_packages=(@angular/compiler @angular/core)
    forbidden_code="walk/no-splice-point"
    ;;
  *)
    echo "unknown framework '$framework' (supported: vue, angular)"
    exit 2
    ;;
esac

mkdir -p "$workdir"
cd "$workdir"

cat > tsconfig.json <<'JSON'
{
  "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler", "strict": true },
  "include": ["src"]
}
JSON

echo '{ "name": "appgraph-consumer", "private": true, "version": "0.0.0", "type": "module" }' > package.json

npm install --no-audit --no-fund "typescript@${ts_version}"
npm install --no-audit --no-fund "$tarball"

"$fixture"

for pkg in "${absent_packages[@]}"; do
  if node -e "require.resolve('${pkg}/package.json')" 2>/dev/null; then
    echo "${pkg} resolved from the project; this check needs the template compiler absent"
    exit 1
  fi
  if [ -d "node_modules/appgraph/node_modules/${pkg}" ]; then
    echo "${pkg} is nested inside the appgraph install; this check needs the template compiler absent"
    exit 1
  fi
done

set +e
npx appgraph --root . --out docs/appgraph --json --no-timestamp >run.json 2>run.err
code=$?
set -e

cat run.err
cat run.json
test "$code" -eq 0

if grep -Eq '^\s+at .*(:[0-9]+:[0-9]+|\(node:)' run.err; then
  echo "a stack trace reached stderr"
  exit 1
fi

CODE="$expected_code" FORBIDDEN="$forbidden_code" node -e '
const fs = require("node:fs")
const report = JSON.parse(fs.readFileSync("run.json", "utf8"))
const missing = report.diagnostics.filter((d) => d.code === process.env.CODE)
const fail = (message) => { console.error(message); process.exit(1) }
if (report.exitCode !== 0) fail("exitCode " + report.exitCode)
if (missing.length !== 1) fail("expected exactly one " + process.env.CODE + ", got " + missing.length)
const forbidden = process.env.FORBIDDEN ? report.diagnostics.filter((d) => d.code === process.env.FORBIDDEN) : []
if (forbidden.length > 0) fail("unexpected " + process.env.FORBIDDEN + " x" + forbidden.length)
if (!(report.counts.screens > 0)) fail("expected screens > 0, got " + JSON.stringify(report.counts))
'

echo "no-template-compiler (${framework}) OK"
