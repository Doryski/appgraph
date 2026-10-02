import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { planExpoRoutes, sharedRouteWinner, type ExpoRoutePlan } from "../../src/adapters/expo-routes.js"
import { NATIVE_PLATFORMS, TV_PLATFORM } from "../../src/core/platform.js"
import { sortStrings } from "../../src/core/order.js"

const NATIVE = { platforms: [...NATIVE_PLATFORMS] }

const WITH_TV = { platforms: [...NATIVE_PLATFORMS, TV_PLATFORM] }

const STREAMYFIN_FILES = [
  "(auth)/(tabs)/(custom-links)/_layout.tsx",
  "(auth)/(tabs)/(custom-links)/index.tsx",
  "(auth)/(tabs)/(favorites)/_layout.tsx",
  "(auth)/(tabs)/(favorites)/index.tsx",
  "(auth)/(tabs)/(favorites)/see-all.tsx",
  "(auth)/(tabs)/(home)/_layout.tsx",
  "(auth)/(tabs)/(home)/companion-login.tsx",
  "(auth)/(tabs)/(home)/downloads/index.tsx",
  "(auth)/(tabs)/(home)/index.tsx",
  "(auth)/(tabs)/(home)/sessions/index.tsx",
  "(auth)/(tabs)/(home)/settings.tsx",
  "(auth)/(tabs)/(home)/settings.tv.tsx",
  "(auth)/(tabs)/(home)/settings/appearance/hide-libraries/page.tsx",
  "(auth)/(tabs)/(home)/settings/appearance/page.tsx",
  "(auth)/(tabs)/(home)/settings/audio-subtitles/page.tsx",
  "(auth)/(tabs)/(home)/settings/hide-libraries/page.tsx",
  "(auth)/(tabs)/(home)/settings/intro/page.tsx",
  "(auth)/(tabs)/(home)/settings/logs/page.tsx",
  "(auth)/(tabs)/(home)/settings/music/page.tsx",
  "(auth)/(tabs)/(home)/settings/network/page.tsx",
  "(auth)/(tabs)/(home)/settings/playback-controls/page.tsx",
  "(auth)/(tabs)/(home)/settings/plugins/kefinTweaks/page.tsx",
  "(auth)/(tabs)/(home)/settings/plugins/marlin-search/page.tsx",
  "(auth)/(tabs)/(home)/settings/plugins/page.tsx",
  "(auth)/(tabs)/(home)/settings/plugins/seerr/page.tsx",
  "(auth)/(tabs)/(home)/settings/plugins/streamystats/page.tsx",
  "(auth)/(tabs)/(home)/settings/segment-skip/page.tsx",
  "(auth)/(tabs)/(home,libraries,search,favorites,watchlists)/collections/[collectionId].tsx",
  "(auth)/(tabs)/(home,libraries,search,favorites,watchlists)/items/page.tsx",
  "(auth)/(tabs)/(home,libraries,search,favorites,watchlists)/livetv/_layout.tsx",
  "(auth)/(tabs)/(home,libraries,search,favorites,watchlists)/livetv/channels.tsx",
  "(auth)/(tabs)/(home,libraries,search,favorites,watchlists)/livetv/guide.tsx",
  "(auth)/(tabs)/(home,libraries,search,favorites,watchlists)/livetv/programs.tsx",
  "(auth)/(tabs)/(home,libraries,search,favorites,watchlists)/livetv/recordings.tsx",
  "(auth)/(tabs)/(home,libraries,search,favorites,watchlists)/music/album/[albumId].tsx",
  "(auth)/(tabs)/(home,libraries,search,favorites,watchlists)/music/artist/[artistId].tsx",
  "(auth)/(tabs)/(home,libraries,search,favorites,watchlists)/music/playlist/[playlistId].tsx",
  "(auth)/(tabs)/(home,libraries,search,favorites,watchlists)/persons/[personId].tsx",
  "(auth)/(tabs)/(home,libraries,search,favorites,watchlists)/seerr/company/[companyId].tsx",
  "(auth)/(tabs)/(home,libraries,search,favorites,watchlists)/seerr/genre/[genreId].tsx",
  "(auth)/(tabs)/(home,libraries,search,favorites,watchlists)/seerr/page.tsx",
  "(auth)/(tabs)/(home,libraries,search,favorites,watchlists)/seerr/person/[personId].tsx",
  "(auth)/(tabs)/(home,libraries,search,favorites,watchlists)/series/[id].tsx",
  "(auth)/(tabs)/(libraries)/[libraryId].tsx",
  "(auth)/(tabs)/(libraries)/_layout.tsx",
  "(auth)/(tabs)/(libraries)/index.tsx",
  "(auth)/(tabs)/(libraries)/music/[libraryId]/_layout.tsx",
  "(auth)/(tabs)/(libraries)/music/[libraryId]/albums.tsx",
  "(auth)/(tabs)/(libraries)/music/[libraryId]/artists.tsx",
  "(auth)/(tabs)/(libraries)/music/[libraryId]/playlists.tsx",
  "(auth)/(tabs)/(libraries)/music/[libraryId]/suggestions.tsx",
  "(auth)/(tabs)/(search)/_layout.tsx",
  "(auth)/(tabs)/(search)/index.tsx",
  "(auth)/(tabs)/(settings)/_layout.tsx",
  "(auth)/(tabs)/(settings)/index.tsx",
  "(auth)/(tabs)/(watchlists)/[watchlistId].tsx",
  "(auth)/(tabs)/(watchlists)/_layout.tsx",
  "(auth)/(tabs)/(watchlists)/create.tsx",
  "(auth)/(tabs)/(watchlists)/edit/[watchlistId].tsx",
  "(auth)/(tabs)/(watchlists)/index.tsx",
  "(auth)/(tabs)/_layout.tsx",
  "(auth)/(tabs)/index.tsx",
  "(auth)/now-playing.tsx",
  "(auth)/player/_layout.tsx",
  "(auth)/player/direct-player.tsx",
  "(auth)/tv-issue-modal.tsx",
  "(auth)/tv-option-modal.tsx",
  "(auth)/tv-request-modal.tsx",
  "(auth)/tv-season-select-modal.tsx",
  "(auth)/tv-series-season-modal.tsx",
  "(auth)/tv-subtitle-modal.tsx",
  "(auth)/tv-user-switch-modal.tsx",
  "+html.tsx",
  "+not-found.tsx",
  "_layout.tsx",
  "login.tsx",
  "topshelf/item.tsx",
  "topshelf/play.tsx",
  "tv-account-action-modal.tsx",
  "tv-account-select-modal.tsx",
]

