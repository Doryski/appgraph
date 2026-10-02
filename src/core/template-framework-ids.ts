import type { TemplateApplicability, TemplateFrameworkSpec } from "./template-frameworks.js"

export type TemplateFrameworkIdentity = Pick<TemplateFrameworkSpec<unknown>, "id" | "packages" | "appliesTo">

const VUE_DEPENDENCIES = ["vue", "nuxt"] as const

const ANGULAR_CORE_DEPENDENCY = "@angular/core"

export const VUE_FRAMEWORK_IDENTITY = {
  id: "vue",
  packages: [
    { specifier: "vue/compiler-sfc", manifest: "vue/package.json" },
    { specifier: "@vue/compiler-sfc", manifest: "@vue/compiler-sfc/package.json" },
  ],
  appliesTo: ({ dependencies }) => VUE_DEPENDENCIES.some((name) => dependencies.has(name)),
} as const satisfies TemplateFrameworkIdentity

export const ANGULAR_FRAMEWORK_IDENTITY = {
  id: "angular",
  packages: [{ specifier: "@angular/compiler", manifest: "@angular/compiler/package.json" }],
  appliesTo: ({ dependencies }) => dependencies.has(ANGULAR_CORE_DEPENDENCY),
} as const satisfies TemplateFrameworkIdentity

export const TEMPLATE_FRAMEWORK_IDENTITIES: readonly TemplateFrameworkIdentity[] = [VUE_FRAMEWORK_IDENTITY, ANGULAR_FRAMEWORK_IDENTITY]

export const applicableFrameworks = <Spec extends TemplateFrameworkIdentity>(
  frameworks: readonly Spec[],
  input: TemplateApplicability,
): readonly Spec[] => frameworks.filter((spec) => spec.appliesTo(input))
