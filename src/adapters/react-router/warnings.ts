import type { DiagnosticInput } from "../../core/diagnostics.js"
import { lineAt } from "../source-utils.js"
import type { ProjectContext } from "../types.js"
import { appFiles } from "./constants.js"

export const UNSUPPORTED_CODE = "screens/unsupported-router-style"

export const MANIFEST_FILE = "package.json"

export const ROUTER_PACKAGES = ["react-router-dom", "react-router"] as const

export const MANIFEST_SECTIONS = ["dependencies", "devDependencies", "peerDependencies"] as const

/** v4 introduced the `<Switch>`/`<Route component>` API this source reads as the v5 flavour. */
export const FIRST_SUPPORTED_MAJOR = 4

export const RANGE_MAJOR = /^\s*(?:[~^]|[<>]?=?)\s*v?(\d+)/

export const FRAMEWORK_ROUTE_CONFIGS = ["app/routes.ts", "app/routes.mts", "app/routes.js", "app/routes.mjs"] as const

export const FRAMEWORK_ROUTE_CONFIG_TEXT = /@react-router\/dev\/routes|\bRouteConfig\b/

export const LEGACY_ROUTE_ELEMENT = /<(?:Switch|Route)[\s/>]/

export type DeclaredRange = {
  readonly name: string
  readonly range: string
}

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const parseManifest = (text: string): Readonly<Record<string, unknown>> | null => {
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export const declaredRangesOf = (manifest: Readonly<Record<string, unknown>>): readonly DeclaredRange[] =>
  ROUTER_PACKAGES.flatMap((name) =>
    MANIFEST_SECTIONS.flatMap((section) => {
      const dependencies = manifest[section]
      const range = isRecord(dependencies) ? dependencies[name] : undefined
      return typeof range === "string" ? [{ name, range }] : []
    }),
  )

export const isLegacyRange = (range: string): boolean => {
  const major = RANGE_MAJOR.exec(range)?.[1]
  return major !== undefined && Number(major) < FIRST_SUPPORTED_MAJOR
}

export const legacyVersionDiagnostic = (ctx: ProjectContext): DiagnosticInput | null => {
  const text = ctx.readFile(MANIFEST_FILE)
  const manifest = text === null ? null : parseManifest(text)
  const legacy = manifest === null ? undefined : declaredRangesOf(manifest).find((declared) => isLegacyRange(declared.range))
  if (text === null || legacy === undefined) return null
  return {
    severity: "warning",
    code: UNSUPPORTED_CODE,
    message: `${legacy.name} '${legacy.range}' is React Router v3 or older; only v4+ library mode is read (route objects, <Routes>/<Switch>/<Route>, useRoutes), so its route config is not discovered`,
    file: MANIFEST_FILE,
    line: lineAt(text, Math.max(text.indexOf(`"${legacy.name}"`), 0)),
  }
}

export const frameworkModeDiagnostic = (ctx: ProjectContext): DiagnosticInput | null => {
  const config = FRAMEWORK_ROUTE_CONFIGS.find((file) => FRAMEWORK_ROUTE_CONFIG_TEXT.test(ctx.readFile(file) ?? ""))
  if (config === undefined) return null
  return {
    severity: "warning",
    code: UNSUPPORTED_CODE,
    message: `${config} is a React Router v7 framework mode route config; framework mode (route()/index()/layout() configs and file routes) is not supported, so its routes are not discovered`,
    file: config,
    line: 1,
  }
}

export const rootlessRoutesDiagnostic = (ctx: ProjectContext): DiagnosticInput | null => {
  for (const file of appFiles(ctx)) {
    const text = ctx.readFile(file)
    const site = text === null || !text.includes("react-router") ? null : LEGACY_ROUTE_ELEMENT.exec(text)
    if (text === null || site === null) continue
    return {
      severity: "warning",
      code: UNSUPPORTED_CODE,
      message: "react-router <Route> elements were found but no <Routes>/<Switch>, router factory or useRoutes root; routes outside such a root are not discovered",
      file,
      line: lineAt(text, site.index),
    }
  }
  return null
}

export const unsupportedSetupDiagnostics = (ctx: ProjectContext, rootCount: number): readonly DiagnosticInput[] => {
  const setup = [legacyVersionDiagnostic(ctx), frameworkModeDiagnostic(ctx)].flatMap((found) =>
    found === null ? [] : [found],
  )
  if (setup.length > 0 || rootCount > 0) return setup
  const rootless = rootlessRoutesDiagnostic(ctx)
  return rootless === null ? [] : [rootless]
}