const CHERRY_FILES = [
  "(drawer)/(chat)/_layout.tsx",
  "(drawer)/(chat)/index.tsx",
  "(drawer)/(chat)/remote.tsx",
  "(drawer)/_layout.tsx",
  "README.md",
  "_layout.tsx",
  "agents/[agentId]/edit.tsx",
  "agents/_layout.tsx",
  "agents/index.tsx",
  "agents/new.tsx",
  "chat-share.tsx",
  "document-export.tsx",
  "drawings/_layout.tsx",
  "drawings/index.tsx",
  "files/[fileEntryId].tsx",
  "home/_layout.tsx",
  "home/ai-usage.tsx",
  "home/index.tsx",
  "library/_layout.tsx",
  "library/index.tsx",
  "oauth/callback.tsx",
  "onboarding/_layout.tsx",
  "onboarding/connection.tsx",
  "onboarding/device-connections/index.tsx",
  "onboarding/device-connections/pair.tsx",
  "onboarding/device-connections/scan.tsx",
  "onboarding/index.tsx",
  "onboarding/model.tsx",
  "onboarding/provider-sync.tsx",
  "onboarding/provider.tsx",
  "paintings/[paintingId].tsx",
  "paintings/[paintingId]/conversation.tsx",
  "paintings/index.tsx",
  "plugins/[pluginId]/callback.tsx",
  "plugins/[pluginId]/connect.tsx",
  "plugins/[pluginId]/index.tsx",
  "plugins/_layout.tsx",
  "plugins/index.tsx",
  "plugins/mcp/[serverId].tsx",
  "plugins/tools/fetch-urls.tsx",
  "plugins/tools/web-search.tsx",
  "search.tsx",
  "settings/_layout.tsx",
  "settings/about.tsx",
  "settings/appearance.tsx",
  "settings/backup.tsx",
  "settings/device-connections/[connectionId].tsx",
  "settings/device-connections/index.tsx",
  "settings/device-connections/pair.tsx",
  "settings/device-connections/scan.tsx",
  "settings/font-size.tsx",
  "settings/index.tsx",
  "settings/model/index.tsx",
  "settings/notifications.tsx",
  "settings/permissions/[permission].tsx",
  "settings/permissions/index.tsx",
  "settings/privacy.tsx",
  "settings/profile.tsx",
  "settings/provider/[providerId]/index.tsx",
  "settings/provider/[providerId]/model-add.tsx",
  "settings/provider/[providerId]/model.tsx",
  "settings/provider/catalog.tsx",
  "settings/provider/desktop-sync.tsx",
  "settings/provider/index.tsx",
  "settings/provider/new.tsx",
]

