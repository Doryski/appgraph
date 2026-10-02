import type ts from "typescript"
import { describe, expect, it } from "vitest"
import { guardOfExports, guardOfFunction, type LoaderGuardOptions } from "../../src/adapters/loader-guards.js"
import { discoverBench } from "./discover-harness.js"

const BROAD: LoaderGuardOptions = { unauthenticatedTarget: null }

const LOADERS = ["loader", "clientLoader"] as const

const guardIn = (source: string, names: readonly string[] = LOADERS, options = BROAD, extra = {}) => {
  const { ctx } = discoverBench({ "src/route.tsx": source, ...extra })
  return guardOfExports(ctx, "src/route.tsx", names, options)
}

const REQUIRE_USER_ID = `export async function requireUserId(request: Request) {
  const id = await getUserId(request)
  if (!id) throw redirect("/login")
  return id
}`

describe("adapters/loader-guards guardOfExports", () => {
  it("reads plane's sign-in clientLoader as an unconditional redirect", () => {
    const guard = guardIn(`import { redirect } from "react-router"
export const clientLoader = () => {
  throw redirect("/")
}`)

    expect(guard).toMatchObject({ kind: "unconditional", to: "/", condition: null, via: null, line: 3 })
    expect(guard.label).toBe("clientLoader redirect to '/'")
  })

  it("reads documenso's authenticated layout loader as a conditional guard", () => {
    const guard = guardIn(`import { redirect } from "react-router"
export async function loader({ request }) {
  const session = await getSession(request)
  if (!session) {
    throw redirect("/signin")
  }
  return { session }
}`)

    expect(guard).toMatchObject({ kind: "conditional", to: "/signin", condition: "!session", scopedOut: false })
    expect(guard.label).toBe("loader redirect to '/signin' (conditional: !session)")
  })

  const FORGOT_PASSWORD = `import { redirect } from "react-router"
export function loader() {
  if (!isSigninEnabledForProvider('email')) {
    throw redirect('/signin')
  }
  return null
}`

  it("scopes out documenso's forgot-password redirect away from the unauthenticated target", () => {
    const guard = guardIn(FORGOT_PASSWORD, LOADERS, { unauthenticatedTarget: "/login" })

    expect(guard).toMatchObject({ kind: "none", scopedOut: true, to: "/signin" })
    expect(guard.label).toBe("loader redirect to '/signin' (conditional: !isSigninEnabledForProvider('email'))")
  })

  it("keeps the same redirect when it is aimed at the unauthenticated target", () => {
    const guard = guardIn(FORGOT_PASSWORD, LOADERS, { unauthenticatedTarget: "/signin/" })

    expect(guard).toMatchObject({ kind: "conditional", scopedOut: false, to: "/signin" })
  })

  it("treats a redirect after an early return as conditional", () => {
    const guard = guardIn(`export const loader = async ({ request }) => {
  if (isBot(request)) return json({})
  return redirect("/a")
}`)

    expect(guard).toMatchObject({ kind: "conditional", to: "/a", condition: "!(isBot(request))" })
  })

  it("reads a template with a substitution as a dynamic target", () => {
    const guard = guardIn(`export async function loader({ params }) {
  if (!params.id) throw redirect(\`/teams/\${params.team}\`)
  return null
}`)

    expect(guard).toMatchObject({ kind: "conditional", to: null })
    expect(guard.label).toBe("loader redirect (target is not a readable literal) (conditional: !params.id)")
  })

  it("reads trigger.dev's query-carrying template target by its static path", () => {
    const guard = guardIn(`export async function loader({ request }) {
  const searchParams = new URLSearchParams([["redirectTo", request.url]])
  if (!(await getUserId(request))) throw redirect(\`/login?\${searchParams}\`)
  return null
}`)

    expect(guard).toMatchObject({ kind: "conditional", to: "/login" })
  })

  it("keeps a template target unreadable when a substitution precedes the query", () => {
    const guard = guardIn(`export async function loader({ params }) {
  if (!params.id) throw redirect(\`/teams/\${params.team}?tab=1\`)
  return null
}`)

    expect(guard).toMatchObject({ kind: "conditional", to: null })
  })

  it("reads a redirect in a promise .catch callback as conditional", () => {
    const guard = guardIn(`import { redirect } from "react-router"
export async function loader({ request }) {
  const data = await fetchToken(request).catch(() => {
    throw redirect("/login")
  })
  return data
}`)

    expect(guard).toMatchObject({ kind: "conditional", to: "/login", condition: "in .catch callback" })
    expect(guard.label).toBe("loader redirect to '/login' (conditional: in .catch callback)")
  })

  it("reads a redirect in a catch clause as conditional", () => {
    const guard = guardIn(`export async function loader({ request }) {
  try {
    return await fetchToken(request)
  } catch {
    throw redirect("/login")
  }
}`)

    expect(guard).toMatchObject({ kind: "conditional", to: "/login", condition: "in catch clause" })
  })

  it("does not read an event handler defined inside a loader", () => {
    const guard = guardIn(`export function loader() {
  const onExpire = () => {
    throw redirect("/login")
  }
  window.addEventListener("expire", () => redirect("/login"))
  return { onExpire }
}`)

    expect(guard).toMatchObject({ kind: "none", label: "" })
  })

  it("reads a getServerSideProps redirect object inside an if as conditional", () => {
    const guard = guardIn(
      `export const getServerSideProps = async (context) => {
  const session = await getSession(context)
  if (!session) {
    return { redirect: { destination: "/login", permanent: false } }
  }
  return { props: {} }
}`,
      ["getServerSideProps"],
    )

    expect(guard).toMatchObject({ kind: "conditional", to: "/login", condition: "!session" })
    expect(guard.label).toBe("getServerSideProps redirect to '/login' (conditional: !session)")
  })

  it("follows a same-file helper one hop", () => {
    const guard = guardIn(`${REQUIRE_USER_ID}
export async function loader({ request }) {
  const userId = await requireUserId(request)
  return { userId }
}`)

    expect(guard).toMatchObject({ kind: "conditional", to: "/login", condition: "!id", via: "requireUserId" })
    expect(guard.label).toBe("loader redirect to '/login' (conditional: !id) via requireUserId")
  })

  it("follows an imported helper one hop", () => {
    const guard = guardIn(
      `import { requireUserId } from "./session.server"
export const loader = async ({ request }) => {
  await requireUserId(request)
  return null
}`,
      LOADERS,
      BROAD,
      { "src/session.server.ts": `import { redirect } from "@remix-run/node"\n${REQUIRE_USER_ID}` },
    )

    expect(guard).toMatchObject({ kind: "conditional", to: "/login", via: "requireUserId", file: "src/route.tsx" })
  })

  it("does not follow a second hop", () => {
    const guard = guardIn(`${REQUIRE_USER_ID}
async function requireUser(request) {
  return requireUserId(request)
}
export async function loader({ request }) {
  return requireUser(request)
}`)

    expect(guard).toMatchObject({ kind: "none", label: "", scopedOut: false })
  })

  it("reads a helper that always redirects by the position of its call", () => {
    const helper = `function toHome() {
  throw redirect("/home")
}
`
    const unconditional = guardIn(`${helper}export function loader() {
  toHome()
}`)
    const conditional = guardIn(`${helper}export function loader({ user }) {
  if (!user) toHome()
  return null
}`)

    expect(unconditional).toMatchObject({ kind: "unconditional", to: "/home", via: "toHome" })
    expect(conditional).toMatchObject({ kind: "conditional", to: "/home", condition: "!user", via: "toHome" })
  })

  it("prefers a conditional guard over an unconditional redirect across exports", () => {
    const guard = guardIn(`export const loader = () => redirect("/home")
export const clientLoader = ({ user }) => (user ? null : redirect("/login"))`)

    expect(guard).toMatchObject({ kind: "conditional", to: "/login", condition: "!user" })
  })
})

