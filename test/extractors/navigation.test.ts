import { describe, expect, it } from "vitest"
import { createNavigationExtractor } from "../../src/extractors/navigation.js"
import type { UnresolvedNavigation } from "../../src/extractors/navigation.js"
import type { Navigation } from "../../src/core/model.js"
import { ROOT, localModules, parse, run, runVue, valuesOf } from "./harness.js"
import ts from "typescript"
import { ANGULAR_TEMPLATE_TAGS } from "../../src/core/angular-compiler.js"
import type { TemplateAttribute, TemplateDoc, TemplateElement, TemplateExpression } from "../../src/core/template-doc.js"
import { createExtractContext, createRegistry } from "../../src/extractors/registry.js"
import type { ExtractionResult } from "../../src/extractors/registry.js"

const extractor = createNavigationExtractor()

const navigations = (code: string): readonly Navigation[] =>
  valuesOf(run([extractor], code), "navigations")

const unresolved = (code: string): readonly UnresolvedNavigation[] =>
  valuesOf(run([extractor], code), "unresolvedNavigations") as readonly UnresolvedNavigation[]

describe("navigation — aliased and renamed navigate", () => {
  it("finds a RENAMED navigate: `const go = useNavigate()`", () => {
    expect(
      navigations(
        ["import { useNavigate } from 'react-router-dom'", "const go = useNavigate()", "go('/orders')"].join("\n"),
      ),
    ).toEqual([{ to: "/orders", trigger: "navigate", dynamic: false }])
  })

  it("finds an ALIASED import: `import { useNavigate as useNav }`", () => {
    expect(
      navigations(
        [
          "import { useNavigate as useNav } from 'react-router'",
          "const go = useNav()",
          "go('/orders')",
        ].join("\n"),
      ),
    ).toHaveLength(1)
  })

  it("does NOT match an unrelated local function called `navigate`", () => {
    expect(
      navigations(["const navigate = (to) => console.log(to)", "navigate('/orders')"].join("\n")),
    ).toEqual([])
  })

  it("does NOT match a bare unbound identifier called `navigate`", () => {
    expect(navigations("navigate('/orders')")).toEqual([])
  })
})

describe("navigation — react-router", () => {
  it("reads <Link to>, <NavLink to> and <Navigate to> with distinct triggers", () => {
    const code = [
      "import { Link, NavLink, Navigate } from 'react-router-dom'",
      "export const Nav = () => (",
      "  <div>",
      "    <Link to='/orders'>Orders</Link>",
      "    <NavLink to='/clients' />",
      "    <Navigate to='/login' />",
      "  </div>",
      ")",
    ].join("\n")

    expect(navigations(code)).toEqual([
      { to: "/orders", trigger: "link", dynamic: false },
      { to: "/clients", trigger: "link", dynamic: false },
      { to: "/login", trigger: "redirect", dynamic: false },
    ])
  })

  it("follows an aliased Link import back to its imported name", () => {
    const code = [
      "import { Link as RouterLink } from 'react-router-dom'",
      "export const A = () => <RouterLink to='/orders' />",
    ].join("\n")

    expect(navigations(code)).toEqual([{ to: "/orders", trigger: "link", dynamic: false }])
  })
})

describe("navigation — react-router v5", () => {
  it("reads push and replace on a useHistory() result", () => {
    const code = [
      "import { useHistory } from 'react-router-dom'",
      "const history = useHistory()",
      "history.push('/orders')",
      "history.replace('/login')",
    ].join("\n")

    expect(navigations(code)).toEqual([
      { to: "/orders", trigger: "navigate", dynamic: false },
      { to: "/login", trigger: "replace", dynamic: false },
    ])
  })

  it("reads <Redirect to> as a redirect and ignores `from`", () => {
    const code = [
      "import { Redirect } from 'react-router-dom'",
      "export const R = () => <Redirect from='/old' to='/new' />",
    ].join("\n")

    expect(navigations(code)).toEqual([{ to: "/new", trigger: "redirect", dynamic: false }])
  })

  it("does NOT treat react-router's useLocation() as a navigator", () => {
    const code = [
      "import { useLocation } from 'react-router-dom'",
      "const location = useLocation()",
      "const [a, b] = useLocation()",
      "b('/orders')",
      "location('/clients')",
    ].join("\n")

    expect(navigations(code)).toEqual([])
  })
})

describe("navigation — wouter", () => {
  it("navigates through element 1 of the useLocation() tuple", () => {
    const code = [
      "import { useLocation } from 'wouter'",
      "const [, navigate] = useLocation()",
      "navigate('/orders')",
    ].join("\n")

    expect(navigations(code)).toEqual([{ to: "/orders", trigger: "navigate", dynamic: false }])
  })

  it("names the setter freely and covers wouter/preact, but never element 0", () => {
    const code = [
      "import { useLocation } from 'wouter/preact'",
      "const [location, setLocation] = useLocation()",
      "setLocation('/clients')",
      "location('/never')",
    ].join("\n")

    expect(navigations(code)).toEqual([{ to: "/clients", trigger: "navigate", dynamic: false }])
  })

  it("reads an imported navigate from wouter/use-browser-location", () => {
    const code = ["import { navigate as go } from 'wouter/use-browser-location'", "go('/orders')"].join("\n")
    expect(navigations(code)).toEqual([{ to: "/orders", trigger: "navigate", dynamic: false }])
  })

  it("ignores a navigate imported from an unrelated module", () => {
    expect(navigations(["import { navigate } from './nav'", "navigate('/orders')"].join("\n"))).toEqual([])
  })

  it("reads <Link href> and <Redirect to>", () => {
    const code = [
      "import { Link, Redirect } from 'wouter'",
      "export const A = () => (",
      "  <div>",
      "    <Link href='/orders'>Orders</Link>",
      "    <Redirect to='/login' />",
      "  </div>",
      ")",
    ].join("\n")

    expect(navigations(code)).toEqual([
      { to: "/orders", trigger: "link", dynamic: false },
      { to: "/login", trigger: "redirect", dynamic: false },
    ])
  })
})

