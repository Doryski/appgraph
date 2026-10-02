import { describe, expect, it } from "vitest"
import type { Registration } from "../../src/adapters/react-navigation-registry.js"
import { readRegistrations } from "../../src/adapters/react-navigation-registry.js"
import { discoverBench } from "./discover-harness.js"

const NAVIGATION = [
  `import {createBottomTabNavigator} from '@react-navigation/bottom-tabs'`,
  `import {createNativeStackNavigatorWithAuth} from './createNativeStackNavigatorWithAuth'`,
  `import {HomeScreen} from './screens/Home'`,
  `import {ListsScreen} from './screens/Lists'`,
  `import {ProfileScreen} from './screens/Profile'`,
  `import {MessagesScreen} from './screens/Messages'`,
  ``,
  `const HomeTab = createNativeStackNavigatorWithAuth<HomeParams>()`,
  `const MyProfileTab = createNativeStackNavigatorWithAuth<ProfileParams>()`,
  `const Flat = createNativeStackNavigatorWithAuth<FlatParams>()`,
  `const Tab = createBottomTabNavigator<TabParams>()`,
  ``,
  `function NotFoundScreen() { return null }`,
  ``,
  `function commonScreens(Stack: typeof Flat, label?: string) {`,
  `  return (`,
  `    <>`,
  `      <Stack.Screen name="NotFound" getComponent={() => NotFoundScreen} options={{title: label}} />`,
  `      <Stack.Screen name="Lists" component={ListsScreen} options={{title: label, requireAuth: true}} />`,
  `    </>`,
  `  )`,
  `}`,
  ``,
  `function HomeTabNavigator() {`,
  `  return (`,
  `    <HomeTab.Navigator initialRouteName="Home">`,
  `      <HomeTab.Screen name="Home" getComponent={() => HomeScreen} />`,
  `      {commonScreens(HomeTab as typeof Flat)}`,
  `    </HomeTab.Navigator>`,
  `  )`,
  `}`,
  ``,
  `function MyProfileTabNavigator() {`,
  `  return (`,
  `    <MyProfileTab.Navigator>`,
  `      <MyProfileTab.Screen name={'MyProfile' as 'Profile'} getComponent={() => ProfileScreen} />`,
  `      {commonScreens(MyProfileTab as unknown as typeof Flat)}`,
  `    </MyProfileTab.Navigator>`,
  `  )`,
  `}`,
  ``,
  `export function TabsNavigator({isSignedIn, extra}: Props) {`,
  `  return (`,
  `    <Tab.Navigator>`,
  `      <Tab.Screen name="HomeTab" getComponent={() => HomeTabNavigator} />`,
  `      <Tab.Group>`,
  `        {isSignedIn ? (`,
  `          <Tab.Screen name="MyProfileTab" component={MyProfileTabNavigator} />`,
  `        ) : (`,
  `          <Tab.Screen name="SignIn" component={HomeScreen} />`,
  `        )}`,
  `      </Tab.Group>`,
  `      <Tab.Screen name={extra} component={HomeScreen} />`,
  `    </Tab.Navigator>`,
  `  )`,
  `}`,
  ``,
  `export const FlatNavigator = () => (`,
  `  <Flat.Navigator>`,
  `    <Flat.Screen`,
  `      name="Messages"`,
  `      getComponent={() => MessagesScreen}`,
  `      options={({route}) => ({requireAuth: true, gestureEnabled: false, animation: route.params})}`,
  `    />`,
  `    <Flat.Screen name="Inline">{(props) => <ProfileScreen {...props} />}</Flat.Screen>`,
  `    {commonScreens(Flat)}`,
  `  </Flat.Navigator>`,
  `)`,
  ``,
].join("\n")

