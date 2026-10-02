import { useMemo } from "react"
import { usePayload } from "@/app/report-context"

type SlugRow = { readonly key: string; readonly slug: string }

const slugMap = (rows: readonly SlugRow[]): ReadonlyMap<string, string> => new Map(rows.map((row) => [row.key, row.slug]))

export const usePaletteSlugs = () => {
  const { kinds, methods } = usePayload()
  return useMemo(() => {
    const kindSlugs = slugMap(kinds)
    const methodSlugs = slugMap(methods)
    return {
      kindSlug: (key: string) => kindSlugs.get(key),
      methodSlug: (key: string) => methodSlugs.get(key),
    }
  }, [kinds, methods])
}

export type PaletteSlugs = ReturnType<typeof usePaletteSlugs>
