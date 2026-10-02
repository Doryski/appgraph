import { formatPlural, interpolate } from "@appgraph/emit/i18n-runtime.js"
import type { Params } from "@appgraph/emit/i18n-runtime.js"
import type { Locale, StringKey } from "@appgraph/emit/strings.js"
import { payload } from "./payload"

export type StringTable = Readonly<Partial<Record<StringKey, string>>>

export const DEFAULT_UI_LOCALE: Locale = "en"

export const createI18n = (strings: StringTable, locale: Locale) => {
  const template = (key: StringKey): string => strings[key] ?? key
  return {
    locale,
    t: (key: StringKey, params?: Params): string => interpolate(template(key), params),
    tPlural: (key: StringKey, count: number, params?: Params): string =>
      formatPlural(locale, template(key), count, params),
  }
}

export type I18n = ReturnType<typeof createI18n>

export type Translate = I18n["t"]

const isLocale = (value: string): value is Locale => value === "en" || value === "pl"

const payloadLocale = (): Locale => {
  const locale = payload?.locale ?? DEFAULT_UI_LOCALE
  return isLocale(locale) ? locale : DEFAULT_UI_LOCALE
}

export const i18n = createI18n(payload?.strings ?? {}, payloadLocale())

export const { t, tPlural, locale } = i18n
