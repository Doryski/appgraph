export type Params = Readonly<Record<string, string | number>>

export const PLURAL_SEPARATOR = "|"

export const PLURAL_FORMS = {
  en: ["one", "other"],
  pl: ["one", "few", "many"],
} as const

export type PluralLocale = keyof typeof PLURAL_FORMS

export type PluralForm = (typeof PLURAL_FORMS)[PluralLocale][number]

export const interpolate = (template: string, params: Params | undefined): string => {
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

const isPolishFew = (count: number): boolean => {
  const lastDigit = count % 10
  const lastTwo = count % 100
  return lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14)
}

const PLURAL_RULES: { readonly [L in PluralLocale]: (count: number) => (typeof PLURAL_FORMS)[L][number] } = {
  en: (count) => (count === 1 ? "one" : "other"),
  pl: (count) => {
    if (count === 1) return "one"
    return isPolishFew(count) ? "few" : "many"
  },
}

export const pluralForm = (locale: PluralLocale, count: number): PluralForm => PLURAL_RULES[locale](count)

const pluralIndex = (locale: PluralLocale, count: number): number => {
  const forms: readonly PluralForm[] = PLURAL_FORMS[locale]
  return forms.indexOf(pluralForm(locale, count))
}

export const pickPlural = (locale: PluralLocale, template: string, count: number): string => {
  const segments = template.split(PLURAL_SEPARATOR)
  return segments[pluralIndex(locale, count)] ?? segments[segments.length - 1] ?? template
}

export const formatPlural = (locale: PluralLocale, template: string, count: number, params?: Params): string =>
  interpolate(pickPlural(locale, template, count), { count, ...params })
