import { GLOSSARY } from "../../emit/glossary.js"
import type { GlossaryTerm } from "../../emit/glossary.js"
import { t } from "../../emit/strings.js"
import { EXIT_OK } from "../../pipeline/exit-codes.js"
import type { QueryContext, QueryRun } from "../commands.js"
import { CATALOG_LOCALE, unknownValueError } from "./catalog.js"
import { writeItem, writeList } from "./output.js"

const COLUMNS = ["id", "term", "description"] as const

export const glossaryItem = (entry: GlossaryTerm) => ({
  id: entry.id,
  term: t(CATALOG_LOCALE, entry.labelKey),
  description: t(CATALOG_LOCALE, entry.helpKey),
})

type GlossaryItem = ReturnType<typeof glossaryItem>

export const glossaryItems = (): readonly GlossaryItem[] => GLOSSARY.map(glossaryItem)

const matchesTerm = (folded: string) => (item: GlossaryItem) =>
  item.id.toLowerCase() === folded || item.term.toLowerCase() === folded

export const findGlossaryItem = (items: readonly GlossaryItem[], term: string): GlossaryItem | undefined =>
  items.find(matchesTerm(term.trim().toLowerCase()))

const answer = (context: QueryContext): number => {
  const items = glossaryItems()
  const term = context.args["term"]
  if (term === undefined) {
    writeList(context, { items, columns: COLUMNS })
    return EXIT_OK
  }
  const item = findGlossaryItem(items, term)
  if (item === undefined)
    throw unknownValueError({ what: "glossary term", value: term, valid: items.map((entry) => entry.id), code: "usage/unknown-term" })
  writeItem(context, { item })
  return EXIT_OK
}

const run: QueryRun = (context) => Promise.resolve(context).then(answer)

export default run