describe("navigation — Next", () => {
  it("reads useRouter().push and .replace with distinct triggers", () => {
    const code = [
      "import { useRouter } from 'next/navigation'",
      "const router = useRouter()",
      "router.push('/orders')",
      "router.replace('/login')",
    ].join("\n")

    expect(navigations(code)).toEqual([
      { to: "/orders", trigger: "navigate", dynamic: false },
      { to: "/login", trigger: "replace", dynamic: false },
    ])
  })

  it("reads a destructured router: `const { push } = useRouter()`", () => {
    expect(
      navigations(
        ["import { useRouter } from 'next/navigation'", "const { push } = useRouter()", "push('/orders')"].join(
          "\n",
        ),
      ),
    ).toEqual([{ to: "/orders", trigger: "navigate", dynamic: false }])
  })

  it("reads redirect() and permanentRedirect() from next/navigation", () => {
    const code = [
      "import { redirect, permanentRedirect } from 'next/navigation'",
      "redirect('/login')",
      "permanentRedirect('/moved')",
    ].join("\n")

    expect(navigations(code)).toEqual([
      { to: "/login", trigger: "redirect", dynamic: false },
      { to: "/moved", trigger: "redirect", dynamic: false },
    ])
  })

  it("reads <Link href> from next/link", () => {
    expect(
      navigations(["import Link from 'next/link'", "export const A = () => <Link href='/orders' />"].join("\n")),
    ).toEqual([{ to: "/orders", trigger: "link", dynamic: false }])
  })

  it("ignores router.back() and router.prefetch()", () => {
    expect(
      navigations(
        ["import { useRouter } from 'next/navigation'", "const r = useRouter()", "r.back()", "r.prefetch('/x')"].join(
          "\n",
        ),
      ),
    ).toEqual([])
  })
})

describe("navigation — TanStack Router", () => {
  it("reads useNavigate({ to })", () => {
    expect(
      navigations(
        [
          "import { useNavigate } from '@tanstack/react-router'",
          "const navigate = useNavigate()",
          "navigate({ to: '/orders/$id', params: { id } })",
        ].join("\n"),
      ),
    ).toEqual([{ to: "/orders/$id", trigger: "navigate", dynamic: false }])
  })

  it("reads redirect({ to }) and <Link to>", () => {
    const code = [
      "import { redirect, Link } from '@tanstack/react-router'",
      "const guard = () => redirect({ to: '/login' })",
      "export const A = () => <Link to='/orders' />",
    ].join("\n")

    expect(navigations(code)).toEqual([
      { to: "/login", trigger: "redirect", dynamic: false },
      { to: "/orders", trigger: "link", dynamic: false },
    ])
  })
})

describe("navigation — intrinsic anchors in JSX", () => {
  it.each([
    ["a string literal", `<a href="/x" />`],
    ["a braced string", `<a href={"/x"} />`],
  ])("reads %s href as a link", (_label, jsx) => {
    expect(navigations(`export const View = () => ${jsx}`)).toEqual([{ to: "/x", trigger: "link", dynamic: false }])
  })

  it("keeps a template-literal href dynamic", () => {
    expect(navigations("export const View = ({ id }) => <a href={`/items/${id}`} />")).toEqual([
      { to: "/items/:param", trigger: "link", dynamic: true },
    ])
  })

  it.each([
    ["an https url", `<a href="https://e.com" />`],
    ["a mailto url", `<a href="mailto:a@b.c" />`],
    ["a tel url", `<a href="tel:1" />`],
    ["a javascript url", `<a href="javascript:void(0)" />`],
    ["a fragment", `<a href="#top" />`],
    ["a protocol-relative url", `<a href="//cdn.x/y" />`],
    ["an empty href", `<a href="" />`],
    ["a whitespace href", `<a href="  " />`],
    ["a download anchor", `<a href="/x" download />`],
  ])("drops %s silently", (_label, jsx) => {
    const code = `export const View = () => ${jsx}`
    expect(navigations(code)).toEqual([])
    expect(unresolved(code)).toEqual([])
  })

  it.each([
    ["an imported binding named a", ["import a from './A'", `export const View = () => <a href="/x" />`]],
    ["a const binding named a", ["const a = Comp", `export const View = () => <a href="/x" />`]],
  ])("does not read %s as an intrinsic anchor", (_label, lines) => {
    const code = lines.join("\n")
    expect(navigations(code)).toEqual([])
    expect(unresolved(code)).toEqual([])
  })

  it("records an unresolvable href expression as unresolved", () => {
    const code = "export const View = ({ url }) => <a href={url} />"
    expect(navigations(code)).toEqual([])
    expect(unresolved(code)).toHaveLength(1)
    expect(unresolved(code)[0]).toMatchObject({ expr: "{url}", trigger: "link" })
  })
})

describe("navigation — nothing is dropped", () => {
  it("records an unflattenable target as unresolved-with-expression-text", () => {
    const code = [
      "import { useNavigate } from 'react-router-dom'",
      "const go = useNavigate()",
      "go(computeTarget(order))",
    ].join("\n")

    expect(navigations(code)).toEqual([])
    expect(unresolved(code)).toEqual([
      {
        expr: "computeTarget(order)",
        trigger: "navigate",
        file: "src/File.tsx",
        line: 3,
        truncated: false,
      },
    ])
  })

  it("records a non-path target (external url, history delta) as unresolved rather than a fake route", () => {
    const code = [
      "import { useNavigate } from 'react-router-dom'",
      "const go = useNavigate()",
      "go(-1)",
      "go('https://example.com/docs')",
    ].join("\n")

    expect(navigations(code)).toEqual([])
    expect(unresolved(code).map((entry) => entry.expr)).toEqual(["-1", "'https://example.com/docs'"])
  })

  it("flags a target whose expression text had to be truncated", () => {
    const long = `computeTarget(${"a".repeat(140)})`
    const code = [
      "import { useNavigate } from 'react-router-dom'",
      "const go = useNavigate()",
      `go(${long})`,
    ].join("\n")

    const entry = unresolved(code)[0]
    expect(entry?.truncated).toBe(true)
    expect(entry?.expr).toHaveLength(110)
  })

  it("marks a template-built target dynamic and keeps the :param placeholder", () => {
    expect(
      navigations(
        [
          "import { useNavigate } from 'react-router-dom'",
          "const go = useNavigate()",
          "go(`/orders/${id}`)",
        ].join("\n"),
      ),
    ).toEqual([{ to: "/orders/:param", trigger: "navigate", dynamic: true }])
  })
})