const STATIC = [
  `import {createNativeStackNavigator, createNativeStackScreen} from '@react-navigation/native-stack'`,
  `import {createBottomTabNavigator} from '@react-navigation/bottom-tabs'`,
  `import {FeedScreen, ProfileScreen, SettingsScreen, LoginScreen} from './screens'`,
  `import {useIsSignedIn, useIsSignedOut} from './auth'`,
  ``,
  `const HomeTabs = createBottomTabNavigator({`,
  `  screens: {`,
  `    Feed: FeedScreen,`,
  `  },`,
  `})`,
  ``,
  `export const RootStack = createNativeStackNavigator({`,
  `  screens: {`,
  `    Home: HomeTabs,`,
  `    Profile: {screen: ProfileScreen, linking: 'u/:id', if: useIsSignedIn, options: {requireAuth: true}},`,
  `    Settings: createNativeStackScreen({screen: SettingsScreen, linking: {path: 'settings'}}),`,
  `    More: {screen: createNativeStackNavigator({screens: {Deep: SettingsScreen}})},`,
  `  },`,
  `  groups: {`,
  `    Guest: {`,
  `      if: useIsSignedOut,`,
  `      screens: {`,
  `        Login: LoginScreen,`,
  `      },`,
  `    },`,
  `  },`,
  `})`,
  ``,
].join("\n")

const read = (files: Readonly<Record<string, string>>) => readRegistrations(discoverBench(files).ctx)

const summary = (registration: Registration) => ({
  name: registration.name,
  navigator: registration.navigator,
  line: registration.line,
  entry: registration.entry,
  optionKeys: registration.optionKeys,
  guardExpr: registration.guardExpr,
  linkingPath: registration.linkingPath,
  nestedNavigator: registration.nestedNavigator,
})

const byNavigator = (registrations: readonly Registration[], navigator: string) =>
  registrations.filter((registration) => registration.navigator === navigator).map((registration) => registration.name)

const find = (registrations: readonly Registration[], navigator: string, name: string | null) => {
  const found = registrations.find((registration) => registration.navigator === navigator && registration.name === name)
  if (found === undefined) throw new Error(`no ${navigator}/${String(name)}`)
  return found
}

describe("readRegistrations: JSX navigators", () => {
  const { registrations, navigators } = read({ "src/Navigation.tsx": NAVIGATION })

  it("names navigators by their bound variable, custom wrappers included", () => {
    expect(navigators.map((navigator) => [navigator.id, navigator.factory, navigator.line])).toEqual([
      ["HomeTab", "createNativeStackNavigatorWithAuth", 8],
      ["MyProfileTab", "createNativeStackNavigatorWithAuth", 9],
      ["Flat", "createNativeStackNavigatorWithAuth", 10],
      ["Tab", "createBottomTabNavigator", 11],
    ])
  })

  it("attributes helper screens to each caller's navigator, through `as` casts", () => {
    expect(byNavigator(registrations, "HomeTab")).toEqual(["Home", "NotFound", "Lists"])
    expect(byNavigator(registrations, "MyProfileTab")).toEqual(["MyProfile", "NotFound", "Lists"])
    expect(byNavigator(registrations, "Flat")).toEqual(["Messages", "Inline", "NotFound", "Lists"])
    expect(byNavigator(registrations, "Tab")).toEqual(["HomeTab", "MyProfileTab", "SignIn", null])
  })

  it("reads getComponent through the returned identifier and component through bindings", () => {
    expect(find(registrations, "HomeTab", "NotFound").entry).toEqual({
      kind: "file",
      file: "src/Navigation.tsx",
      exportName: "NotFoundScreen",
    })
    expect(find(registrations, "HomeTab", "Home").entry).toEqual({
      kind: "binding",
      from: "src/Navigation.tsx",
      local: "HomeScreen",
    })
    expect(find(registrations, "Flat", "Lists").entry).toEqual({
      kind: "binding",
      from: "src/Navigation.tsx",
      local: "ListsScreen",
    })
  })

  it("reads boolean option keys from an object and from an options arrow", () => {
    expect(find(registrations, "HomeTab", "Lists").optionKeys).toEqual({ requireAuth: true })
    expect(find(registrations, "HomeTab", "NotFound").optionKeys).toEqual({})
    expect(find(registrations, "Flat", "Messages").optionKeys).toEqual({ requireAuth: true, gestureEnabled: false })
  })

  it("unwraps a cast name and gives a dynamic name null", () => {
    expect(summary(find(registrations, "MyProfileTab", "MyProfile"))).toMatchObject({ line: 36 })
    expect(summary(find(registrations, "Tab", null))).toMatchObject({ name: null, line: 53 })
  })

  it("captures the conditional JSX guard text, negation-aware", () => {
    expect(find(registrations, "Tab", "MyProfileTab").guardExpr).toBe("isSignedIn")
    expect(find(registrations, "Tab", "SignIn").guardExpr).toBe("!(isSignedIn)")
    expect(find(registrations, "Tab", "HomeTab").guardExpr).toBeNull()
  })

  it("reads a render-children screen's rendered component", () => {
    expect(find(registrations, "Flat", "Inline").entry).toEqual({
      kind: "binding",
      from: "src/Navigation.tsx",
      local: "ProfileScreen",
    })
  })
})

