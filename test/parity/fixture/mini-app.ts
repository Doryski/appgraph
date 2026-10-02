import type { AppgraphConfig } from "../../../src/core/model.js"

/**
 * A synthetic react-router app — a small blog with posts, authors and tag insights — kept as STRINGS so
 * the parity gate's machinery runs in CI with no private material. It is not a golden; it is a shape
 * corpus: every file exists because some mechanic the gate asserts is otherwise unobservable in CI.
 *
 *   src/shared/routing/routePaths.ts   the `RoutePath` enum the fixture's pinned config names — every
 *                                     route path is a const
 *   src/navigation.tsx                 the menu array (`sidebarItems`), with featureFlag, parentPath and
 *                                     labelKey
 *   src/routes/router.tsx              BOTH lazy idioms: `element: <…>` directly, and
 *                                     `lazy: async () => { … return { element } }`; a PATHLESS layout
 *                                     route (the root object with `element` and `children` and no
 *                                     `path`); a `<Navigate to>` redirect; an ENTRYLESS route with
 *                                     neither element, lazy nor redirect; a dev-guarded spread route
 *   src/routes/{ProtectedRoute,Layouts}.tsx + ErrorBoundaries
 *                                     the wrapper trio: guard, layout, errorBoundary
 *   src/{services,stores,shared/hooks} the three `traversable` directories — reachability's only
 *                                     feeder
 *   src/shared/hooks/usePrefetchMap.ts THE PHANTOM ENDPOINT SHAPE: a `Map` keyed by `RoutePath.*` whose
 *                                     `.get(RoutePath.FEED)` folds to the literal `/`. The real parity
 *                                     target does NOT contain this shape — measured: every
 *                                     `.get|post|…('/…')` receiver there is an HTTP client — which is
 *                                     why A1 is only falsifiable here
 *   src/modules/PostsList/…            TWO entries for one screen whose `localeCompare` and codepoint
 *                                     order DISAGREE (`components/…` vs `PostsList.tsx`), which is
 *                                     what makes the §8.9 `entries[0]` shift reproducible in CI
 *   src/modules/FeedList/… +           THE RENDER-EDGE SHAPES. Without component-to-component JSX,
 *   src/components/{PostCard,          `renderEdges: 0` is arithmetically correct and the fixture
 *   EmptyState,Badge}                  cannot regress the metric in either direction.
 *                                     `FeedList` renders three components across all three
 *                                     shapes §7.9 distinguishes: unconditional (`FeedToolbar`),
 *                                     conditional (`EmptyState`, behind a ternary) and repeated
 *                                     (`PostCard`, inside `.map()`); `FeedToolbar` renders `Badge`,
 *                                     giving a two-level chain so a depth bug is observable too.
 */