describe("navigation — normalization and dedupe", () => {
  it("routes every target through the injected normalizeUrl", () => {
    const code = [
      "import { Link } from 'react-router-dom'",
      "export const A = () => <Link to='/orders/?tab=1' />",
    ].join("\n")

    const result = run([extractor], code, { normalizeUrl: (raw) => raw.split("?")[0]?.replace(/\/$/, "") ?? raw })
    expect(valuesOf(result, "navigations")).toEqual([{ to: "/orders", trigger: "link", dynamic: false }])
  })

  it("deduplicates the same target+trigger pair", () => {
    expect(
      navigations(
        [
          "import { useNavigate } from 'react-router-dom'",
          "const go = useNavigate()",
          "go('/orders')",
          "go('/orders')",
        ].join("\n"),
      ),
    ).toHaveLength(1)
  })

  it("keeps the same target under two different triggers", () => {
    const code = [
      "import { Link, useNavigate } from 'react-router-dom'",
      "const go = useNavigate()",
      "const onClick = () => go('/orders')",
      "export const A = () => <Link to='/orders' />",
    ].join("\n")

    expect(navigations(code)).toHaveLength(2)
  })

  it("resolves a target folded from a constant declared below the call site", () => {
    expect(
      navigations(
        [
          "import { useNavigate } from 'react-router-dom'",
          "const go = useNavigate()",
          "go(ORDERS)",
          "const ORDERS = '/orders'",
        ].join("\n"),
      ),
    ).toEqual([{ to: "/orders", trigger: "navigate", dynamic: false }])
  })
})

describe("navigation — lookups into statically known literals", () => {
  const withModules = (code: string, sources: Readonly<Record<string, string>> = {}) =>
    run([extractor], code, { resolveModule: localModules, sources })

  const withExpr = (code: string, sources: Readonly<Record<string, string>> = {}): readonly Navigation[] =>
    valuesOf(withModules(code, sources), "navigations")

  const targets = (code: string, sources: Readonly<Record<string, string>> = {}): readonly Navigation[] =>
    withExpr(code, sources).map(({ to, trigger, dynamic }) => ({ to, trigger, dynamic }))

  const unresolvedOf = (code: string, sources: Readonly<Record<string, string>> = {}) =>
    valuesOf(withModules(code, sources), "unresolvedNavigations") as readonly UnresolvedNavigation[]

  it("emits every value of a same-file record indexed by a runtime key, each dynamic", () => {
    const code = [
      "import { useNavigate } from '@tanstack/react-router'",
      "const pathByTab = { dashboard: '/dashboard', members: '/members' } as const satisfies Record<Tab, string>",
      "const go = useNavigate()",
      "go({ to: pathByTab[tab] })",
    ].join("\n")

    expect(targets(code)).toEqual([
      { to: "/dashboard", trigger: "navigate", dynamic: true },
      { to: "/members", trigger: "navigate", dynamic: true },
    ])
    expect(unresolvedOf(code)).toEqual([])
  })

  it("carries the lookup expression on every edge it expands to, and never on a literal target", () => {
    const code = [
      "import { useNavigate } from '@tanstack/react-router'",
      "const pathByTab = { dashboard: '/dashboard', members: '/members' } as const",
      "const go = useNavigate()",
      "go({ to: pathByTab[tab] })",
      "go({ to: '/settings' })",
    ].join("\n")

    expect(withExpr(code).map((edge) => [edge.to, edge.expr])).toEqual(
      expect.arrayContaining([
        ["/dashboard", "pathByTab[tab]"],
        ["/members", "pathByTab[tab]"],
        ["/settings", undefined],
      ]),
    )
    expect(withExpr(code)).toHaveLength(3)
  })

  it("reads an imported record through the resolver, including Object.freeze and nested `.path`", () => {
    const code = [
      "import { Link } from 'react-router-dom'",
      "import { ROUTES } from './routes'",
      "export const A = ({ key }) => <Link to={ROUTES[key].path} />",
    ].join("\n")
    const sources = {
      [`${ROOT}/src/routes.tsx`]: [
        "const BASE = '/admin'",
        "export const ROUTES = Object.freeze({ list: { path: BASE + '/orders' }, one: { path: '/orders/new', label: 'x' } })",
      ].join("\n"),
    }

    expect(targets(code, sources).map((entry) => entry.to)).toEqual(["/admin/orders", "/orders/new"])
  })

  it("emits one edge per element of a mapped array literal, including destructured params", () => {
    const code = [
      "import { Link } from 'react-router-dom'",
      "const items = [{ to: '/a', label: 'A' }, { to: '/b', label: 'B' }, { label: 'separator' }]",
      "const more = [{ href: '/c' }]",
      "export const Nav = () => (",
      "  <nav>",
      "    {items.filter(Boolean).map((item) => <Link key={item.to} to={item.to} />)}",
      "    {more.map(({ href: target }) => <Link to={target} />)}",
      "  </nav>",
      ")",
    ].join("\n")

    expect(targets(code)).toEqual([
      { to: "/a", trigger: "link", dynamic: true },
      { to: "/b", trigger: "link", dynamic: true },
      { to: "/c", trigger: "link", dynamic: true },
    ])
  })

  it("folds an imported plain const string as a static target", () => {
    const code = ["import { Link } from 'react-router-dom'", "import { HOME } from './vars'", "<Link to={HOME} />"].join(
      "\n",
    )

    expect(targets(code, { [`${ROOT}/src/vars.tsx`]: "export const HOME = '/'" })).toEqual([
      { to: "/", trigger: "link", dynamic: false },
    ])
  })

  it("keeps a lookup unresolved when any value is not statically known", () => {
    const code = [
      "import { useNavigate } from 'react-router-dom'",
      "const paths = { a: '/a', b: buildPath('b') }",
      "const go = useNavigate()",
      "go(paths[section])",
    ].join("\n")

    expect(targets(code)).toEqual([])
    expect(unresolvedOf(code).map((entry) => entry.expr)).toEqual(["paths[section]"])
  })

  it("does not treat a runtime parameter or a `let` as a known literal", () => {
    const code = [
      "import { Link } from 'react-router-dom'",
      "let mutable = { a: '/a' }",
      "export const A = ({ to }) => <><Link to={to} /><Link to={mutable[k]} /></>",
    ].join("\n")

    expect(targets(code)).toEqual([])
    expect(unresolvedOf(code).map((entry) => entry.expr)).toEqual(["{to}", "{mutable[k]}"])
  })

  it("lets a static link to the same target win over the lookup-derived dynamic one", () => {
    const code = [
      "import { Link } from 'react-router-dom'",
      "const paths = { a: '/a', b: '/b' }",
      "export const A = () => <><Link to={paths[k]} /><Link to='/a' /></>",
    ].join("\n")

    expect(targets(code)).toEqual([
      { to: "/a", trigger: "link", dynamic: false },
      { to: "/b", trigger: "link", dynamic: true },
    ])
  })

  it("reads a shorthand `{ to }` target instead of reporting the whole object", () => {
    const code = [
      "import { useNavigate } from '@tanstack/react-router'",
      "const go = useNavigate()",
      "const goTo = (to) => go({ to })",
    ].join("\n")

    expect(unresolvedOf(code).map((entry) => entry.expr)).toEqual(["to"])
  })
})

