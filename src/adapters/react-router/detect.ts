import type { Evidence } from "../../core/model.js"
import { isFrameworkMode } from "../react-router-framework.js"
import { lineAt } from "../source-utils.js"
import type { ProjectContext } from "../types.js"
import { DETECT_SCORE_DATA_ROUTER, DETECT_SCORE_JSX_ROUTES, JSX_ROUTES, ROUTER_CALL, ROUTE_HOOK_CALL, WOUTER_DEPENDENCY, appFiles } from "./constants.js"

export type Probe = {
  readonly dataRouter: readonly Evidence[]
  readonly jsxRoutes: readonly Evidence[]
}

export const jsxRoutesEvidence = (text: string, file: string): Evidence | null => {
  if (!text.includes("react-router")) return null
  const jsx = JSX_ROUTES.exec(text)
  if (jsx !== null) return { what: "JSX <Routes>/<Route> element", file, line: lineAt(text, jsx.index) }
  const hook = ROUTE_HOOK_CALL.exec(text)
  return hook === null ? null : { what: "useRoutes call", file, line: lineAt(text, hook.index) }
}

export const probeProject = (ctx: ProjectContext): Probe => {
  const dataRouter: Evidence[] = []
  const jsxRoutes: Evidence[] = []

  for (const file of appFiles(ctx)) {
    const text = ctx.readFile(file)
    if (text === null) continue

    const call = ROUTER_CALL.exec(text)
    if (call !== null) {
      dataRouter.push({ what: `${call[0].replace(/\s*\($/, "")} call`, file, line: lineAt(text, call.index) })
      continue
    }

    const jsx = jsxRoutesEvidence(text, file)
    if (jsx !== null) jsxRoutes.push(jsx)
  }

  return { dataRouter, jsxRoutes }
}

const DETECT_SCORE_FRAMEWORK_PROJECT = 1

export const hasReactRouter = (ctx: ProjectContext): boolean =>
  ctx.hasDependency("react-router") || ctx.hasDependency("react-router-dom")

export const detectReactRouter = (ctx: ProjectContext): { score: number; evidence: readonly Evidence[] } => {
  if (!hasReactRouter(ctx)) return { score: 0, evidence: [] }

  const dependency: Evidence = {
    what: ctx.hasDependency("react-router-dom") ? "react-router-dom dependency" : "react-router dependency",
    file: "package.json",
    line: 1,
  }

  if (isFrameworkMode(ctx))
    return {
      score: DETECT_SCORE_FRAMEWORK_PROJECT,
      evidence: [dependency, { what: "framework-mode project: routes come from react-router-framework", file: "package.json", line: 1 }],
    }

  const probe = probeProject(ctx)
  if (probe.dataRouter.length > 0)
    return { score: DETECT_SCORE_DATA_ROUTER, evidence: [dependency, ...probe.dataRouter] }
  if (probe.jsxRoutes.length > 0)
    return { score: DETECT_SCORE_JSX_ROUTES, evidence: [dependency, ...probe.jsxRoutes] }
  return { score: 0, evidence: [] }
}

const WOUTER_IMPORT = /\bfrom\s+["']wouter(?:\/preact)?["']/

const WOUTER_ELEMENT = /<(?:Switch|Route)[\s/>]/

const wouterEvidence = (text: string, file: string): Evidence | null => {
  const element = WOUTER_IMPORT.test(text) ? WOUTER_ELEMENT.exec(text) : null
  return element === null ? null : { what: "JSX wouter <Switch>/<Route> element", file, line: lineAt(text, element.index) }
}

export const detectWouter = (ctx: ProjectContext): { score: number; evidence: readonly Evidence[] } => {
  if (!ctx.hasDependency(WOUTER_DEPENDENCY)) return { score: 0, evidence: [] }
  const found = appFiles(ctx).flatMap((file) => {
    const text = ctx.readFile(file)
    const evidence = text === null ? null : wouterEvidence(text, file)
    return evidence === null ? [] : [evidence]
  })
  if (found.length === 0) return { score: 0, evidence: [] }
  const dependency: Evidence = { what: "wouter dependency", file: "package.json", line: 1 }
  return { score: DETECT_SCORE_JSX_ROUTES, evidence: [dependency, ...found] }
}