const expectedUrls = (id: string): readonly string[] =>
  readFileSync(new URL(`../../scripts/corpus-expected/${id}.urls`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("/"))

const ownedUrls = (plan: ExpoRoutePlan): readonly string[] =>
  sortStrings(plan.screens.flatMap((screen) => (screen.url === null ? [] : [screen.url])))

const screenAt = (plan: ExpoRoutePlan, file: string) => plan.screens.find((screen) => screen.file === file)

const issuesOf = (plan: ExpoRoutePlan, kind: string) => plan.issues.filter((issue) => issue.kind === kind)

const TABS = "(auth)/(tabs)"

const GROUP_ARRAY = `${TABS}/(home,libraries,search,favorites,watchlists)`

describe("planExpoRoutes on the streamyfin shape", () => {
  const plan = planExpoRoutes(STREAMYFIN_FILES, WITH_TV)

  it("owns exactly the hand-derived E1 URL set, each once", () => {
    expect(ownedUrls(plan)).toEqual(sortStrings(expectedUrls("E1")))
  })

  it("gives / to one index file and leaves the 7 others route-only with shared-route issues", () => {
    const rootIndexFiles = [
      "(custom-links)",
      "(favorites)",
      "(home)",
      "(libraries)",
      "(search)",
      "(settings)",
      "(watchlists)",
      "",
    ].map((group) => (group === "" ? `${TABS}/index.tsx` : `${TABS}/${group}/index.tsx`))
    const onRoot = rootIndexFiles.flatMap((file) => screenAt(plan, file) ?? [])
    expect(onRoot).toHaveLength(8)
    expect(onRoot.filter((screen) => screen.url === "/").map((screen) => screen.file)).toEqual([
      `${TABS}/(custom-links)/index.tsx`,
    ])
    expect(onRoot.filter((screen) => screen.url === null)).toHaveLength(7)
    const shared = issuesOf(plan, "shared-route").filter((issue) => issue.related[0] === `${TABS}/(custom-links)/index.tsx`)
    expect(shared.map((issue) => issue.file)).toEqual([
      `${TABS}/(favorites)/index.tsx`,
      `${TABS}/(home)/index.tsx`,
      `${TABS}/(libraries)/index.tsx`,
      `${TABS}/(search)/index.tsx`,
      `${TABS}/(settings)/index.tsx`,
      `${TABS}/(watchlists)/index.tsx`,
      `${TABS}/index.tsx`,
    ])
  })

  it("resolves /:libraryId across groups by shape, not by param name", () => {
    expect(screenAt(plan, `${TABS}/(libraries)/[libraryId].tsx`)?.url).toBe("/:libraryId")
    expect(screenAt(plan, `${TABS}/(watchlists)/[watchlistId].tsx`)).toMatchObject({ url: null, params: [] })
  })

  it("keeps route names and their navigators on route-only losers", () => {
    expect(screenAt(plan, `${TABS}/(home)/index.tsx`)?.routes).toEqual([
      { name: `${TABS}/(home)/index`, navigator: `${TABS}/(home)` },
    ])
  })

  it("gives each of the 15 group-array files one screen carrying all 5 expanded names", () => {
    const arrayScreens = plan.screens.filter((screen) => screen.file.startsWith(`${GROUP_ARRAY}/`))
    expect(arrayScreens).toHaveLength(15)
    expect(arrayScreens.every((screen) => screen.routes.length === 5 && screen.url !== null)).toBe(true)
    expect(screenAt(plan, `${GROUP_ARRAY}/series/[id].tsx`)?.routes).toEqual([
      { name: `${TABS}/(favorites)/series/[id]`, navigator: `${TABS}/(favorites)` },
      { name: `${TABS}/(home)/series/[id]`, navigator: `${TABS}/(home)` },
      { name: `${TABS}/(libraries)/series/[id]`, navigator: `${TABS}/(libraries)` },
      { name: `${TABS}/(search)/series/[id]`, navigator: `${TABS}/(search)` },
      { name: `${TABS}/(watchlists)/series/[id]`, navigator: `${TABS}/(watchlists)` },
    ])
  })

  it("puts group-array livetv screens under the group-array livetv layout", () => {
    expect(screenAt(plan, `${GROUP_ARRAY}/livetv/guide.tsx`)?.routes.map((route) => route.navigator)).toEqual(
      Array.from({ length: 5 }, () => `${GROUP_ARRAY}/livetv`),
    )
  })

  it("merges settings.tsx and settings.tv.tsx into one screen with two entries", () => {
    expect(screenAt(plan, `${TABS}/(home)/settings.tsx`)).toMatchObject({
      url: "/settings",
      entries: [
        { file: `${TABS}/(home)/settings.tsx`, platform: null },
        { file: `${TABS}/(home)/settings.tv.tsx`, platform: "tv" },
      ],
    })
    expect(screenAt(plan, `${TABS}/(home)/settings.tv.tsx`)).toBeUndefined()
  })

  it("maps +not-found to a catch-all notFound screen and skips +html", () => {
    expect(screenAt(plan, "+not-found.tsx")).toMatchObject({
      url: "/*",
      kindTag: "notFound",
      routes: [{ name: "+not-found", navigator: "" }],
    })
    expect(screenAt(plan, "+html.tsx")).toBeUndefined()
  })

  it("records the 12 _layout files with their routes-relative dirs as navigator ids", () => {
    expect(plan.layouts).toHaveLength(12)
    expect(plan.layouts[0]).toMatchObject({ file: `${TABS}/(custom-links)/_layout.tsx`, dir: `${TABS}/(custom-links)` })
    expect(plan.layouts.find((layout) => layout.file === "_layout.tsx")).toMatchObject({ dir: "", navigator: "" })
  })

  it("reports only shared-route issues", () => {
    expect(new Set(plan.issues.map((issue) => issue.kind))).toEqual(new Set(["shared-route"]))
    expect(plan.issues).toHaveLength(8)
  })

  it("leaves settings.tv.tsx a separate orphan-free route when tv is not a platform", () => {
    const native = planExpoRoutes(STREAMYFIN_FILES, NATIVE)
    expect(screenAt(native, `${TABS}/(home)/settings.tv.tsx`)?.url).toBe("/settings.tv")
  })

  it("is deterministic regardless of input order", () => {
    expect(planExpoRoutes([...STREAMYFIN_FILES].reverse(), WITH_TV)).toEqual(plan)
  })
})

describe("planExpoRoutes on the cherry shape", () => {
  const plan = planExpoRoutes(CHERRY_FILES, NATIVE)

  it("owns exactly the hand-derived E2 URL set and reports no issues", () => {
    expect(ownedUrls(plan)).toEqual(sortStrings(expectedUrls("E2")))
    expect(plan.issues).toEqual([])
  })

  it("maps both paintings/[paintingId].tsx and paintings/[paintingId]/conversation.tsx", () => {
    expect(screenAt(plan, "paintings/[paintingId].tsx")?.url).toBe("/paintings/:paintingId")
    expect(screenAt(plan, "paintings/[paintingId]/conversation.tsx")?.url).toBe("/paintings/:paintingId/conversation")
  })

  it("ignores README.md and nests drawer screens under their layouts", () => {
    expect(plan.screens.some((screen) => screen.file.endsWith(".md"))).toBe(false)
    expect(screenAt(plan, "(drawer)/(chat)/index.tsx")).toMatchObject({
      url: "/",
      routes: [{ name: "(drawer)/(chat)/index", navigator: "(drawer)/(chat)" }],
    })
    expect(screenAt(plan, "settings/provider/[providerId]/model.tsx")?.routes).toEqual([
      { name: "settings/provider/[providerId]/model", navigator: "settings" },
    ])
    expect(plan.layouts).toHaveLength(10)
  })
})

describe("planExpoRoutes conventions", () => {
  it("tags foo+api.ts as an apiRoute on /foo", () => {
    const plan = planExpoRoutes(["_layout.tsx", "foo+api.ts"], NATIVE)
    expect(plan.screens).toEqual([
      {
        file: "foo+api.ts",
        url: "/foo",
        params: [],
        routes: [{ name: "foo+api", navigator: "" }],
        entries: [{ file: "foo+api.ts", platform: null }],
        kindTag: "apiRoute",
      },
    ])
  })

  it("lets a page win over an api route on the same URL", () => {
    const plan = planExpoRoutes(["foo.tsx", "foo+api.ts"], NATIVE)
    expect(plan.screens.map((screen) => screen.file)).toEqual(["foo.tsx"])
    expect(plan.issues).toEqual([
      expect.objectContaining({ kind: "route-conflict", file: "foo+api.ts", related: ["foo.tsx"] }),
    ])
  })

  it("maps a variant without a base and reports it", () => {
    const plan = planExpoRoutes(["camera.ios.tsx", "camera.android.tsx"], NATIVE)
    expect(plan.screens).toEqual([
      expect.objectContaining({
        file: "camera.android.tsx",
        url: "/camera",
        entries: [
          { file: "camera.android.tsx", platform: "android" },
          { file: "camera.ios.tsx", platform: "ios" },
        ],
      }),
    ])
    expect(plan.issues.map((issue) => [issue.kind, issue.file])).toEqual([
      ["orphan-platform-variant", "camera.android.tsx"],
      ["orphan-platform-variant", "camera.ios.tsx"],
    ])
  })

  it("resolves a.tsx versus a/index.tsx by code point with a route-conflict", () => {
    const plan = planExpoRoutes(["a/index.tsx", "a.tsx"], NATIVE)
    expect(plan.screens.map((screen) => [screen.file, screen.url])).toEqual([["a.tsx", "/a"]])
    expect(plan.issues).toEqual([
      expect.objectContaining({ kind: "route-conflict", file: "a/index.tsx", related: ["a.tsx"] }),
    ])
  })

  it.each([
    [["[...rest].tsx", "+not-found.tsx"], "[...rest].tsx", "+not-found.tsx", "/*"],
    [["+not-found.tsx", "[...rest].tsx"], "[...rest].tsx", "+not-found.tsx", "/*"],
    [["docs/[...slug].tsx", "docs/+not-found.tsx"], "docs/[...slug].tsx", "docs/+not-found.tsx", "/docs/*"],
    [["(app)/[...rest].tsx", "+not-found.tsx"], "(app)/[...rest].tsx", "+not-found.tsx", "/*"],
  ])("lets the explicit catch-all in %j beat +not-found", (files, owner, dropped, url) => {
    const plan = planExpoRoutes(files, NATIVE)
    expect(plan.screens.map((screen) => [screen.file, screen.url, screen.kindTag])).toEqual([[owner, url, null]])
    expect(plan.issues).toEqual([
      expect.objectContaining({ kind: "shadowed-not-found", file: dropped, related: [owner] }),
    ])
  })

  it("keeps a lone +not-found as the notFound screen and lets it beat an api route", () => {
    const plan = planExpoRoutes(["+not-found.tsx", "[...rest]+api.ts"], NATIVE)
    expect(plan.screens.map((screen) => [screen.file, screen.url, screen.kindTag])).toEqual([
      ["+not-found.tsx", "/*", "notFound"],
    ])
    expect(plan.issues.map((issue) => [issue.kind, issue.file])).toEqual([["route-conflict", "[...rest]+api.ts"]])
  })

  it.each([
    [["tabs/_layout.ios.tsx", "tabs/home.tsx"], [["orphan-platform-variant", "tabs/_layout.ios.tsx"]]],
    [["tabs/_layout.tsx", "tabs/_layout.web.tsx", "tabs/home.tsx"], []],
  ])("plans the platform-suffixed layouts in %j under the tabs navigator", (files, issues) => {
    const plan = planExpoRoutes(files, NATIVE)
    expect(plan.layouts).toEqual([expect.objectContaining({ dir: "tabs", navigator: "tabs" })])
    expect(plan.screens[0]?.routes).toEqual([{ name: "tabs/home", navigator: "tabs" }])
    expect(plan.issues.map((issue) => [issue.kind, issue.file])).toEqual(issues)
  })

  it("says an orphan layout variant is used as the layout, not mapped to a screen", () => {
    const [issue] = planExpoRoutes(["tabs/_layout.ios.tsx"], NATIVE).issues
    expect(issue?.message).toContain("it is used as the layout")
    expect(issue?.message).not.toContain("screen")
  })

  it("skips +native-intent, +middleware, _sitemap and non-script files", () => {
    const plan = planExpoRoutes(["+native-intent.ts", "+middleware.ts", "_sitemap.tsx", "notes.md", "logo.png"], NATIVE)
    expect(plan).toEqual({ screens: [], layouts: [], issues: [] })
  })

  it("treats a _-prefixed file other than _layout and _sitemap as a route", () => {
    expect(planExpoRoutes(["_hidden.tsx"], NATIVE).screens[0]?.url).toBe("/_hidden")
  })
})

describe("sharedRouteWinner", () => {
  it.each([
    [["(b)/index.tsx", "(a)/index.tsx"], "(a)/index.tsx"],
    [["(tabs)/index.tsx", "(tabs)/(home)/index.tsx"], "(tabs)/(home)/index.tsx"],
    [["(z)/x.tsx", "(a,z)/x.tsx"], "(a,z)/x.tsx"],
  ])("picks the first group-qualified route name by code point from %j", (files, winner) => {
    const candidates = files.map((file) => ({
      file,
      routeNames: sortStrings(
        file.startsWith("(a,z)") ? ["(a)/x", "(z)/x"] : [file.replace(/\.tsx$/, "")],
      ),
    }))
    expect(sharedRouteWinner(candidates)?.file).toBe(winner)
  })

  it("returns null for no candidates", () => {
    expect(sharedRouteWinner([])).toBeNull()
  })
})