describe("adapters/loader-guards guardOfFunction", () => {
  it("reads a TanStack beforeLoad object redirect as a conditional guard", () => {
    const file = "src/routes/_auth.tsx"
    const bench = discoverBench({
      [file]: `import { createFileRoute, redirect } from "@tanstack/react-router"
export const Route = createFileRoute("/_auth")({
  beforeLoad: ({ context }) => {
    if (!context.auth) throw redirect({ to: "/login" })
  },
})`,
    })
    const fn = bench.find(file, (node): node is ts.ArrowFunction => bench.ctx.ts.isArrowFunction(node))

    const guard = guardOfFunction(bench.ctx, fn, file, BROAD)

    expect(guard).toMatchObject({ kind: "conditional", to: "/login", condition: "!context.auth" })
    expect(guard.label).toBe("beforeLoad redirect to '/login' (conditional: !context.auth)")
  })

  it("reads Infisical's authenticate beforeLoad .catch redirect as the guard under its target", () => {
    const file = "src/pages/middlewares/authenticate.tsx"
    const bench = discoverBench({
      [file]: `import { createFileRoute, redirect } from "@tanstack/react-router"
export const Route = createFileRoute("/_authenticate")({
  beforeLoad: async ({ context }) => {
    if (!context.serverConfig.initialized) {
      throw redirect({ to: "/admin/signup" })
    }
    const data = await context.queryClient.fetchQuery({ queryKey: ["token"] }).catch(() => {
      context.queryClient.removeQueries({ queryKey: ["token"] })
      throw redirect({
        to: "/login"
      })
    })
    return data
  },
})`,
    })
    const fn = bench.find(file, (node): node is ts.ArrowFunction => bench.ctx.ts.isArrowFunction(node))

    const guard = guardOfFunction(bench.ctx, fn, file, { unauthenticatedTarget: "/login" })

    expect(guard).toMatchObject({ kind: "conditional", to: "/login", condition: "in .catch callback", line: 9 })
  })
})
