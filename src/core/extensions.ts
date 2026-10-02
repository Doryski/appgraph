export const SCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const

export const JSX_EXTENSIONS = [".tsx", ".jsx"] as const

export const SFC_EXTENSIONS = [".vue"] as const

export const SOURCE_EXTENSIONS = [...SCRIPT_EXTENSIONS, ...SFC_EXTENSIONS] as const

export type SourceExtension = (typeof SOURCE_EXTENSIONS)[number]

const bare = (extensions: readonly string[]): readonly string[] => extensions.map((extension) => extension.slice(1))

export const globOf = (extensions: readonly string[]): string => {
  const names = bare(extensions)
  return names.length === 1 ? `**/*.${names[0]}` : `**/*.{${names.join(",")}}`
}

export const extensionPatternOf = (extensions: readonly string[]): string => `(?:${bare(extensions).join("|")})`

export const SCRIPT_GLOB = globOf(SCRIPT_EXTENSIONS)

export const SCRIPT_EXTENSION_PATTERN = extensionPatternOf(SCRIPT_EXTENSIONS)

export const SCRIPT_FILE = new RegExp(`\\.${SCRIPT_EXTENSION_PATTERN}$`)

const SOURCE_FILE = new RegExp(`\\.${extensionPatternOf(SOURCE_EXTENSIONS)}$`)

export const stripSourceExtension = (name: string): string => name.replace(SOURCE_FILE, "")

export const isSourceFile = (file: string): boolean => SOURCE_FILE.test(file)

export const isSfcFile = (file: string): boolean => SFC_EXTENSIONS.some((extension) => file.endsWith(extension))
