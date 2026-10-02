import { describe, expect, it } from "vitest"
import { DEFAULT_NAMESPACE, createI18nExtractor } from "../../src/extractors/i18n.js"
import ts from "typescript"
import type { TemplateAttribute, TemplateDoc, TemplateElement, TemplateExpression } from "../../src/core/template-doc.js"
import { createExtractContext, createRegistry } from "../../src/extractors/registry.js"
import { parse, run, runVue, valuesOf } from "./harness.js"

const extractor = createI18nExtractor()

const namespaces = (code: string, file?: string) =>
  valuesOf(run([extractor], code, file === undefined ? {} : { file }), "i18nNamespaces")

describe("i18n — react-i18next, binding-aware, NEGATIVE direction", () => {
  it("ignores a local function named useTranslation that is not imported", () => {
    const code = ["function useTranslation(ns) { return { t: (k) => k } }", "useTranslation('orders')"].join(
      "\n",
    )

    expect(namespaces(code)).toEqual([])
  })

  it("ignores useTranslation imported from an unrelated module", () => {
    const code = ["import { useTranslation } from 'some-i18n-lib'", "useTranslation('orders')"].join("\n")
    expect(namespaces(code)).toEqual([])
  })
})

describe("i18n — react-i18next, POSITIVE direction", () => {
  it("finds an aliased useTranslation import", () => {
    const code = ["import { useTranslation as useT } from 'react-i18next'", "useT('orders')"].join("\n")
    expect(namespaces(code)).toEqual(["orders"])
  })

  it("finds the namespace alongside a keyPrefix option", () => {
    const code = [
      "import { useTranslation } from 'react-i18next'",
      "useTranslation('orders', { keyPrefix: 'list' })",
    ].join("\n")

    expect(namespaces(code)).toEqual(["orders"])
  })

  it("finds every namespace in an array-form call", () => {
    const code = ["import { useTranslation } from 'react-i18next'", "useTranslation(['orders', 'clients'])"].join(
      "\n",
    )

    expect(namespaces(code)).toEqual(["orders", "clients"])
  })

  it("deduplicates repeated namespaces", () => {
    const code = [
      "import { useTranslation } from 'react-i18next'",
      "useTranslation('orders')",
      "useTranslation('orders')",
    ].join("\n")

    expect(namespaces(code)).toEqual(["orders"])
  })
})

describe("i18n — next-intl", () => {
  it("finds useTranslations", () => {
    const code = ["import { useTranslations } from 'next-intl'", "useTranslations('orders')"].join("\n")
    expect(namespaces(code)).toEqual(["orders"])
  })

  it("finds getTranslations from the /server subpath", () => {
    const code = ["import { getTranslations } from 'next-intl/server'", "await getTranslations('orders')"].join(
      "\n",
    )

    expect(namespaces(code)).toEqual(["orders"])
  })
})

describe("i18n — custom locale-directory mode (admin/'s shape, no i18next)", () => {
  it("derives namespaces from a locale-aggregator file's own relative imports", () => {
    const code = [
      "import orders from './orders'",
      "import users from './users'",
      "export default { ...orders, ...users }",
    ].join("\n")

    expect(namespaces(code, "src/locale/en.ts")).toEqual(["orders", "users"])
  })

  it("ignores an absolute or package import in the aggregator", () => {
    const code = ["import { merge } from 'lodash'", "import orders from './orders'"].join("\n")
    expect(namespaces(code, "src/locale/en.ts")).toEqual(["orders"])
  })

  it("does not treat one locale file importing another locale file as a namespace", () => {
    const code = ["import pl from './pl'"].join("\n")
    expect(namespaces(code, "src/locale/en.ts")).toEqual([])
  })

  it("does not fire outside a locale/ directory", () => {
    const code = ["import orders from './orders'"].join("\n")
    expect(namespaces(code, "src/config/en.ts")).toEqual([])
  })

  it("does not fire on a per-domain file inside locale/ that is not the aggregator", () => {
    const code = ["import { helper } from './helper'"].join("\n")
    expect(namespaces(code, "src/locale/orders.ts")).toEqual([])
  })
})

