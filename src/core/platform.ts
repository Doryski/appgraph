export const NATIVE_PLATFORMS = ["ios", "android", "native", "web"] as const

export const TV_PLATFORM = "tv"

export type Platform = (typeof NATIVE_PLATFORMS)[number] | typeof TV_PLATFORM

export const DEFAULT_MODULE_SUFFIXES = ["", ".native", ".ios", ".android"] as const

const TVOS_PACKAGE = "react-native-tvos"

const TVOS_SCOPE = "@react-native-tvos/"

const TVOS_ALIAS = /"react-native"\s*:\s*"npm:react-native-tvos(?:@|")/

const REACT_NATIVE_PACKAGES = ["react-native", "expo", "expo-router"] as const

const REACT_NATIVE_SCOPE = "@react-navigation/"

const SOURCE_SUFFIX = /\.(tsx|ts|mts|cts|jsx|js|mjs|cjs)$/

const usesTvos = (dependencies: ReadonlySet<string>, manifestText: string): boolean =>
  dependencies.has(TVOS_PACKAGE) ||
  [...dependencies].some((name) => name.startsWith(TVOS_SCOPE)) ||
  TVOS_ALIAS.test(manifestText)

export const platformsFor = (input: {
  readonly dependencies: ReadonlySet<string>
  readonly manifestText: string
}): readonly Platform[] =>
  usesTvos(input.dependencies, input.manifestText) ? [...NATIVE_PLATFORMS, TV_PLATFORM] : [...NATIVE_PLATFORMS]

export const isReactNativeProject = (dependencies: ReadonlySet<string>): boolean =>
  REACT_NATIVE_PACKAGES.some((name) => dependencies.has(name)) ||
  [...dependencies].some((name) => name.startsWith(REACT_NATIVE_SCOPE))

export const splitPlatform = (
  file: string,
  platforms: readonly string[],
): { readonly base: string; readonly platform: string | null } => {
  const extension = SOURCE_SUFFIX.exec(file)
  if (extension === null) return { base: file, platform: null }
  const stem = file.slice(0, extension.index)
  const slash = stem.lastIndexOf("/")
  const dot = stem.lastIndexOf(".")
  if (dot <= slash + 1) return { base: file, platform: null }
  const platform = stem.slice(dot + 1)
  if (!platforms.includes(platform)) return { base: file, platform: null }
  return { base: `${stem.slice(0, dot)}${extension[0]}`, platform }
}

const withModuleSuffix = (baseSuffix: string, moduleSuffix: string): string | null => {
  if (moduleSuffix === "") return baseSuffix
  const dot = baseSuffix.lastIndexOf(".")
  if (dot === -1) return null
  return `${baseSuffix.slice(0, dot)}${moduleSuffix}${baseSuffix.slice(dot)}`
}

export const platformCandidateSuffixes = (
  baseSuffixes: readonly string[],
  moduleSuffixes: readonly string[] | null,
  reactNative = false,
): readonly string[] => {
  const effective = moduleSuffixes ?? (reactNative ? DEFAULT_MODULE_SUFFIXES : null)
  if (effective === null) return baseSuffixes
  return effective.flatMap((moduleSuffix) =>
    baseSuffixes.flatMap((baseSuffix) => withModuleSuffix(baseSuffix, moduleSuffix) ?? []),
  )
}
