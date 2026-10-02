import { describe, expect, it } from "vitest"
import { buildNuxtComponentIndex, lookupAmbient } from "../../src/adapters/nuxt-components"

const opnformDirs = [
  { path: "components/forms/core", pathPrefix: false },
  { path: "components/forms/heavy", pathPrefix: false },
  { path: "components/global", pathPrefix: false },
  { path: "components/pages", pathPrefix: false },
  { path: "components", pathPrefix: true },
] as const

const defaultDirs = [{ path: "components", pathPrefix: true }] as const

const namesOf = (dirs: Parameters<typeof buildNuxtComponentIndex>[0], files: string[]) =>
  Object.fromEntries(buildNuxtComponentIndex(dirs, files).byName)

describe("buildNuxtComponentIndex", () => {
  it.each([
    ["components/base/BaseButton.vue", "BaseButton"],
    ["components/foo/FooBar.vue", "FooBar"],
    ["components/base/foo/Button.vue", "BaseFooButton"],
    ["components/base/(foo)/Button.vue", "BaseButton"],
    ["components/Card/index.vue", "Card"],
    ["components/index.vue", ""],
    ["components/Map.client.vue", "Map"],
    ["components/Map.server.vue", "Map"],
    ["components/my-widget.vue", "MyWidget"],
    ["components/my_widget.vue", "MyWidget"],
    ["components/a/b/Widget.tsx", "ABWidget"],
  ])("%s -> %s", (file, name) => {
    const { byName } = buildNuxtComponentIndex(defaultDirs, [file])
    expect([...byName.keys()]).toEqual(name === "" ? [] : [name])
  })

  it("applies dir prefix with and without pathPrefix", () => {
    const dirs = [
      { path: "components/special", pathPrefix: true, prefix: "Special" },
      { path: "components/flat", pathPrefix: false, prefix: "Flat" },
    ]
    expect(namesOf(dirs, ["components/special/Btn.vue", "components/flat/x/Btn.vue"])).toEqual({
      SpecialBtn: "components/special/Btn.vue",
      FlatBtn: "components/flat/x/Btn.vue",
    })
  })

  it("uses the directory name for index.vue when pathPrefix is false", () => {
    const dirs = [{ path: "components", pathPrefix: false }]
    expect(namesOf(dirs, ["components/Card/index.vue"])).toEqual({ Card: "components/Card/index.vue" })
  })

  it("supports the root dir", () => {
    const dirs = [{ path: ".", pathPrefix: true }]
    expect(namesOf(dirs, ["Foo.vue", "ui/Bar.vue"])).toEqual({ Foo: "Foo.vue", UiBar: "ui/Bar.vue" })
  })

  it("ignores files outside every dir", () => {
    expect(namesOf(defaultDirs, ["pages/Index.vue"])).toEqual({})
  })

  it("follows OpnForm shapes: first matching dir wins", () => {
    const files = [
      "components/forms/core/TextInput.vue",
      "components/forms/heavy/RichEditor.vue",
      "components/global/Loader.vue",
      "components/pages/Hero.vue",
      "components/open/forms/Thing.vue",
      "components/forms/Other.vue",
      "components/open/OpenForm.vue",
    ]
    expect(namesOf(opnformDirs, files)).toEqual({
      TextInput: "components/forms/core/TextInput.vue",
      RichEditor: "components/forms/heavy/RichEditor.vue",
      Loader: "components/global/Loader.vue",
      Hero: "components/pages/Hero.vue",
      OpenFormsThing: "components/open/forms/Thing.vue",
      FormsOther: "components/forms/Other.vue",
      OpenForm: "components/open/OpenForm.vue",
    })
  })

  it("reports a collision and omits the name from byName", () => {
    const index = buildNuxtComponentIndex(opnformDirs, [
      "components/pages/Hero.vue",
      "components/global/Hero.vue",
      "components/Solo.vue",
    ])
    expect(index.byName.has("Hero")).toBe(false)
    expect(index.byName.get("Solo")).toBe("components/Solo.vue")
    expect(index.collisions).toEqual([
      { name: "Hero", files: ["components/global/Hero.vue", "components/pages/Hero.vue"] },
    ])
  })

  it("is independent of file order", () => {
    const files = ["components/b/X.vue", "components/B/X.vue", "components/A.vue"]
    const forward = buildNuxtComponentIndex(defaultDirs, files)
    const backward = buildNuxtComponentIndex(defaultDirs, [...files].reverse())
    expect(backward.collisions).toEqual(forward.collisions)
    expect([...backward.byName]).toEqual([...forward.byName])
  })
})

describe("client and server variants", () => {
  it("treats .client/.server files of one component as variants, preferring the plain file", () => {
    const plain = buildNuxtComponentIndex(defaultDirs, [
      "components/Map.server.vue",
      "components/Map.client.vue",
      "components/Map.vue",
    ])
    expect(plain.byName.get("Map")).toBe("components/Map.vue")
    expect(plain.collisions).toEqual([])
    const paired = buildNuxtComponentIndex(defaultDirs, ["components/Map.server.vue", "components/Map.client.vue"])
    expect(paired.byName.get("Map")).toBe("components/Map.client.vue")
  })
})

describe("lookupAmbient", () => {
  const index = buildNuxtComponentIndex(defaultDirs, [
    "components/base/BaseButton.vue",
    "components/Map.client.vue",
  ])

  it("resolves PascalCase and kebab tags", () => {
    expect(lookupAmbient(index, "BaseButton")).toEqual({ file: "components/base/BaseButton.vue", lazy: false })
    expect(lookupAmbient(index, "base-button")).toEqual({ file: "components/base/BaseButton.vue", lazy: false })
  })

  it("resolves Lazy-prefixed tags", () => {
    expect(lookupAmbient(index, "LazyMap")).toEqual({ file: "components/Map.client.vue", lazy: true })
    expect(lookupAmbient(index, "lazy-base-button")).toEqual({
      file: "components/base/BaseButton.vue",
      lazy: true,
    })
  })

  it("returns undefined for unknown or collided names", () => {
    expect(lookupAmbient(index, "Nope")).toBeUndefined()
    expect(lookupAmbient(index, "LazyNope")).toBeUndefined()
  })
})
