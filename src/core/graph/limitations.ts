/**
 * What every run says about itself, verbatim, in `meta.limitations`.
 *
 * The traversal-default entry is not a general statement about static analysis but a MEASURED default of
 * this implementation, and it is in this list rather than in the README alone because the README is not
 * what an agent reads. The composition sentence appears in `meta.limitations` word for word; `test/core/graph.test.ts` pins that sentence, and
 * `test/emit/view-index.test.ts` pins that the index — the artifact an agent actually loads — carries
 * the whole list rather than only the `full` format doing so.
 */
export const GRAPH_LIMITATIONS: readonly string[] = [
  "appgraph reports composition as the framework's convention describes it, not as the code proves it. An ancestor chain comes from a directory convention (Next, TanStack, React Router framework / Remix) or a JSX tag (react-router) and is NEVER verified against the code that runs. A layout forwarding `children` into an imported component, a slot branch (one fixed page per `{slot}`), a conditional shell (`isMobile ? <A> : <B>`, flattened to one ancestor) or a route-group layout applying to only some descendants all yield a chain that is structurally complete and subtly wrong — including, possibly, an inverted answer to 'is this screen behind the auth guard'.",
  "Reachability follows `uses` edges only INTO files the kind rules mark `traversable` or whose NAME begins `use` then `-`, `_` or a capital (`useOrders.ts`, `use-orders.ts`), from any file. Other files are reached via render edges only. The presets mark the `services|api|clients`, `stores|store|state` and `hooks` directory families traversable, under `src/` or the root. A data layer elsewhere, not named `use…`, shows SMALL endpoint, store, query-key and i18n aggregates that reflect this default, not absent facts. `kindRules` in the config is the lever; `appgraph doctor` prints what matched.",
  "Conditional rendering is DETECTED but not evaluated: a tree node carries `conditions` (guard texts from `&&` / `??` / ternary), `alwaysRendered` (true when at least one usage has no guard) and `nullGuards` (early `return null`). Multiple entries in `conditions` are ALTERNATIVE usage sites (OR), not a conjunction.",
  "Guards on intermediate wrappers, props passed down, and early returns in hooks are not folded into a node condition — read the ancestor chain as an AND of its conditions.",
  "Loader guards are heuristics: a conditional `redirect` in `loader`, `clientLoader`, `getServerSideProps` or `beforeLoad` marks a route `protected`, an unconditional one makes it a redirect; the condition is text, never evaluated, and a feature-gate redirect looks the same as an auth one.",
  "A referenced value (`columns={cols}`, `build(cfg)`, `VIEWS[kind]`) is walked only if it carries JSX or a lazy import within 4 hops; runtime-built registries stay invisible.",
  "Endpoint URLs built from non-literal expressions carry a :param placeholder.",
  "Navigation targets built from template literals are marked dynamic:true and may resolve differently at runtime.",
  "Render trees are cut at meta.maxDepth; nodes with truncated:true have unexplored children.",
  "A node is a FILE labelled with its main component — other components in it collapse into it, except a sub-file screen root (labelled `<Component>#<localId suffix>`) and a route ancestor exported as another component or sharing its file with one (labelled by its export, with its own render edges).",
  "Screen aggregates (endpoints, stores, i18n, testIds) cover everything reachable from the screen, including shared components — presence does not mean the screen always uses it.",
  "Shell (layout) links are listed per shell, not as per-screen navigation edges, to keep the navigation graph readable.",
  "An ancestor's `{children}` splice point must be in that ancestor file's own code (a JSX expression, a `return`, or a `{...props}` spread): `children` reachable only through a component the ancestor renders (context, a store, a render prop's closure) is not found. An `<Outlet/>` (or `useOutlet()`) is also searched for in the components the ancestor renders, up to maxDepth levels, and the next level is spliced under the first host found.",
  "Ancestor levels do not consume the screen's maxDepth budget; each ancestor tree and the spliced subtree each start at depth 0.",
  "A spliced subtree is appended after the ancestor's own render-edge children: render edges carry no source position, so sibling order around the splice point cannot be reconstructed.",
  "Module-level `uses` edges are file-level and are attributed to every sub-file screen declared in that file.",
]