export const MINI_APP_FILES: Readonly<Record<string, string>> = {
  "package.json": JSON.stringify(
    {
      name: "mini-app",
      private: true,
      dependencies: {
        "@tanstack/react-query": "^5.0.0",
        axios: "^1.7.0",
        i18next: "^23.0.0",
        react: "^19.0.0",
        "react-hook-form": "^7.0.0",
        "react-i18next": "^15.0.0",
        "react-router-dom": "^6.26.0",
        zustand: "^4.5.0",
      },
    },
    null,
    2,
  ),

  "tsconfig.json": JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "react-jsx",
        baseUrl: ".",
        paths: { "@/*": ["src/*"] },
      },
      include: ["src"],
    },
    null,
    2,
  ),

  "src/shared/routing/routePaths.ts": `export enum RoutePath {
  FEED = '/',
  SIGN_IN = '/sign-in',
  POSTS = '/posts',
  POST_DETAIL = '/posts/:id',
  AUTHORS = '/authors',
  INSIGHTS = '/insights',
  INSIGHTS_TAGS = '/insights/tags',
  ENTRYLESS = '/entryless',
  DEV_SANDBOX = '/dev/sandbox',
}
`,

  "src/navigation.tsx": `import { RoutePath } from '@/shared/routing/routePaths';

export const sidebarItems = [
  { path: RoutePath.FEED, title: 'Feed', labelKey: 'nav.feed' },
  { path: RoutePath.POSTS, title: 'Posts', labelKey: 'nav.posts', featureFlag: 'posts' },
  { path: RoutePath.AUTHORS, title: 'Authors', labelKey: 'nav.authors' },
  { path: RoutePath.INSIGHTS, title: 'Insights', labelKey: 'nav.insights' },
  { path: RoutePath.INSIGHTS_TAGS, parentPath: RoutePath.INSIGHTS, title: 'Tags', labelKey: 'nav.insightsTags' },
] as const;
`,

  "src/services/api/client.ts": `import axios from 'axios';

export const apiClient = axios.create({ baseURL: '/api' });
`,

  "src/services/api/posts/requests.ts": `import { apiClient } from '../client';

export const fetchPosts = () => apiClient.get('/posts');
export const fetchPost = (id: string) => apiClient.get(\`/posts/\${id}\`);
export const createPost = (body: unknown) => apiClient.post('/posts', body);
export const removePost = (id: string) => apiClient.delete(\`/posts/\${id}\`);
`,

  "src/services/api/authors/requests.ts": `import { apiClient } from '../client';

export const fetchAuthors = () => apiClient.get('/authors');
`,

  "src/services/api/metrics/requests.ts": `import { apiClient } from '../client';

export const fetchTagStats = () => apiClient.get('/metrics/tags');
`,

  "src/stores/session/useSessionStore.ts": `import { create } from 'zustand';

export const useSessionStore = create<{ reader: string | null }>(() => ({ reader: null }));
`,

  // The phantom-endpoint shape §8.1 exists to kill: a Map keyed by path constants. `flattenString`
  // folds `RoutePath.FEED` to '/', so name-only HTTP detection mints `GET /` from `prefetchMap.get(...)`
  // even though the receiver is a Map, not an HTTP client.
  // The Map is keyed by the two nav paths that have NO real endpoint of their own ('/' and
  // '/insights'), so `GET /` and `GET /insights` can only ever come from the Map. That is what makes
  // A1 falsifiable: if either shows up in a screen's endpoints, name-only detection is still live.
  "src/shared/hooks/usePrefetchMap.ts": `import { useMemo } from 'react';
import { RoutePath } from '@/shared/routing/routePaths';
import { fetchPosts } from '@/services/api/posts/requests';
import { fetchTagStats } from '@/services/api/metrics/requests';

export const usePrefetchMap = () => {
  const prefetchMap = useMemo(
    () =>
      new Map<string, () => void>([
        [RoutePath.FEED, () => void fetchPosts()],
        [RoutePath.INSIGHTS, () => void fetchTagStats()],
      ]),
    [],
  );

  const handlerForFeed = prefetchMap.get(RoutePath.FEED);
  const handlerForInsights = prefetchMap.get(RoutePath.INSIGHTS);

  return { handlerForFeed, handlerForInsights };
};
`,

  "src/shared/hooks/useWordCount.ts": `import { useMemo } from 'react';

export const useWordCount = (rows: readonly { words: number }[]) =>
  useMemo(() => rows.reduce((sum, row) => sum + row.words, 0), [rows]);
`,

  "src/routes/RootLayout.tsx": `import { Outlet } from 'react-router-dom';

export const RootLayout = () => <Outlet />;
`,

  "src/routes/ProtectedRoute.tsx": `import type { ReactNode } from 'react';
import { useSessionStore } from '@/stores/session/useSessionStore';

export const ProtectedRoute = ({ children, featureFlag }: { children: ReactNode; featureFlag?: string }) => {
  const reader = useSessionStore((state) => state.reader);
  if (!reader) return null;
  return <div data-testid="protected-shell" data-flag={featureFlag}>{children}</div>;
};
`,

  "src/routes/Layouts.tsx": `import type { ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import { sidebarItems } from '@/navigation';

export const AppLayout = ({ children, title }: { children?: ReactNode; title?: string }) => (
  <div data-testid="app-layout" title={title}>
    <nav>{sidebarItems.length}</nav>
    {children ?? <Outlet />}
  </div>
);

export const FocusLayout = ({ children, title }: { children?: ReactNode; title?: string }) => (
  <div data-testid="focus-layout" title={title}>{children ?? <Outlet />}</div>
);
`,

  "src/shared/components/ErrorBoundaries/RouteErrorBoundary.tsx": `import type { ReactNode } from 'react';

export const RouteErrorBoundary = ({ children }: { children: ReactNode; routeName?: string }) => <>{children}</>;
`,

  "src/shared/components/ErrorBoundaries/index.ts": `export { RouteErrorBoundary } from './RouteErrorBoundary';
`,

  "src/layouts/Auth/AuthLayout.tsx": `import type { ReactNode } from 'react';

const AuthLayout = ({ children, title }: { children: ReactNode; title?: string }) => (
  <div data-testid="auth-layout" title={title}>{children}</div>
);

export default AuthLayout;
`,

  "src/layouts/Auth/index.ts": `export { default } from './AuthLayout';
`,

  "src/modules/SignIn/SignIn.tsx": `import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RoutePath } from '@/shared/routing/routePaths';

const SignIn = () => {
  const navigate = useNavigate();
  const { t } = useTranslation('auth');
  return (
    <button data-testid="sign-in-submit" onClick={() => navigate(RoutePath.FEED)}>
      {t('submit')}
    </button>
  );
};

export default SignIn;
`,

  "src/modules/SignIn/index.ts": `export { default } from './SignIn';
`,

  // Leaf UI components, in `src/components/` (kind `ui`, NOT traversable) — so they can only enter
  // `reachable` through a RENDER edge, never through `uses`. That is what makes them a clean probe:
  // if the render walk breaks, they disappear from both `renderEdges` and `reachable` at once.
  "src/components/Badge/Badge.tsx": `export const Badge = ({ count }: { count: number }) => (
  <span data-testid="badge">{count}</span>
);
`,

  "src/components/EmptyState/EmptyState.tsx": `export const EmptyState = () => <p data-testid="empty-state">nothing here</p>;
`,

  "src/components/PostCard/PostCard.tsx": `export const PostCard = ({ id }: { id: string }) => <li data-testid="post-card">{id}</li>;
`,

  "src/modules/FeedList/components/FeedToolbar.tsx": `import { Badge } from '@/components/Badge/Badge';

export const FeedToolbar = ({ count }: { count: number }) => (
  <div data-testid="feed-toolbar">
    <Badge count={count} />
  </div>
);
`,

  // Three render edges out of one component, one per §7.9 shape, plus a second level through
  // FeedToolbar -> Badge.
  "src/modules/FeedList/FeedList.tsx": `import { useTranslation } from 'react-i18next';
import { useSessionStore } from '@/stores/session/useSessionStore';
import { usePrefetchMap } from '@/shared/hooks/usePrefetchMap';
import { EmptyState } from '@/components/EmptyState/EmptyState';
import { PostCard } from '@/components/PostCard/PostCard';
import { FeedToolbar } from './components/FeedToolbar';

const rows: readonly { id: string }[] = [{ id: '1' }, { id: '2' }];

const FeedList = () => {
  const reader = useSessionStore((state) => state.reader);
  const { handlerForFeed } = usePrefetchMap();
  const { t } = useTranslation('feed');
  return (
    <div data-testid="feed-list" onMouseEnter={handlerForFeed}>
      <FeedToolbar count={rows.length} />
      {t('title')} {reader}
      {rows.length === 0 ? <EmptyState /> : rows.map((row) => <PostCard key={row.id} id={row.id} />)}
    </div>
  );
};

export default FeedList;
`,

  "src/modules/FeedList/index.ts": `export { default } from './FeedList';
`,

  // Two entries for one screen. localeCompare orders 'components/…' BEFORE 'PostsList.tsx'
  // (case-insensitive c < p); codepoint orders 'PostsList.tsx' first ('P' 0x50 < 'c' 0x63). This is
  // the §8.9 entries[0] shift, reproduced in CI.
  "src/modules/PostsList/PostsList.tsx": `import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { fetchPosts } from '@/services/api/posts/requests';
import { useWordCount } from '@/shared/hooks/useWordCount';

const PostsList = () => {
  const { t } = useTranslation('posts');
  const posts = useQuery({ queryKey: ['posts'], queryFn: fetchPosts });
  const words = useWordCount([]);
  return <div data-testid="posts-list">{t('title')}{posts.status}{words}</div>;
};

export default PostsList;
`,

  "src/modules/PostsList/components/PostsHeader.tsx": `import { useNavigate } from 'react-router-dom';
import { RoutePath } from '@/shared/routing/routePaths';

export const PostsHeader = () => {
  const navigate = useNavigate();
  return (
    <header data-testid="posts-header" onClick={() => navigate(RoutePath.POST_DETAIL)}>
      posts
    </header>
  );
};
`,

  "src/modules/PostsList/index.ts": `export { default } from './PostsList';
`,

  "src/modules/PostEditor/PostEditor.tsx": `import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { fetchPost } from '@/services/api/posts/requests';

const PostEditor = () => {
  const post = useQuery({ queryKey: ['post'], queryFn: () => fetchPost('1') });
  const form = useForm<{ headline: string }>();
  return (
    <form data-testid="post-editor" onSubmit={form.handleSubmit(() => undefined)}>
      {post.status}
    </form>
  );
};

export default PostEditor;
`,

  "src/modules/PostEditor/index.ts": `export { default } from './PostEditor';
`,

  "src/modules/AuthorsList/AuthorsList.tsx": `import { useQuery } from '@tanstack/react-query';
import { fetchAuthors } from '@/services/api/authors/requests';

const AuthorsList = () => {
  const authors = useQuery({ queryKey: ['authors'], queryFn: fetchAuthors });
  return <div data-testid="authors-list">{authors.status}</div>;
};

export default AuthorsList;
`,

  "src/modules/AuthorsList/index.ts": `export { default } from './AuthorsList';
`,

  "src/modules/TagInsights/TagInsights.tsx": `import { useQuery } from '@tanstack/react-query';
import { fetchTagStats } from '@/services/api/metrics/requests';

const TagInsights = () => {
  const tagStats = useQuery({ queryKey: ['tag-stats'], queryFn: fetchTagStats });
  return <div data-testid="tag-insights">{tagStats.status}</div>;
};

export default TagInsights;
`,

  "src/modules/TagInsights/index.ts": `export { default } from './TagInsights';
`,

  "src/modules/DevSandbox/DevSandbox.tsx": `const DevSandbox = () => <div data-testid="dev-sandbox" />;

export default DevSandbox;
`,

  "src/modules/DevSandbox/index.ts": `export { default } from './DevSandbox';
`,

  "src/shared/utils/env.ts": `export const isDevelopment = () => import.meta.env.DEV;
`,

  "src/routes/router.tsx": `import { createBrowserRouter, Navigate } from 'react-router-dom';
import { RoutePath } from '@/shared/routing/routePaths';
import AuthLayout from '@/layouts/Auth';
import { ProtectedRoute } from './ProtectedRoute';
import { RootLayout } from './RootLayout';
import { AppLayout, FocusLayout } from './Layouts';
import { RouteErrorBoundary } from '@/shared/components/ErrorBoundaries';
import { isDevelopment } from '@/shared/utils/env';
import FeedList from '@/modules/FeedList';
import PostsList from '@/modules/PostsList';
import { PostsHeader } from '@/modules/PostsList/components/PostsHeader';

export const router = createBrowserRouter([
  {
    // PATHLESS layout route: no \`path\`, so there is no URL to key it on.
    element: <RootLayout />,
    children: [
      {
        path: RoutePath.SIGN_IN,
        lazy: async () => {
          const { default: SignIn } = await import('@/modules/SignIn');
          return {
            element: (
              <RouteErrorBoundary routeName="sign-in">
                <AuthLayout title="Sign in">
                  <SignIn />
                </AuthLayout>
              </RouteErrorBoundary>
            ),
          };
        },
      },
      {
        // Idiom 2: a direct \`element\`, no lazy wrapper.
        path: RoutePath.FEED,
        element: (
          <RouteErrorBoundary routeName="feed">
            <ProtectedRoute>
              <AppLayout title="Feed">
                <FeedList />
              </AppLayout>
            </ProtectedRoute>
          </RouteErrorBoundary>
        ),
      },
      {
        path: RoutePath.POSTS,
        element: (
          <RouteErrorBoundary routeName="posts">
            <ProtectedRoute featureFlag="posts">
              <AppLayout title="Posts">
                <PostsHeader />
                <PostsList />
              </AppLayout>
            </ProtectedRoute>
          </RouteErrorBoundary>
        ),
      },
      {
        path: RoutePath.POST_DETAIL,
        lazy: async () => {
          const { default: PostEditor } = await import('@/modules/PostEditor');
          return {
            element: (
              <RouteErrorBoundary routeName="post-detail">
                <ProtectedRoute featureFlag="posts">
                  <AppLayout title="Post">
                    <PostEditor />
                  </AppLayout>
                </ProtectedRoute>
              </RouteErrorBoundary>
            ),
          };
        },
      },
      {
        path: RoutePath.AUTHORS,
        lazy: async () => {
          const { default: AuthorsList } = await import('@/modules/AuthorsList');
          return {
            element: (
              <RouteErrorBoundary routeName="authors">
                <ProtectedRoute>
                  <AppLayout title="Authors">
                    <AuthorsList />
                  </AppLayout>
                </ProtectedRoute>
              </RouteErrorBoundary>
            ),
          };
        },
      },
      {
        // A pure REDIRECT route.
        path: RoutePath.INSIGHTS,
        element: <Navigate to={RoutePath.INSIGHTS_TAGS} replace />,
      },
      {
        path: RoutePath.INSIGHTS_TAGS,
        lazy: async () => {
          const { default: TagInsights } = await import('@/modules/TagInsights');
          return {
            element: (
              <RouteErrorBoundary routeName="insights-tags">
                <ProtectedRoute>
                  <FocusLayout title="Tags">
                    <TagInsights />
                  </FocusLayout>
                </ProtectedRoute>
              </RouteErrorBoundary>
            ),
          };
        },
      },
      {
        // ENTRYLESS: a path with neither an element, a lazy, nor a redirect — §8.3's silently
        // dropped route.
        path: RoutePath.ENTRYLESS,
      },
      ...(isDevelopment()
        ? [
            {
              path: RoutePath.DEV_SANDBOX,
              lazy: async () => {
                const { default: DevSandbox } = await import('@/modules/DevSandbox');
                return {
                  element: (
                    <RouteErrorBoundary routeName="dev-sandbox">
                      <ProtectedRoute>
                        <AppLayout title="Dev sandbox">
                          <DevSandbox />
                        </AppLayout>
                      </ProtectedRoute>
                    </RouteErrorBoundary>
                  ),
                };
              },
            },
          ]
        : []),
      {
        path: '*',
        element: (
          <RouteErrorBoundary routeName="404">
            <FocusLayout title="404">
              <div data-testid="not-found" />
            </FocusLayout>
          </RouteErrorBoundary>
        ),
      },
    ],
  },
]);
`,
}

