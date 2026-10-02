#!/usr/bin/env node
import * as nodeModule from "node:module"

type CompileCacheModule = {
  readonly enableCompileCache?: () => unknown
}

const compileCacheModule: CompileCacheModule = nodeModule

const enableCompileCache = (): void => {
  try {
    compileCacheModule.enableCompileCache?.()
  } catch {
    return
  }
}

const isClosedPipe = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "EPIPE"

const exitOnClosedPipe = (error: unknown): void => {
  if (!isClosedPipe(error)) throw error
  process.exit(0)
}

enableCompileCache()
process.stdout.on("error", exitOnClosedPipe)

const { runCli } = await import("./index.js")
process.exitCode = await runCli(process.argv.slice(2))