describe("i18n — the library default namespace", () => {
  it("records 'default' for a react-i18next useTranslation() without a namespace", () => {
    expect(namespaces("import { useTranslation } from 'react-i18next'\nuseTranslation()")).toEqual(["default"])
  })

  it("records nothing for a namespace argument that does not fold", () => {
    expect(namespaces("import { useTranslation } from 'react-i18next'\nuseTranslation(pickNs())")).toEqual([])
  })
})

describe("i18n — i18next core", () => {
  it("reads the namespace from an `ns:key` key, the ns option, or falls back to default", () => {
    const code = [
      "import i18next from 'i18next'",
      "i18next.t('orders:title')",
      "i18next.t('summary', { ns: 'invoices' })",
      "i18next.t('all-rights-reserved')",
    ].join("\n")

    expect(namespaces(code)).toEqual(["orders", "invoices", "default"])
  })

  it("reads a named `t` import and a namespace import", () => {
    expect(namespaces("import { t } from 'i18next'\nt('users:list')")).toEqual(["users"])
    expect(namespaces("import * as i18n from 'i18next'\ni18n.t('x')")).toEqual(["default"])
  })

  it("records nothing for a key that does not fold", () => {
    expect(namespaces("import i18next from 'i18next'\ni18next.t(keyOf(row))")).toEqual([])
  })

  it("ignores t on anything but the i18next instance", () => {
    const code = [
      "import { i18n } from './i18n'",
      "import { t } from './translate'",
      "i18n.t('orders:title')",
      "t('users:list')",
      "router.t('x')",
    ].join("\n")
    expect(namespaces(code)).toEqual([])
  })
})

describe("i18n — react-intl", () => {
  it("records 'default' for useIntl, defineMessages and FormattedMessage, never an id prefix", () => {
    expect(namespaces("import { useIntl } from 'react-intl'\nconst intl = useIntl()")).toEqual(["default"])
    expect(namespaces("import { defineMessages } from 'react-intl'\ndefineMessages({ a: { id: 'orders.a' } })")).toEqual([
      "default",
    ])
    expect(namespaces("import { FormattedMessage as M } from 'react-intl'\nconst a = <M id='orders.title' />")).toEqual([
      "default",
    ])
  })

  it("ignores a same-named component or hook from elsewhere", () => {
    const code = ["import { FormattedMessage, useIntl } from './intl'", "useIntl()", "const a = <FormattedMessage id='x' />"].join(
      "\n",
    )
    expect(namespaces(code)).toEqual([])
  })
})

const vueNamespaces = (sfc: string) => valuesOf(runVue([extractor], sfc), "i18nNamespaces")

const sfcOf = (script: string, template: string) =>
  [`<script setup lang="ts">`, script, "</script>", "<template>", template, "</template>"].join("\n")

describe("i18n — vue-i18n", () => {
  it("records the default namespace for useI18n imported from vue-i18n", () => {
    const code = ["import { useI18n } from 'vue-i18n'", "const { t } = useI18n()"].join("\n")
    expect(namespaces(code)).toEqual([DEFAULT_NAMESPACE])
  })

  it("ignores a local function named useI18n that is not imported from vue-i18n", () => {
    const code = ["function useI18n() { return { t: (k) => k } }", "useI18n()"].join("\n")
    expect(namespaces(code)).toEqual([])
  })

  it("ignores useI18n imported from an unrelated module", () => {
    const code = ["import { useI18n } from 'some-lib'", "useI18n()"].join("\n")
    expect(namespaces(code)).toEqual([])
  })

  it("finds $t in a bound attribute expression and emits once per file", () => {
    const sfc = sfcOf("const a = 1", `  <button :title="$t('save')" :aria-label="$t('save')">x</button>`)
    expect(vueNamespaces(sfc)).toEqual([DEFAULT_NAMESPACE])
  })

  it("finds $t in a text interpolation", () => {
    const sfc = sfcOf("const a = 1", "  <h1>{{ $t('title') }}</h1>")
    expect(vueNamespaces(sfc)).toEqual([DEFAULT_NAMESPACE])
  })

  it("finds bare t( in a bound attribute only when the script uses useI18n", () => {
    const template = `  <button :title="t('save')">x</button>`
    const withHook = sfcOf("import { useI18n } from 'vue-i18n'\nconst { t } = useI18n()", template)
    const withoutHook = sfcOf("const t = (k: string) => k", template)
    expect(vueNamespaces(withHook)).toEqual([DEFAULT_NAMESPACE])
    expect(vueNamespaces(withoutHook)).toEqual([])
  })

  it("ignores member calls like foo.$t( and unrelated attributes", () => {
    const sfc = sfcOf("const a = 1", `  <button :title="foo.$t('x')" title="$t('y')">x</button>`)
    expect(vueNamespaces(sfc)).toEqual([])
  })

  it("declares the react-i18next dependency first, then vue-i18n, @nuxtjs/i18n and the Angular libraries", () => {
    expect(extractor.enablingDependency).toEqual([
      "react-i18next",
      "vue-i18n",
      "@nuxtjs/i18n",
      "@ngx-translate/core",
      "@angular/localize",
      "@lingui/core",
      "@lingui/react",
      "@lingui/macro",
    ])
  })
})

