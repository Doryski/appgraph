import type { AppgraphConfig, ExtensionRewrite, KindRule, WrapperRule } from "../core/model.js"
import type { Preset } from "./presets.js"

/**
 * Identity at runtime, inference at the call site: `defineConfig({...})` in `appgraph.config.ts` gets the
 * field names checked and completed without the author writing a type annotation, and the transpiled
 * module keeps exactly the object literal it was given (§15.1, §15.2 step 6).
 */
export const defineConfig = (config: AppgraphConfig): AppgraphConfig => config

export const defineKindRule = (rule: KindRule): KindRule => rule

export const defineKindRules = (rules: readonly KindRule[]): readonly KindRule[] => rules

export const defineWrapperRole = (rule: WrapperRule): WrapperRule => rule

export const defineWrapperRoles = (rules: readonly WrapperRule[]): readonly WrapperRule[] => rules

export const defineExtensionRewrites = (rewrites: readonly ExtensionRewrite[]): readonly ExtensionRewrite[] =>
  rewrites

export const definePreset = (preset: Preset): Preset => preset