const vueNavigations = (sfc: string): readonly Navigation[] => valuesOf(runVue([extractor], sfc), "navigations")

const vueUnresolved = (sfc: string): readonly UnresolvedNavigation[] =>
  valuesOf(runVue([extractor], sfc), "unresolvedNavigations") as readonly UnresolvedNavigation[]

describe("navigation — Vue templates", () => {
  it("reads a static <RouterLink to>", () => {
    expect(vueNavigations('<template><RouterLink to="/a">A</RouterLink></template>')).toEqual([
      { to: "/a", trigger: "link", dynamic: false },
    ])
  })

  it("reads a kebab <router-link :to> naming a route as to '' plus routeName", () => {
    expect(vueNavigations(`<template><router-link :to="{ name: 'x' }">X</router-link></template>`)).toEqual([
      { to: "", trigger: "link", dynamic: false, routeName: "x" },
    ])
  })

  it("prefers path over name in an object target", () => {
    expect(
      vueNavigations(`<template><RouterLink :to="{ name: 'x', path: '/p' }" /></template>`),
    ).toEqual([{ to: "/p", trigger: "link", dynamic: false }])
  })

  it("keeps a dynamic segment of <nuxt-link :to> as a :param", () => {
    expect(vueNavigations(`<template><nuxt-link :to="'/a/' + id">A</nuxt-link></template>`)).toEqual([
      { to: "/a/:param", trigger: "link", dynamic: true },
    ])
  })

  it("resolves a bound constant from script setup", () => {
    const sfc = [
      '<script setup lang="ts">',
      "const HOME = '/home'",
      "</script>",
      '<template><NuxtLink :to="HOME" /></template>',
    ].join("\n")
    expect(vueNavigations(sfc)).toEqual([{ to: "/home", trigger: "link", dynamic: false }])
  })

  it("records an unflattenable bound target as unresolved on the template line", () => {
    const sfc = ["<template>", "  <div>", '    <RouterLink :to="target" />', "  </div>", "</template>"].join("\n")
    expect(vueUnresolved(sfc)).toEqual([
      { expr: "target", trigger: "link", file: "src/File.vue", line: 3, truncated: false },
    ])
  })

  it("scans @click for $router.push and $router.replace", () => {
    const sfc = [
      "<template>",
      `  <button @click="$router.push('/q')">Q</button>`,
      `  <button @click="$router.replace({ path: '/r' })">R</button>`,
      "</template>",
    ].join("\n")
    expect(vueNavigations(sfc)).toEqual([
      { to: "/q", trigger: "navigate", dynamic: false },
      { to: "/r", trigger: "replace", dynamic: false },
    ])
  })

  it("scans @click for navigateTo and a script-setup router", () => {
    const sfc = [
      '<script setup lang="ts">',
      "import { useRouter } from 'vue-router'",
      "const router = useRouter()",
      "</script>",
      "<template>",
      `  <button @click="navigateTo('/n')">N</button>`,
      `  <button @click="ok && router.push('/m')">M</button>`,
      "</template>",
    ].join("\n")
    expect(vueNavigations(sfc)).toEqual([
      { to: "/n", trigger: "navigate", dynamic: false },
      { to: "/m", trigger: "navigate", dynamic: false },
    ])
  })

  it("reads a plain anchor as a link and ignores a non-navigation @click", () => {
    expect(
      vueNavigations(`<template><a href="/x">x</a><button @click="save('/y')">y</button></template>`),
    ).toEqual([{ to: "/x", trigger: "link", dynamic: false }])
  })

  it.each([
    ["a static href", `<a href="/x">x</a>`, [{ to: "/x", trigger: "link", dynamic: false }]],
    ["a bound href", `<a :href="'/x'">x</a>`, [{ to: "/x", trigger: "link", dynamic: false }]],
    ["an external href", `<a href="https://e.com">x</a>`, []],
    ["a fragment href", `<a href="#top">x</a>`, []],
    ["a download anchor", `<a href="/x" download>x</a>`, []],
  ])("reads an anchor with %s", (_label, anchor, expected) => {
    const sfc = `<template>${anchor}</template>`
    expect(vueNavigations(sfc)).toEqual(expected)
    expect(vueUnresolved(sfc)).toEqual([])
  })
})

