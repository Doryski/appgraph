import { describe, expect, it } from "vitest"
import { createStoreExtractor } from "../../src/extractors/store.js"
import { ROOT, run, valuesOf } from "./harness.js"

const extractor = createStoreExtractor()

const stores = (code: string) => valuesOf(run([extractor], code), "stores")

describe("store — zustand creation site, binding-aware", () => {
  it("finds a curried create() call and names it after the assigned variable", () => {
    const code = [
      "import { create } from 'zustand'",
      "export const useBearStore = create()((set) => ({ bears: 0 }))",
    ].join("\n")

    expect(stores(code)).toEqual(["useBearStore"])
  })

  it("finds an aliased import of create", () => {
    const code = [
      "import { create as createStore } from 'zustand'",
      "export const useBearStore = createStore((set) => ({ bears: 0 }))",
    ].join("\n")

    expect(stores(code)).toEqual(["useBearStore"])
  })

  it("ignores a local function named create that is not from zustand", () => {
    const code = ["const create = () => (fn) => fn", "const useBearStore = create()((set) => ({}))"].join("\n")
    expect(stores(code)).toEqual([])
  })

  it("ignores create imported from an unrelated module", () => {
    const code = [
      "import { create } from 'some-factory-lib'",
      "const useBearStore = create()((set) => ({}))",
    ].join("\n")

    expect(stores(code)).toEqual([])
  })
})

describe("store — zustand usage confirmed within the same file", () => {
  it("dedupes the usage call against the creation site", () => {
    const code = [
      "import { create } from 'zustand'",
      "export const useBearStore = create()((set) => ({ bears: 0 }))",
      "function Counter() { const bears = useBearStore((s) => s.bears); return bears }",
    ].join("\n")

    expect(stores(code)).toEqual(["useBearStore"])
  })
})

describe("store — the /^use\\w*Store$/ fallback fires ONLY for an unresolvable import, never for a local", () => {
  it("does NOT flag a local function shaped like a store hook", () => {
    const code = ["function useValidationStore() { return {} }", "useValidationStore()"].join("\n")
    expect(stores(code)).toEqual([])
  })

  it("flags an imported *Store hook whose origin file this pass cannot verify, with a diagnostic", () => {
    const code = ["import { useBearStore } from '../stores/bear'", "useBearStore()"].join("\n")
    const result = run([extractor], code)

    expect(valuesOf(result, "stores")).toEqual(["useBearStore"])
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "stores/name-fallback", severity: "info" }),
    )
  })

  it("does not flag an imported hook that does not match the fallback pattern", () => {
    const code = ["import { useBearHelpers } from '../stores/bear'", "useBearHelpers()"].join("\n")
    expect(stores(code)).toEqual([])
  })

  it.each(["import { configureStore } from 'some-lib'", "import { createStore } from 'solid-js/store'"])(
    "does not flag a non-hook factory whose name ends in Store (%s)",
    (importLine) => {
      const code = [importLine, `${importLine.includes("configure") ? "configureStore" : "createStore"}({})`].join("\n")
      expect(stores(code)).toEqual([])
    },
  )

  it.each([
    "import { useSyncExternalStore } from 'react'",
    "import { useSyncExternalStore } from 'use-sync-external-store/shim'",
    "import * as React from 'react'\nconst { useSyncExternalStore } = React",
  ])("does not flag React's useSyncExternalStore (%s)", (importLine) => {
    const code = [importLine, "useSyncExternalStore(subscribe, getSnapshot)"].join("\n")
    const result = run([extractor], code)

    expect(valuesOf(result, "stores")).toEqual([])
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: "stores/name-fallback" }))
  })
})

describe("store — redux", () => {
  it("finds useSelector and useDispatch from react-redux as 'redux'", () => {
    const code = [
      "import { useSelector, useDispatch } from 'react-redux'",
      "useSelector((s) => s.orders)",
      "useDispatch()",
    ].join("\n")

    expect(stores(code)).toEqual(["redux"])
  })

  it("ignores useSelector from an unrelated module", () => {
    expect(stores(["import { useSelector } from 'reselect'", "useSelector((s) => s)"].join("\n"))).toEqual([])
  })
})

describe("store — jotai", () => {
  it("names the store after the atom identifier", () => {
    const code = ["import { useAtom } from 'jotai'", "const [count, setCount] = useAtom(countAtom)"].join("\n")
    expect(stores(code)).toEqual(["countAtom"])
  })

  it("finds useAtomValue and useSetAtom too", () => {
    const code = [
      "import { useAtomValue, useSetAtom } from 'jotai'",
      "useAtomValue(countAtom)",
      "useSetAtom(countAtom)",
    ].join("\n")

    expect(stores(code)).toEqual(["countAtom"])
  })
})