/**
 * The target-specific half of the fixture's pinned config (`pinned.ts` holds the generic half): the
 * `RoutePath` string source and the directory -> kind rules in first-match-wins order. `traversable`
 * marks the data layer; `screenEntry` is the router entry filter.
 */
export const MINI_APP_PINNED_CONFIG = {
  stringSources: ["src/shared/routing/routePaths.ts"],
  kindRules: [
    { match: { pathPrefix: "src/modules/" }, kind: "module", traversable: false, screenEntry: true, priority: 90 },
    { match: { pathPrefix: "src/layouts/" }, kind: "layout", traversable: false, screenEntry: true, priority: 89 },
    { match: { pathPrefix: "src/components/" }, kind: "ui", traversable: false, screenEntry: false, priority: 88 },
    { match: { pathPrefix: "src/services/" }, kind: "service", traversable: true, screenEntry: false, priority: 87 },
    { match: { pathPrefix: "src/stores/" }, kind: "store", traversable: true, screenEntry: false, priority: 86 },
    { match: { pathPrefix: "src/shared/hooks/" }, kind: "hook", traversable: true, screenEntry: false, priority: 85 },
    { match: { pathPrefix: "src/shared/" }, kind: "shared", traversable: false, screenEntry: false, priority: 84 },
    { match: { pathPrefix: "src/routes/" }, kind: "shared", traversable: false, screenEntry: false, priority: 83 },
  ],
} as const satisfies AppgraphConfig