describe("navigation — Vue and Nuxt script triggers", () => {
  it("matches an unbound global navigateTo", () => {
    expect(navigations("navigateTo('/login')")).toEqual([{ to: "/login", trigger: "navigate", dynamic: false }])
  })

  it("skips a navigateTo that is a local binding", () => {
    expect(navigations(["const navigateTo = (to) => to", "navigateTo('/login')"].join("\n"))).toEqual([])
  })

  it("matches navigateTo imported from #app", () => {
    expect(
      navigations(["import { navigateTo as go } from '#app'", "go({ path: '/x' })"].join("\n")),
    ).toEqual([{ to: "/x", trigger: "navigate", dynamic: false }])
  })

  it("matches this.$router.push({ path }) in an Options API method", () => {
    const code = [
      "export default {",
      "  methods: {",
      "    go() { this.$router.push({ path: '/p' }) },",
      "    swap() { this.$router.replace({ name: 'home' }) },",
      "  },",
      "}",
    ].join("\n")
    expect(navigations(code)).toEqual([
      { to: "/p", trigger: "navigate", dynamic: false },
      { to: "", trigger: "replace", dynamic: false, routeName: "home" },
    ])
  })

  it("matches a bare unbound $router.push but not a member named $router on another object", () => {
    expect(navigations(["$router.push('/a')", "other.$router.push('/b')"].join("\n"))).toEqual([
      { to: "/a", trigger: "navigate", dynamic: false },
    ])
  })

  it("already matches useRouter() imported from vue-router", () => {
    const code = [
      "import { useRouter } from 'vue-router'",
      "const router = useRouter()",
      "router.push('/x')",
      "router.push({ name: 'detail', params: { id: 1 } })",
    ].join("\n")
    expect(navigations(code)).toEqual([
      { to: "/x", trigger: "navigate", dynamic: false },
      { to: "", trigger: "navigate", dynamic: false, routeName: "detail" },
    ])
  })

  it("matches a script-setup router in a .vue file", () => {
    const sfc = [
      '<script setup lang="ts">',
      "import { useRouter } from 'vue-router'",
      "const router = useRouter()",
      "const go = () => router.replace('/v')",
      "</script>",
    ].join("\n")
    expect(vueNavigations(sfc)).toEqual([{ to: "/v", trigger: "replace", dynamic: false }])
  })
})

const ANGULAR_FILE = "src/app/orders.component.ts"

type AngularLink = { readonly kind: "static" | "bound"; readonly value: string }

const routerLinkElement = (link: AngularLink, index: number): TemplateElement => {
  const attribute: TemplateAttribute = {
    name: "routerLink",
    kind: link.kind,
    arg: null,
    static: link.kind === "static" ? link.value : null,
    expression: link.kind === "bound" ? link.value : null,
    pos: index * 10,
    line: index + 1,
  }
  return {
    tag: "a",
    names: ["a"],
    kind: "element",
    pos: index * 10,
    end: index * 10 + 5,
    line: index + 1,
    attributes: [attribute],
    guard: { condition: null, repeated: false, lazy: false },
    slotName: null,
  }
}

const clickExpression = (text: string, index: number): TemplateExpression => ({
  text,
  pos: index * 10,
  end: index * 10 + 5,
  line: index + 1,
  origin: "event",
  pipes: [],
})

type AngularTemplate = {
  readonly links?: readonly AngularLink[]
  readonly clicks?: readonly string[]
  readonly owner?: string
  readonly file?: string
}

const runAngular = (code: string, template: AngularTemplate = {}): ExtractionResult => {
  const doc: TemplateDoc = {
    framework: "angular",
    file: template.file ?? ANGULAR_FILE,
    owner: template.owner ?? "OrdersComponent",
    partial: false,
    elements: (template.links ?? []).map(routerLinkElement),
    expressions: (template.clicks ?? []).map(clickExpression),
    unsupported: [],
  }
  const registry = createRegistry({ extractors: [extractor] })
  return registry.run(
    createExtractContext({
      ts,
      file: ANGULAR_FILE,
      source: parse(code, ANGULAR_FILE),
      templates: [doc],
      tagsOf: () => ANGULAR_TEMPLATE_TAGS,
    }),
  )
}

const angularNavigations = (code: string, template?: AngularTemplate): readonly Navigation[] =>
  valuesOf(runAngular(code, template), "navigations")

const angularUnresolved = (code: string, template?: AngularTemplate): readonly UnresolvedNavigation[] =>
  valuesOf(runAngular(code, template), "unresolvedNavigations") as readonly UnresolvedNavigation[]

const routerComponent = (...body: readonly string[]): string =>
  [
    "import { Component, inject } from '@angular/core'",
    "import { Router } from '@angular/router'",
    "export class OrdersComponent {",
    ...body,
    "}",
  ].join("\n")

describe("navigation — Angular template routerLink", () => {
  it("reads a static routerLink", () => {
    expect(angularNavigations("", { links: [{ kind: "static", value: "/orders" }] })).toEqual([
      { to: "/orders", trigger: "link", dynamic: false },
    ])
  })

  it("joins a bound command array, keeping dynamic segments as :param", () => {
    expect(angularNavigations("", { links: [{ kind: "bound", value: "['/orders', order.id, 'edit', 2]" }] })).toEqual([
      { to: "/orders/:param/edit/2", trigger: "link", dynamic: true },
    ])
  })

  it("skips matrix-param objects inside the command array", () => {
    expect(angularNavigations("", { links: [{ kind: "bound", value: "['/orders', { page: 1 }]" }] })).toEqual([
      { to: "/orders", trigger: "link", dynamic: false },
    ])
  })

  it("flattens a bound string expression", () => {
    expect(angularNavigations("", { links: [{ kind: "bound", value: "'/orders/' + id" }] })).toEqual([
      { to: "/orders/:param", trigger: "link", dynamic: true },
    ])
  })

  it("skips relative targets and counts each as unresolved", () => {
    const template: AngularTemplate = {
      links: [
        { kind: "static", value: "edit" },
        { kind: "bound", value: "['../x']" },
        { kind: "bound", value: "['.']" },
      ],
    }
    expect(angularNavigations("", template)).toEqual([])
    expect(angularUnresolved("", template).map((entry) => entry.expr)).toEqual(['"edit"', "['../x']", "['.']"])
  })

  it("attributes an unresolved templateUrl link to the template file and its line", () => {
    const template: AngularTemplate = { file: "src/orders.component.html", links: [{ kind: "static", value: "edit" }] }
    expect(angularUnresolved("", template).map((entry) => [entry.file, entry.line])).toEqual([["src/orders.component.html", 1]])
  })

  it("reads an interpolated routerLink and counts a non-literal one as unresolved", () => {
    const template: AngularTemplate = {
      links: [
        { kind: "static", value: "{{ '/orders' }}" },
        { kind: "static", value: "{{ createLink() }}" },
      ],
    }
    expect(angularNavigations("", template).map((entry) => entry.to)).toEqual(["/orders"])
    expect(angularUnresolved("", template).map((entry) => entry.expr)).toEqual(["createLink()"])
  })

  it("ignores an empty command array", () => {
    const template: AngularTemplate = { links: [{ kind: "bound", value: "[]" }] }
    expect(angularNavigations("", template)).toEqual([])
    expect(angularUnresolved("", template)).toEqual([])
  })

  it("resolves (click) router.navigate through the owner class's Router member", () => {
    const code = routerComponent("  constructor(public router: Router) {}")
    expect(angularNavigations(code, { clicks: ["router.navigate(['/a', id])"] })).toEqual([
      { to: "/a/:param", trigger: "navigate", dynamic: true },
    ])
  })

  it("ignores (click) router.navigate when the owner class has no Router member", () => {
    const code = routerComponent("  router = { navigate: (to: unknown) => to }")
    expect(angularNavigations(code, { clicks: ["router.navigate(['/a'])"] })).toEqual([])
  })
})