describe("store — mobx", () => {
  it("names a class store after the class when makeAutoObservable runs in its constructor", () => {
    const code = [
      "import { makeAutoObservable } from 'mobx'",
      "class BearStore {",
      "  constructor() { makeAutoObservable(this) }",
      "}",
    ].join("\n")

    expect(stores(code)).toEqual(["BearStore"])
  })

  it("names a wrapped component after its argument via mobx-react-lite's observer", () => {
    const code = ["import { observer } from 'mobx-react-lite'", "export default observer(BearCounter)"].join(
      "\n",
    )

    expect(stores(code)).toEqual(["BearCounter"])
  })

  it("ignores makeAutoObservable imported from an unrelated module", () => {
    const code = ["import { makeAutoObservable } from 'my-utils'", "makeAutoObservable(this)"].join("\n")
    expect(stores(code)).toEqual([])
  })
})

describe("store — valtio", () => {
  it("names a proxy() creation site after its variable and dedupes useSnapshot of it", () => {
    const code = [
      "import { proxy, useSnapshot } from 'valtio'",
      "export const cartState = proxy({ items: [] })",
      "function Cart() { const snap = useSnapshot(cartState); return snap }",
    ].join("\n")

    expect(stores(code)).toEqual(["cartState"])
  })

  it("names useSnapshot after its argument when the proxy is imported", () => {
    const code = ["import { useSnapshot } from 'valtio'", "import { cartState } from './state'", "useSnapshot(cartState)"].join(
      "\n",
    )
    expect(stores(code)).toEqual(["cartState"])
  })

  it("records 'valtio' for a snapshot of an expression", () => {
    expect(stores(["import { useSnapshot } from 'valtio'", "useSnapshot(state.cart)"].join("\n"))).toEqual(["valtio"])
  })

  it("ignores proxy imported from an unrelated module", () => {
    expect(stores(["import { proxy } from 'http-proxy'", "const server = proxy({})"].join("\n"))).toEqual([])
  })

  it("does not take the name fallback for an aliased proxy ending in Store", () => {
    const code = ["import { proxy as createStore } from 'valtio'", "export const cart = createStore({})"].join("\n")
    expect(stores(code)).toEqual(["cart"])
  })
})

describe("store — Redux Toolkit and plain redux", () => {
  it("names each createSlice after its literal name", () => {
    const code = [
      "import { createSlice } from '@reduxjs/toolkit'",
      "const SLICE = 'invoices'",
      "export const ordersSlice = createSlice({ name: 'orders', initialState, reducers: {} })",
      "export const invoicesSlice = createSlice({ name: SLICE, initialState, reducers: {} })",
    ].join("\n")

    expect(stores(code)).toEqual(["orders", "invoices"])
  })

  it("falls back to 'redux' for a slice whose name does not fold", () => {
    const code = ["import { createSlice } from '@reduxjs/toolkit'", "createSlice({ name: makeName(), reducers: {} })"].join(
      "\n",
    )
    expect(stores(code)).toEqual(["redux"])
  })

  it("records configureStore, redux createStore and legacy_createStore as the 'redux' store", () => {
    expect(stores("import { configureStore } from '@reduxjs/toolkit'\nexport const store = configureStore({ reducer })")).toEqual([
      "redux",
    ])
    expect(stores("import { createStore } from 'redux'\nexport const store = createStore(reducer)")).toEqual(["redux"])
    expect(stores("import { legacy_createStore as make } from 'redux'\nconst store = make(reducer)")).toEqual(["redux"])
  })

  it("ignores createSlice or createStore from unrelated modules", () => {
    const code = [
      "import { createSlice } from './slices'",
      "import { configureStore } from 'msw-config'",
      "createSlice({ name: 'x' })",
      "configureStore({})",
    ].join("\n")
    expect(stores(code)).not.toContain("redux")
    expect(stores(code)).not.toContain("x")
  })

  it("counts useStore from react-redux", () => {
    expect(stores("import { useStore } from 'react-redux'\nuseStore()")).toEqual(["redux"])
  })
})