describe("i18n — Lingui (AS18)", () => {
  const forms = {
    "tagged t from @lingui/macro": "import { t } from '@lingui/macro'\nconst a = t`Hello`",
    "tagged t from @lingui/core/macro": "import { t } from '@lingui/core/macro'\nconst a = t`Hello`",
    "tagged msg": "import { msg } from '@lingui/core/macro'\nconst a = msg`Hello`",
    "called t with id": "import { t } from '@lingui/core'\nconst a = t({ id: 'a', message: 'Hello' })",
    "defineMessage": "import { defineMessage } from '@lingui/macro'\nconst a = defineMessage({ message: 'Hi' })",
    "aliased msg call": "import { msg as m } from '@lingui/macro'\nconst a = m({ message: 'Hi' })",
    "Trans": "import { Trans } from '@lingui/react'\nconst a = <Trans>Hello</Trans>",
    "Trans from react/macro": "import { Trans } from '@lingui/react/macro'\nconst a = <Trans id=\"x\" />",
    "i18n._": "import { i18n } from '@lingui/core'\ni18n._('id')",
    "useLingui": "import { useLingui } from '@lingui/react'\nconst { i18n, _ } = useLingui()",
  } as const

  for (const [name, code] of Object.entries(forms)) {
    it(`records default for ${name}`, () => {
      expect(namespaces(code, "src/a.tsx")).toEqual([DEFAULT_NAMESPACE])
    })
  }

  it("ignores an unbound t tagged template and call", () => {
    expect(namespaces("const t = (s) => s\nconst a = t`x`\nt({ id: 'a' })", "src/a.tsx")).toEqual([])
    expect(namespaces("const a = t`x`", "src/a.tsx")).toEqual([])
  })

  it("ignores an unbound i18n._ and a Trans from another module", () => {
    expect(namespaces("i18n._('id')", "src/a.tsx")).toEqual([])
    expect(namespaces("import { Trans } from 'other'\nconst a = <Trans>x</Trans>", "src/a.tsx")).toEqual([])
  })
})