const anchorElement = (attributes: readonly TemplateAttribute[], tag = "a"): TemplateElement => ({
  tag,
  names: [tag],
  kind: "element",
  pos: 0,
  end: 5,
  line: 1,
  attributes,
  guard: { condition: null, repeated: false, lazy: false },
  slotName: null,
})

const attribute = (name: string, kind: "static" | "bound", value: string): TemplateAttribute => ({
  name,
  kind,
  arg: null,
  static: kind === "static" ? value : null,
  expression: kind === "bound" ? value : null,
  pos: 0,
  line: 1,
})

const flag = (name: string): TemplateAttribute => ({ ...attribute(name, "static", ""), static: "" })

const angularAnchors = (element: TemplateElement): readonly Navigation[] => {
  const doc: TemplateDoc = {
    framework: "angular",
    file: ANGULAR_FILE,
    owner: "OrdersComponent",
    partial: false,
    elements: [element],
    expressions: [],
    unsupported: [],
  }
  const registry = createRegistry({ extractors: [extractor] })
  return valuesOf(
    registry.run(
      createExtractContext({
        ts,
        file: ANGULAR_FILE,
        source: parse("", ANGULAR_FILE),
        templates: [doc],
        tagsOf: () => ANGULAR_TEMPLATE_TAGS,
      }),
    ),
    "navigations",
  )
}

describe("navigation — Angular template anchors", () => {
  it.each([
    ["a static href", [attribute("href", "static", "/x")], [{ to: "/x", trigger: "link", dynamic: false }]],
    ["a bound href", [attribute("href", "bound", "'/x'")], [{ to: "/x", trigger: "link", dynamic: false }]],
    [
      "routerLink alongside href",
      [attribute("routerLink", "static", "/r"), attribute("href", "static", "/x")],
      [{ to: "/r", trigger: "link", dynamic: false }],
    ],
    ["an external href", [attribute("href", "static", "https://e.com")], []],
    ["a download attribute", [attribute("href", "static", "/x"), flag("download")], []],
  ])("reads an anchor with %s", (_label, attributes, expected) => {
    expect(angularAnchors(anchorElement(attributes))).toEqual(expected)
  })
})

describe("navigation — Angular script Router", () => {
  it("reads this.router.navigate with a command array on a constructor-injected Router", () => {
    const code = routerComponent(
      "  constructor(private router: Router) {}",
      "  open(id: string) { this.router.navigate(['/a', id], { replaceUrl: true }) }",
    )
    expect(navigations(code)).toEqual([{ to: "/a/:param", trigger: "navigate", dynamic: true }])
  })

  it("reads navigateByUrl with a literal and a template literal", () => {
    const code = routerComponent(
      "  constructor(private readonly router: Router) {}",
      "  home() { this.router.navigateByUrl('/x') }",
      "  item(id: string) { this.router.navigateByUrl(`/items/${id}`) }",
    )
    expect(navigations(code)).toEqual([
      { to: "/x", trigger: "navigate", dynamic: false },
      { to: "/items/:param", trigger: "navigate", dynamic: true },
    ])
  })

  it("reads navigate on an inject(Router) field", () => {
    const code = routerComponent("  private router = inject(Router)", "  go() { this.router.navigate(['/orders']) }")
    expect(navigations(code)).toEqual([{ to: "/orders", trigger: "navigate", dynamic: false }])
  })

  it("ignores navigate([], { queryParams }) with empty commands", () => {
    const code = routerComponent(
      "  constructor(private router: Router) {}",
      "  filter() { this.router.navigate([], { queryParams: { page: 2 } }) }",
    )
    expect(navigations(code)).toEqual([])
    expect(unresolved(code)).toEqual([])
  })

  it("skips a relative navigate target and counts it as unresolved", () => {
    const code = routerComponent(
      "  constructor(private router: Router) {}",
      "  up() { this.router.navigate(['../list'], { relativeTo: this.route }) }",
    )
    expect(navigations(code)).toEqual([])
    expect(unresolved(code).map((entry) => entry.expr)).toEqual(["['../list']"])
  })

  it("ignores this.router typed as a local class", () => {
    const code = [
      "class Router { navigate(commands: unknown[]) {} }",
      "export class OrdersComponent {",
      "  constructor(private router: Router) {}",
      "  go() { this.router.navigate(['/orders']) }",
      "}",
    ].join("\n")
    expect(navigations(code)).toEqual([])
    expect(unresolved(code)).toEqual([])
  })
})