describe("store — typed redux hooks", () => {
  it("counts same-file hooks declared with withTypes, TypedUseSelectorHook and an arrow", () => {
    const shapes = [
      "export const useAppSelector = useSelector.withTypes<RootState>()",
      "export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector",
      "export const useAppSelector = () => useSelector<RootState>()",
    ]

    for (const shape of shapes) {
      const code = [
        "import { useSelector, type TypedUseSelectorHook } from 'react-redux'",
        shape,
        "function Orders() { return useAppSelector((s) => s.orders) }",
      ].join("\n")
      expect(stores(code)).toEqual(["redux"])
    }
  })

  const HOOKS_FILE = `${ROOT}/src/store/hooks.ts`
  const modules = (specifier: string): string | null => (specifier === "@/store/hooks" ? HOOKS_FILE : null)
  const withHooks = (hooks: string, code: string) =>
    valuesOf(
      run([createStoreExtractor()], code, {
        file: "src/pages/Orders.tsx",
        resolveModule: modules,
        sources: { [HOOKS_FILE]: hooks },
      }),
      "stores",
    )

  it("counts an imported useAppSelector whose declaration resolves to react-redux", () => {
    expect(
      withHooks(
        "import { useDispatch, useSelector } from 'react-redux'\nexport const useAppSelector = useSelector.withTypes<RootState>()\nexport const useAppDispatch = () => useDispatch<AppDispatch>()",
        "import { useAppDispatch } from '@/store/hooks'\nexport const Orders = () => { const dispatch = useAppDispatch(); return null }",
      ),
    ).toEqual(["redux"])
  })

  it("ignores an imported hook declared from some other library", () => {
    expect(
      withHooks(
        "import { useSelector } from '@xstate/react'\nexport const useAppSelector = useSelector",
        "import { useAppSelector } from '@/store/hooks'\nuseAppSelector(actor, (s) => s)",
      ),
    ).toEqual([])
  })

  it("ignores an imported hook whose module cannot be read", () => {
    expect(withHooks("", "import { useAppSelector } from './elsewhere'\nuseAppSelector((s) => s)")).toEqual([])
  })
})

describe("store — pinia", () => {
  it("names an options-form defineStore after its exported variable", () => {
    const code = [
      "import { defineStore } from 'pinia'",
      "export const useUserStore = defineStore('user', { state: () => ({ name: '' }) })",
    ].join("\n")
    expect(stores(code)).toEqual(["useUserStore"])
  })

  it("names a setup-form defineStore and dedupes its same-file usage", () => {
    const code = [
      "import { defineStore } from 'pinia'",
      "export const useCartStore = defineStore('cart', () => ({ items: [] }))",
      "const cart = useCartStore()",
    ].join("\n")
    expect(stores(code)).toEqual(["useCartStore"])
  })

  it("names the legacy object-only form and an aliased import", () => {
    const code = [
      "import { defineStore as define } from 'pinia'",
      "export const useLegacy = define({ id: 'legacy', state: () => ({}) })",
    ].join("\n")
    expect(stores(code)).toEqual(["useLegacy"])
  })

  it("ignores a local defineStore and one from another module", () => {
    const code = [
      "import { defineStore as other } from 'some-lib'",
      "const defineStore = (id) => id",
      "const useLocal = defineStore('x')",
      "const useOther = other('y')",
    ].join("\n")
    expect(stores(code)).toEqual([])
  })

  const STORE_FILE = `${ROOT}/src/stores/user.ts`
  const modules = (specifier: string): string | null => (specifier === "@/stores/user" ? STORE_FILE : null)

  it("counts a call in another file bound to an exported pinia store, without the name fallback", () => {
    const result = run(
      [createStoreExtractor()],
      "import { useAccount } from '@/stores/user'\nconst account = useAccount()",
      {
        file: "src/pages/Profile.vue.ts",
        resolveModule: modules,
        sources: {
          [STORE_FILE]: "import { defineStore } from 'pinia'\nexport const useAccount = defineStore('account', () => ({}))",
        },
      },
    )
    expect(valuesOf(result, "stores")).toEqual(["useAccount"])
  })

  it("ignores an imported hook whose declaration is not a pinia defineStore", () => {
    const result = run(
      [createStoreExtractor()],
      "import { useAccount } from '@/stores/user'\nuseAccount()",
      {
        file: "src/pages/Profile.ts",
        resolveModule: modules,
        sources: { [STORE_FILE]: "export const useAccount = () => ({})" },
      },
    )
    expect(valuesOf(result, "stores")).toEqual([])
  })

  it("declares zustand first, then pinia and @ngrx/store, as enabling dependencies", () => {
    expect(extractor.enablingDependency).toEqual(["zustand", "pinia", "@ngrx/store"])
  })
})

