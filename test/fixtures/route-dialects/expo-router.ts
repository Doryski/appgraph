import type { ExpoHrefConversion, ExpoRouteConversion } from "../../../src/core/url.js"

export type ExpoRouteCase = {
  readonly description: string
  readonly input: string
  readonly platforms: readonly string[]
  readonly expected: ExpoRouteConversion
}

export type ExpoHrefCase = {
  readonly description: string
  readonly input: string
  readonly expected: ExpoHrefConversion
}

const NATIVE_PLATFORMS = ["ios", "android", "native", "web"] as const

const TV_PLATFORMS = [...NATIVE_PLATFORMS, "tv"] as const

export const expoRouteCases: readonly ExpoRouteCase[] = [
  {
    description: "root index maps to /",
    input: "index.tsx",
    platforms: NATIVE_PLATFORMS,
    expected: { url: "/", params: [], routeNames: ["index"], groups: [], platform: null },
  },
  {
    description: "nested index maps to its parent",
    input: "settings/index.tsx",
    platforms: NATIVE_PLATFORMS,
    expected: { url: "/settings", params: [], routeNames: ["settings/index"], groups: [], platform: null },
  },
  {
    description: "nested groups are dropped from the url and kept in the route name",
    input: "(auth)/(tabs)/(search)/index.tsx",
    platforms: NATIVE_PLATFORMS,
    expected: {
      url: "/",
      params: [],
      routeNames: ["(auth)/(tabs)/(search)/index"],
      groups: ["auth", "tabs", "search"],
      platform: null,
    },
  },
  {
    description: "group array expands to one route name per group",
    input: "(auth)/(tabs)/(home,libraries)/items/page.tsx",
    platforms: NATIVE_PLATFORMS,
    expected: {
      url: "/items/page",
      params: [],
      routeNames: ["(auth)/(tabs)/(home)/items/page", "(auth)/(tabs)/(libraries)/items/page"],
      groups: ["auth", "tabs", "home", "libraries"],
      platform: null,
    },
  },
  {
    description: "two group arrays expand to their product",
    input: "(a,b)/(c, d)/x.tsx",
    platforms: NATIVE_PLATFORMS,
    expected: {
      url: "/x",
      params: [],
      routeNames: ["(a)/(c)/x", "(a)/(d)/x", "(b)/(c)/x", "(b)/(d)/x"],
      groups: ["a", "b", "c", "d"],
      platform: null,
    },
  },
  {
    description: "dynamic segment [id]",
    input: "item/[id].tsx",
    platforms: NATIVE_PLATFORMS,
    expected: {
      url: "/item/:id",
      params: [{ name: "id", catchAll: false, optional: false }],
      routeNames: ["item/[id]"],
      groups: [],
      platform: null,
    },
  },
  {
    description: "catch-all [...rest]",
    input: "docs/[...rest].tsx",
    platforms: NATIVE_PLATFORMS,
    expected: {
      url: "/docs/*",
      params: [{ name: "rest", catchAll: true, optional: false }],
      routeNames: ["docs/[...rest]"],
      groups: [],
      platform: null,
    },
  },
  {
    description: "underscore prefix is not private",
    input: "_private/page.tsx",
    platforms: NATIVE_PLATFORMS,
    expected: { url: "/_private/page", params: [], routeNames: ["_private/page"], groups: [], platform: null },
  },
  {
    description: "tv suffix stripped when tv is a platform",
    input: "(auth)/(tabs)/settings.tv.tsx",
    platforms: TV_PLATFORMS,
    expected: {
      url: "/settings",
      params: [],
      routeNames: ["(auth)/(tabs)/settings"],
      groups: ["auth", "tabs"],
      platform: "tv",
    },
  },
  {
    description: "tv suffix kept literal when tv is not a platform",
    input: "(auth)/(tabs)/settings.tv.tsx",
    platforms: NATIVE_PLATFORMS,
    expected: {
      url: "/settings.tv",
      params: [],
      routeNames: ["(auth)/(tabs)/settings.tv"],
      groups: ["auth", "tabs"],
      platform: null,
    },
  },
  {
    description: "ios suffix on a dynamic leaf",
    input: "item/[id].ios.tsx",
    platforms: NATIVE_PLATFORMS,
    expected: {
      url: "/item/:id",
      params: [{ name: "id", catchAll: false, optional: false }],
      routeNames: ["item/[id]"],
      groups: [],
      platform: "ios",
    },
  },
  {
    description: "+not-found is a catch-all at its directory",
    input: "(auth)/settings/+not-found.tsx",
    platforms: NATIVE_PLATFORMS,
    expected: {
      url: "/settings/*",
      params: [{ name: "", catchAll: true, optional: false }],
      routeNames: ["(auth)/settings/+not-found"],
      groups: ["auth"],
      platform: null,
    },
  },
  {
    description: "+api suffix is dropped from the url",
    input: "foo+api.ts",
    platforms: NATIVE_PLATFORMS,
    expected: { url: "/foo", params: [], routeNames: ["foo+api"], groups: [], platform: null },
  },
]

export const expoHrefCases: readonly ExpoHrefCase[] = [
  {
    description: "group-qualified href resolves to its url and route name",
    input: "/(auth)/(tabs)/(search)/seerr/page",
    expected: { url: "/seerr/page", routeName: "(auth)/(tabs)/(search)/seerr/page" },
  },
  {
    description: "href ending on a group targets its index route name",
    input: "/(auth)/(tabs)",
    expected: { url: "/", routeName: "(auth)/(tabs)/index" },
  },
  {
    description: "bracket param becomes :id with no route name",
    input: "/item/[id]",
    expected: { url: "/item/:id", routeName: null },
  },
  {
    description: "query and hash are stripped",
    input: "/items/page?id=1#top",
    expected: { url: "/items/page", routeName: null },
  },
]