describe("navigation — browser-native navigation", () => {
  it("reads the reported `window.open` template literal in an onClick as a dynamic navigation", () => {
    const code = [
      "export const Row = ({ flow }) => (",
      "  <button onClick={() => window.open(`/flow-differences/${flow.flowId}`, '_blank')}>Open</button>",
      ")",
    ].join("\n")
    expect(navigations(code)).toEqual([{ to: "/flow-differences/:param", trigger: "navigate", dynamic: true }])
  })

  it.each([
    ["window.open('/x')", "navigate"],
    ["location.assign('/x')", "navigate"],
    ["window.location.assign('/x')", "navigate"],
    ["document.location.assign('/x')", "navigate"],
    ["location.replace('/x')", "replace"],
    ["window.location.replace('/x')", "replace"],
    ["document.location.replace('/x')", "replace"],
    ["location.href = '/x'", "navigate"],
    ["window.location.href = '/x'", "navigate"],
    ["window.location = '/x'", "navigate"],
  ] as const)("reads `%s` as a %s navigation", (statement, trigger) => {
    expect(navigations(statement)).toEqual([{ to: "/x", trigger, dynamic: false }])
  })

  it.each([
    ["window.open(`/items/${id}`)", "/items/:param"],
    ["window.location.href = `/items/${id}`", "/items/:param"],
  ] as const)("marks `%s` as dynamic", (statement, to) => {
    expect(navigations(["declare const id: string", statement].join("\n"))).toEqual([
      { to, trigger: "navigate", dynamic: true },
    ])
  })

  it.each([
    ["an external https window.open", "window.open('https://example.com/x')"],
    ["an external mailto assign", "location.assign('mailto:a@b.c')"],
    ["an external https href assignment", "window.location.href = 'https://example.com'"],
    ["an external https replace", "location.replace('https://example.com')"],
    ["a shadowing const window", "const window = { open: (url: string) => url }\nwindow.open('/x')"],
    ["a shadowing location parameter", "export const go = (location: { assign(url: string): void }) => location.assign('/x')"],
    ["a shadowing location import", "import { location } from './geo'\nlocation.assign('/x')"],
    ["a shadowing location href assignment", "const location = { href: '' }\nlocation.href = '/x'"],
    ["a non-window receiver", "foo.open('/x')"],
    ["window.location.reload()", "window.location.reload()"],
    ["a non-location href assignment", "x.href = '/y'"],
    ["a compound href assignment", "window.location.href += '/y'"],
  ] as const)("ignores %s", (_label, code) => {
    expect(navigations(code)).toEqual([])
    expect(unresolved(code)).toEqual([])
  })

  it("reports an unresolvable window.open target as unresolved, not as a navigation", () => {
    const code = "declare const someVar: string\nwindow.open(someVar)"
    expect(navigations(code)).toEqual([])
    expect(unresolved(code).map((entry) => entry.expr)).toEqual(["someVar"])
  })
})

describe("navigation — Expo Router", () => {
  const expo = (...lines: readonly string[]): readonly Navigation[] =>
    navigations(["import { router, useRouter, Link, Redirect } from 'expo-router'", ...lines].join("\n"))

  it.each([
    ["push", "navigate"],
    ["replace", "replace"],
    ["navigate", "navigate"],
    ["dismissTo", "navigate"],
  ] as const)("reads the imported router singleton's %s", (method, trigger) => {
    expect(expo(`router.${method}('/settings')`)).toEqual([{ to: "/settings", trigger, dynamic: false }])
  })

  it("reads navigate and dismissTo on a useRouter() result", () => {
    expect(expo("const r = useRouter()", "r.navigate('/a')", "r.dismissTo('/b')")).toEqual([
      { to: "/a", trigger: "navigate", dynamic: false },
      { to: "/b", trigger: "navigate", dynamic: false },
    ])
  })

  it("reads a destructured navigate from useRouter()", () => {
    expect(expo("const { navigate } = useRouter()", "navigate('/a')")).toEqual([
      { to: "/a", trigger: "navigate", dynamic: false },
    ])
  })

  it("converts a group-qualified href to its URL and keeps the group path as routeName", () => {
    expect(expo("router.push('/(auth)/(tabs)/(search)/seerr/page')")).toEqual([
      { to: "/seerr/page", trigger: "navigate", dynamic: false, routeName: "(auth)/(tabs)/(search)/seerr/page" },
    ])
  })

  it("reads a { pathname, params } object and converts its bracket segment", () => {
    expect(expo("router.push({ pathname: '/item/[id]', params: { id } })")).toEqual([
      { to: "/item/:id", trigger: "navigate", dynamic: false },
    ])
  })

  it("reads <Link href> and <Redirect href>, including object hrefs", () => {
    expect(
      expo(
        "export const A = () => <Link href={{ pathname: '/item/[id]', params: { id: 1 } }} />",
        "export const B = () => <Redirect href='/(auth)/login' />",
      ),
    ).toEqual([
      { to: "/item/:id", trigger: "link", dynamic: false },
      { to: "/login", trigger: "redirect", dynamic: false, routeName: "(auth)/login" },
    ])
  })

  it("does not read a router singleton imported from elsewhere", () => {
    expect(navigations(["import { router } from './router'", "router.navigate('/a')"].join("\n"))).toEqual([])
  })
})

describe("navigation — dynamic route names", () => {
  it("reports a template-literal screen name as unresolved instead of a literal name", () => {
    const code = [
      "import { useNavigation } from '@react-navigation/native'",
      "const navigation = useNavigation()",
      "navigation.navigate(`${tab}Tab`)",
    ].join("\n")

    expect(navigations(code)).toEqual([])
    expect(unresolved(code)).toHaveLength(1)
  })

  it("records each literal branch of a ternary screen name as its own name target", () => {
    const code = [
      "import { useNavigation } from '@react-navigation/native'",
      "const navigation = useNavigation()",
      "navigation.navigate(user ? 'Home' : 'Index')",
    ].join("\n")

    expect(navigations(code)).toEqual([
      { to: "", trigger: "navigate", dynamic: false, routeName: "Home" },
      { to: "", trigger: "navigate", dynamic: false, routeName: "Index" },
    ])
    expect(unresolved(code)).toEqual([])
  })

  it.each(["||", "??"])("records both literal sides of a `%s` screen name", (operator) => {
    const code = [
      "import { useNavigation } from '@react-navigation/native'",
      "const navigation = useNavigation()",
      `navigation.navigate('Home' ${operator} 'Index')`,
    ].join("\n")

    expect(navigations(code).map((entry) => entry.routeName)).toEqual(["Home", "Index"])
  })

  it("records the literal branch and reports the templated branch of a ternary as unresolved", () => {
    const code = [
      "import { useNavigation } from '@react-navigation/native'",
      "const navigation = useNavigation()",
      "navigation.navigate(user ? 'Home' : `${tab}Tab`)",
    ].join("\n")

    expect(navigations(code)).toEqual([{ to: "", trigger: "navigate", dynamic: false, routeName: "Home" }])
    expect(unresolved(code).map((entry) => entry.expr)).toEqual(["`${tab}Tab`"])
  })

  it("records both names of a ternary in a Vue <NuxtLink :to> object", () => {
    expect(
      vueNavigations(`<template><NuxtLink :to="{ name: user ? 'home' : 'index' }">X</NuxtLink></template>`),
    ).toEqual([
      { to: "", trigger: "link", dynamic: false, routeName: "home" },
      { to: "", trigger: "link", dynamic: false, routeName: "index" },
    ])
  })
})