describe("store — an imported zustand / valtio hook proven in its declaring file (F19)", () => {
  const STORE_FILE = `${ROOT}/src/state/bears.ts`
  const modules = (specifier: string): string | null => (specifier === "@/state/bears" ? STORE_FILE : null)
  const importedStores = (declaring: string, code: string) =>
    valuesOf(
      run([createStoreExtractor()], code, {
        file: "src/pages/Bears.tsx",
        resolveModule: modules,
        sources: { [STORE_FILE]: declaring },
      }),
      "stores",
    )

  it("recognizes a hook not named use…Store whose declaration is a zustand create call", () => {
    expect(
      importedStores(
        "import { create } from 'zustand'\nexport const useBears = create((set) => ({ bears: 0 }))",
        "import { useBears } from '@/state/bears'\nexport const Bears = () => { const bears = useBears((s) => s.bears); return null }",
      ),
    ).toEqual(["useBears"])
  })

  it("recognizes a curried zustand createStore declaration", () => {
    expect(
      importedStores(
        "import { createStore } from 'zustand/vanilla'\nexport const useBears = createStore()((set) => ({}))",
        "import { useBears } from '@/state/bears'\nuseBears()",
      ),
    ).toEqual(["useBears"])
  })

  it("ignores an imported use… hook declared by anything else", () => {
    expect(
      importedStores(
        "import { useState } from 'react'\nexport const useBears = () => useState(0)",
        "import { useBears } from '@/state/bears'\nuseBears()",
      ),
    ).toEqual([])
  })
})

describe("store — NgRx feature names and an injected Store (G18)", () => {
  const SELECTORS_FILE = `${ROOT}/src/app/orders/orders.selectors.ts`

  const selectorModules = (specifier: string): string | null =>
    specifier === "./orders.selectors" ? SELECTORS_FILE : null

  const component = (members: string, body: string): string =>
    [
      "import { Component, inject } from '@angular/core'",
      "import { Store, select } from '@ngrx/store'",
      "import { selectOrders, selectTotal, ordersFeature } from './orders.selectors'",
      `export class OrdersComponent { ${members} load() { ${body} } }`,
    ].join("\n")

  const withSelectors = (code: string, selectors: string) =>
    run([createStoreExtractor()], code, {
      file: "src/app/orders/orders.component.ts",
      resolveModule: selectorModules,
      sources: { [SELECTORS_FILE]: selectors },
    })

  const SELECTORS = [
    "import { createFeature, createFeatureSelector, createSelector } from '@ngrx/store'",
    "const selectOrdersState = createFeatureSelector<OrdersState>('orders')",
    "export const selectOrders = createSelector(selectOrdersState, (state) => state.items)",
    "export const selectTotal = createSelector(selectOrders, (items) => items.length)",
    "export const ordersFeature = createFeature({ name: 'cart', reducer })",
  ].join("\n")

  it("names a store after createFeature({ name })", () => {
    const code = ["import { createFeature } from '@ngrx/store'", "export const f = createFeature({ name: 'orders', reducer })"].join("\n")
    expect(stores(code)).toEqual(["orders"])
  })

  it("names a store after createFeatureSelector, with or without a type argument", () => {
    const code = [
      "import { createFeatureSelector } from '@ngrx/store'",
      "export const a = createFeatureSelector('orders')",
      "export const b = createFeatureSelector<UsersState>('users')",
    ].join("\n")
    expect(stores(code)).toEqual(["orders", "users"])
  })

  it("names a store after StoreModule.forFeature", () => {
    const code = [
      "import { StoreModule } from '@ngrx/store'",
      "export const imports = [StoreModule.forFeature('settings', reducer)]",
    ].join("\n")
    expect(stores(code)).toEqual(["settings"])
  })

  it("ignores same-named factories from other modules", () => {
    const code = [
      "import { createFeature, StoreModule } from './local'",
      "createFeature({ name: 'orders' })",
      "StoreModule.forFeature('settings')",
    ].join("\n")
    expect(stores(code)).toEqual([])
  })

  it("emits the features behind the selectors a constructor-injected Store reads", () => {
    const result = withSelectors(
      component("constructor(private store: Store<AppState>) {}", "return this.store.select(selectTotal)"),
      SELECTORS,
    )
    expect(valuesOf(result, "stores")).toEqual(["orders"])
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: "stores/name-fallback" }))
  })

  it("follows an inject(Store) field through select() and a createFeature selector", () => {
    const result = withSelectors(
      component("private readonly store = inject(Store);", "return this.store.pipe(select(ordersFeature.selectItems))"),
      SELECTORS,
    )
    expect(valuesOf(result, "stores")).toEqual(["cart"])
  })

  it("falls back to the ngrx name when no selector resolves", () => {
    const result = withSelectors(
      component("constructor(private store: Store) {}", "this.store.dispatch(load())"),
      SELECTORS,
    )
    expect(valuesOf(result, "stores")).toEqual(["ngrx"])
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "stores/name-fallback" }))
  })

  it("ignores a `this.store` typed as a local class", () => {
    const code = "class Store { select(x: unknown) { return x } }\nexport class C { constructor(private store: Store) {} f() { return this.store.select('orders') } }"
    expect(stores(code)).toEqual([])
  })
})