describe("readRegistrations: static API", () => {
  const { registrations, navigators } = read({ "src/navigation.tsx": STATIC })

  it("lists the static navigators, nested inline ones named by their screen key", () => {
    expect(navigators.map((navigator) => navigator.id)).toEqual(["HomeTabs", "RootStack", "More"])
    expect(navigators.every((navigator) => navigator.config !== null)).toBe(true)
  })

  it("reads screens, groups, linking, if and nested navigators", () => {
    expect(registrations.map(summary)).toEqual([
      {
        name: "Feed",
        navigator: "HomeTabs",
        line: 8,
        entry: { kind: "binding", from: "src/navigation.tsx", local: "FeedScreen" },
        optionKeys: {},
        guardExpr: null,
        linkingPath: null,
        nestedNavigator: null,
      },
      {
        name: "Home",
        navigator: "RootStack",
        line: 14,
        entry: null,
        optionKeys: {},
        guardExpr: null,
        linkingPath: null,
        nestedNavigator: "HomeTabs",
      },
      {
        name: "Profile",
        navigator: "RootStack",
        line: 15,
        entry: { kind: "binding", from: "src/navigation.tsx", local: "ProfileScreen" },
        optionKeys: { requireAuth: true },
        guardExpr: "useIsSignedIn",
        linkingPath: "u/:id",
        nestedNavigator: null,
      },
      {
        name: "Settings",
        navigator: "RootStack",
        line: 16,
        entry: { kind: "binding", from: "src/navigation.tsx", local: "SettingsScreen" },
        optionKeys: {},
        guardExpr: null,
        linkingPath: "settings",
        nestedNavigator: null,
      },
      {
        name: "More",
        navigator: "RootStack",
        line: 17,
        entry: null,
        optionKeys: {},
        guardExpr: null,
        linkingPath: null,
        nestedNavigator: "More",
      },
      {
        name: "Login",
        navigator: "RootStack",
        line: 23,
        entry: { kind: "binding", from: "src/navigation.tsx", local: "LoginScreen" },
        optionKeys: {},
        guardExpr: "useIsSignedOut",
        linkingPath: null,
        nestedNavigator: null,
      },
      {
        name: "Deep",
        navigator: "More",
        line: 17,
        entry: { kind: "binding", from: "src/navigation.tsx", local: "SettingsScreen" },
        optionKeys: {},
        guardExpr: null,
        linkingPath: null,
        nestedNavigator: null,
      },
    ])
  })

  it("keeps the linking node for the caller", () => {
    expect(find(registrations, "RootStack", "Profile").linkingNode?.getText()).toBe("'u/:id'")
    expect(find(registrations, "RootStack", "Home").linkingNode).toBeUndefined()
  })
})

describe("readRegistrations: edges", () => {
  it("follows a navigator imported from another file", () => {
    const { registrations } = read({
      "src/navigators.ts": `import {createStackNavigator} from '@react-navigation/stack'\nexport const Root = createStackNavigator()\n`,
      "src/App.tsx": `import {Root} from './navigators'\nimport {Home} from './Home'\nexport const App = () => <Root.Navigator><Root.Screen name="Home" component={Home} /></Root.Navigator>\n`,
    })
    expect(registrations.map((registration) => [registration.navigator, registration.name, registration.file])).toEqual([
      ["Root", "Home", "src/App.tsx"],
    ])
  })

  it("returns nothing for a file with no navigators", () => {
    expect(read({ "src/plain.tsx": `export const Plain = () => <div><Foo.Screen name="x" /></div>\n` })).toEqual({
      registrations: [],
      navigators: [],
    })
  })
})