/** The URLs the fixture router declares, `/dev/sandbox` included (the dev spread is followed). */
export const MINI_APP_URLS = [
  "/",
  "/*",
  "/authors",
  "/dev/sandbox",
  "/entryless",
  "/insights",
  "/insights/tags",
  "/posts",
  "/posts/:id",
  "/sign-in",
] as const

/**
 * The render edges the fixture declares, HAND-DERIVED from the JSX above (§7.9).
 *
 * Read as: producer file -> the components it renders, with the shape §7.9 records for each. This is
 * what makes a render-walk regression visible in CI.
 *
 * `alwaysRendered` / `repeated` are asserted, not just the file list, because an edge that survives
 * with the wrong flags is still a defect.
 */
export const MINI_APP_RENDER_EDGES = [
  {
    from: "src/modules/FeedList/FeedList.tsx",
    to: "src/modules/FeedList/components/FeedToolbar.tsx",
    alwaysRendered: true,
    repeated: false,
  },
  // Behind a ternary, so it is conditional and NOT always rendered.
  {
    from: "src/modules/FeedList/FeedList.tsx",
    to: "src/components/EmptyState/EmptyState.tsx",
    alwaysRendered: false,
    repeated: false,
  },
  // Inside `.map()`, so §7.9 marks it repeated.
  {
    from: "src/modules/FeedList/FeedList.tsx",
    to: "src/components/PostCard/PostCard.tsx",
    alwaysRendered: false,
    repeated: true,
  },
  // Second level: proves the walk does not stop at the screen entry's own children.
  {
    from: "src/modules/FeedList/components/FeedToolbar.tsx",
    to: "src/components/Badge/Badge.tsx",
    alwaysRendered: true,
    repeated: false,
  },
] as const

/** The menu paths `src/navigation.tsx#sidebarItems` declares. */
export const MINI_APP_MENU_PATHS = ["/", "/posts", "/authors", "/insights", "/insights/tags"] as const

/**
 * The phantom endpoints a name-only HTTP detector mints from `usePrefetchMap.ts`. Both receivers are
 * the same `Map`; neither may appear in any screen's endpoints (§8.1).
 */
export const MINI_APP_PHANTOM_ENDPOINTS = ["GET /", "GET /insights"] as const

/** The genuine endpoints, all rooted in `apiClient` (`src/services/api/client.ts`). */
export const MINI_APP_REAL_ENDPOINTS = [
  "DELETE /posts/:param",
  "GET /authors",
  "GET /metrics/tags",
  "GET /posts",
  "GET /posts/:param",
  "POST /posts",
] as const