describe("i18n — ngx-translate and $localize (G17)", () => {
  const COMPONENT_FILE = "src/app/orders.component.ts"

  const attribute = (name: string, kind: TemplateAttribute["kind"], value: string | null = null): TemplateAttribute => ({
    name,
    kind,
    arg: kind === "static" ? null : name,
    static: kind === "static" ? value ?? "" : null,
    expression: kind === "static" ? null : value,
    pos: 10,
    line: 1,
  })

  const element = (attributes: readonly TemplateAttribute[]): TemplateElement => ({
    tag: "span",
    names: ["span"],
    kind: "element",
    pos: 4,
    end: 40,
    line: 1,
    attributes,
    guard: { condition: null, repeated: false, lazy: false },
    slotName: null,
  })

  const expression = (text: string, pipes: readonly string[]): TemplateExpression => ({
    text,
    pos: 20,
    end: 30,
    line: 1,
    origin: "interpolation",
    pipes,
  })

  const doc = (
    content: Partial<Pick<TemplateDoc, "elements" | "expressions">>,
    framework: TemplateDoc["framework"] = "angular",
  ): TemplateDoc => ({
    framework,
    file: "src/app/orders.component.html",
    owner: "OrdersComponent",
    partial: false,
    elements: content.elements ?? [],
    expressions: content.expressions ?? [],
    unsupported: [],
  })

  const withTemplate = (template: TemplateDoc, code = "export class OrdersComponent {}") =>
    valuesOf(
      createRegistry({ extractors: [createI18nExtractor()] }).run(
        createExtractContext({ ts, file: COMPONENT_FILE, source: parse(code, COMPONENT_FILE), templates: [template] }),
      ),
      "i18nNamespaces",
    )

  it("emits the default namespace for the translate pipe", () => {
    expect(withTemplate(doc({ expressions: [expression("'orders.title' | translate", ["translate"])] }))).toEqual([
      DEFAULT_NAMESPACE,
    ])
  })

  it("emits the default namespace for a static or bound translate directive", () => {
    expect(withTemplate(doc({ elements: [element([attribute("translate", "static", "orders.title")])] }))).toEqual([
      DEFAULT_NAMESPACE,
    ])
    expect(withTemplate(doc({ elements: [element([attribute("translate", "bound", "key")])] }))).toEqual([DEFAULT_NAMESPACE])
  })

  it("ignores the HTML translate=\"no\" attribute and an event named translate", () => {
    expect(withTemplate(doc({ elements: [element([attribute("translate", "static", "no")])] }))).toEqual([])
    expect(withTemplate(doc({ elements: [element([attribute("translate", "event", "go()")])] }))).toEqual([])
  })

  it("emits the default namespace for i18n and i18n-* attributes", () => {
    expect(withTemplate(doc({ elements: [element([attribute("i18n", "static", "@@title")])] }))).toEqual([DEFAULT_NAMESPACE])
    expect(withTemplate(doc({ elements: [element([attribute("i18n-title", "static")])] }))).toEqual([DEFAULT_NAMESPACE])
  })

  it("ignores Angular markers in a non-Angular template", () => {
    const vueDoc = doc(
      {
        elements: [element([attribute("translate", "static", "k"), attribute("i18n", "static")])],
        expressions: [expression("x | translate", ["translate"])],
      },
      "vue",
    )
    expect(withTemplate(vueDoc)).toEqual([])
  })

  const translateService = (members: string, body: string): string =>
    [
      "import { Component, inject } from '@angular/core'",
      "import { TranslateService } from '@ngx-translate/core'",
      `export class OrdersComponent { ${members} load() { ${body} } }`,
    ].join("\n")

  it("emits the default namespace for TranslateService.instant/get/stream", () => {
    expect(namespaces(translateService("constructor(private translate: TranslateService) {}", "return this.translate.instant('a')"), COMPONENT_FILE)).toEqual([
      DEFAULT_NAMESPACE,
    ])
    expect(namespaces(translateService("private readonly t = inject(TranslateService);", "return this.t.get('a')"), COMPONENT_FILE)).toEqual([
      DEFAULT_NAMESPACE,
    ])
    expect(namespaces(translateService("constructor(public translate: TranslateService) {}", "return this.translate.stream('a')"), COMPONENT_FILE)).toEqual([
      DEFAULT_NAMESPACE,
    ])
  })

  it("ignores other TranslateService methods and a same-named local service", () => {
    expect(namespaces(translateService("constructor(private translate: TranslateService) {}", "return this.translate.use('en')"), COMPONENT_FILE)).toEqual([])
    const local = "class TranslateService { instant(k: string) { return k } }\nexport class C { constructor(private translate: TranslateService) {} f() { return this.translate.instant('a') } }"
    expect(namespaces(local, COMPONENT_FILE)).toEqual([])
  })

  it("emits the default namespace for a $localize tagged template", () => {
    expect(namespaces("export const title = $localize`:@@title:Orders`", COMPONENT_FILE)).toEqual([DEFAULT_NAMESPACE])
  })

  it("ignores a locally declared $localize tag", () => {
    expect(namespaces("const $localize = (s: TemplateStringsArray) => s\nexport const t = $localize`x`", COMPONENT_FILE)).toEqual([])
  })

  it("leaves a non-Angular project unchanged", () => {
    expect(namespaces("const translate = { instant: (k) => k }\ntranslate.instant('a')\nhtml`<p>${x}</p>`")).toEqual([])
  })
})