describe("navigation — React Navigation", () => {
  const native = (...lines: readonly string[]): readonly Navigation[] =>
    navigations(
      ["import { useNavigation, StackActions, CommonActions, Link } from '@react-navigation/native'", ...lines].join(
        "\n",
      ),
    )

  it.each([
    ["navigate", "navigate"],
    ["push", "navigate"],
    ["replace", "replace"],
    ["popTo", "navigate"],
  ] as const)("reads useNavigation().%s(name) as a name target", (method, trigger) => {
    expect(native("const navigation = useNavigation()", `navigation.${method}('Profile')`)).toEqual([
      { to: "", trigger, dynamic: false, routeName: "Profile" },
    ])
  })

  it("reads a destructured navigate from useNavigation()", () => {
    expect(native("const { navigate } = useNavigation()", "navigate('Home')")).toEqual([
      { to: "", trigger: "navigate", dynamic: false, routeName: "Home" },
    ])
  })

  it("reads useNavigation re-exported from expo-router", () => {
    expect(
      navigations(
        ["import { useNavigation } from 'expo-router'", "const nav = useNavigation()", "nav.navigate('Home')"].join("\n"),
      ),
    ).toEqual([{ to: "", trigger: "navigate", dynamic: false, routeName: "Home" }])
  })

  it.each([
    ["a destructured prop", "export const S = ({ navigation }: Props) => navigation.navigate('Feed')"],
    ["a typed parameter", "export function S(navigation: Nav) { navigation.push('Feed') }"],
  ])("reads the navigation param of %s in a file importing @react-navigation", (_label, code) => {
    expect(native(code).map((entry) => entry.routeName)).toEqual(["Feed"])
  })

  it("does not read a navigation param in a file without a @react-navigation import", () => {
    expect(navigations("export const S = ({ navigation }) => navigation.navigate('Feed')")).toEqual([])
  })

  it("reads nested navigate('Root', { screen }) as the innermost screen", () => {
    expect(
      native(
        "const navigation = useNavigation()",
        "navigation.navigate('Root', { screen: 'Settings', params: { screen: 'Privacy' } })",
        "navigation.navigate('Tabs', { screen: 'Search' })",
      ).map((entry) => entry.routeName),
    ).toEqual(["Privacy", "Search"])
  })

  it("reads navigate({ name }) and a nested params screen", () => {
    expect(
      native(
        "const navigation = useNavigation()",
        "navigation.navigate({ name: 'Profile', params: { id } })",
        "navigation.navigate({ name: 'Root', params: { screen: 'Inbox' } })",
      ).map((entry) => entry.routeName),
    ).toEqual(["Profile", "Inbox"])
  })

  it("reads StackActions.push and CommonActions.navigate", () => {
    expect(
      native(
        "const navigation = useNavigation()",
        "navigation.dispatch(StackActions.push('Thread'))",
        "navigation.dispatch(CommonActions.navigate('Home'))",
      ),
    ).toEqual([
      { to: "", trigger: "navigate", dynamic: false, routeName: "Thread" },
      { to: "", trigger: "navigate", dynamic: false, routeName: "Home" },
    ])
  })

  it("reads <Link screen> and to={{ screen }}", () => {
    expect(
      native(
        "export const A = () => <Link screen='Profile' params={{ id: 1 }} />",
        "export const B = () => <Link to={{ screen: 'Settings' }} />",
        "export const C = () => <Link to='/about' />",
      ),
    ).toEqual([
      { to: "", trigger: "link", dynamic: false, routeName: "Profile" },
      { to: "", trigger: "link", dynamic: false, routeName: "Settings" },
      { to: "/about", trigger: "link", dynamic: false },
    ])
  })

  it("reports a non-literal screen name as unresolved", () => {
    const code = [
      "import { useNavigation } from '@react-navigation/native'",
      "const navigation = useNavigation()",
      "declare const target: string",
      "navigation.navigate(target)",
    ].join("\n")
    expect(navigations(code)).toEqual([])
    expect(unresolved(code).map((entry) => entry.expr)).toEqual(["target"])
  })
})

describe("navigation — native forms stay gated by import origin", () => {
  it("ignores a bare local navigate('X') with no import", () => {
    const code = ["const navigate = (name: string) => name", "navigate('Profile')"].join("\n")
    expect(navigations(code)).toEqual([])
    expect(unresolved(code)).toEqual([])
  })

  it("ignores navigation.navigate on a non-native useNavigation", () => {
    expect(
      navigations(
        ["import { useNavigation } from 'react-router-dom'", "const n = useNavigation()", "n.navigate('X')"].join("\n"),
      ),
    ).toEqual([])
  })

  it("keeps TanStack's useRouter().navigate({ to }) unchanged", () => {
    const code = [
      "import { useRouter } from '@tanstack/react-router'",
      "const router = useRouter()",
      "router.navigate({ to: '/a' })",
    ].join("\n")
    expect(navigations(code)).toEqual([])
    expect(unresolved(code)).toEqual([])
  })

  it("keeps web object targets with pathname unresolved", () => {
    const code = [
      "import { Link, useNavigate } from 'react-router-dom'",
      "const navigate = useNavigate()",
      "navigate({ pathname: '/a', search: '?x' })",
      "export const A = () => <Link to={{ pathname: '/b', query: {} }} />",
    ].join("\n")
    expect(navigations(code)).toEqual([])
    expect(unresolved(code)).toHaveLength(2)
  })

  it("keeps a web group-like href unconverted", () => {
    expect(
      navigations(["import Link from 'next/link'", "export const A = () => <Link href='/(group)/x' />"].join("\n")),
    ).toEqual([{ to: "/(group)/x", trigger: "link", dynamic: false }])
  })
})
