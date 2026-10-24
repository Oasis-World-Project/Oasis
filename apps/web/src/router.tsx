// 路由表：侧栏 7 个入口就是全部一级页面（PRD 信息架构）。广场是沉浸式页面，不带侧栏。
// 除登录页外都要求已登录：没登录时跳到登录页，登录后回到原来要去的页面。
import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { ApiError } from './api/client.ts';
import { meQuery } from './api/queries.ts';
import { AppShell } from './layout/AppShell.tsx';
import { AisPage } from './pages/AisPage.tsx';
import { ArtifactPage } from './pages/ArtifactPage.tsx';
import { CanvasPage } from './pages/CanvasPage.tsx';
import { DmPage } from './pages/DmPage.tsx';
import { DmsPage } from './pages/DmsPage.tsx';
import { GroupsPage } from './pages/GroupsPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { MePage } from './pages/MePage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import { PlazaPage } from './pages/PlazaPage.tsx';
import { WorkflowPage } from './pages/WorkflowPage.tsx';

interface RouterContext {
  queryClient: QueryClient;
}

async function requireSession({
  context,
  location,
}: {
  context: RouterContext;
  location: { href: string };
}) {
  try {
    await context.queryClient.ensureQueryData(meQuery);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      throw redirect({ to: '/login', search: { redirect: location.href } });
    }
    throw err;
  }
}

/** 只接受站内路径，防止登录后被带去别的网站（"//x"、"/\\x" 会被浏览器当成别的站） */
function safeRedirect(value: unknown): string | undefined {
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : undefined;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFoundPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  // 要显式给出 redirect（哪怕是 undefined），否则会沿用地址栏里未校验的原值
  validateSearch: (search: Record<string, unknown>): { redirect?: string | undefined } => ({
    redirect: safeRedirect(search.redirect),
  }),
  component: LoginPage,
});

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'shell',
  beforeLoad: requireSession,
  component: AppShell,
});

const homeRoute = createRoute({ getParentRoute: () => shellRoute, path: '/', component: HomePage });
const aisRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/ais',
  component: AisPage,
});
const canvasRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/canvas',
  // ?task= 只看某个任务的成果（交付消息里的「在画布里看」）
  validateSearch: (search: Record<string, unknown>): { task?: string | undefined } => ({
    task: typeof search.task === 'string' ? search.task : undefined,
  }),
  component: CanvasPage,
});
/** 在画布里打开一个成果 */
const artifactRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/canvas/artifacts/$artifactId',
  component: ArtifactPage,
});
/** 任务的工作流：从私聊里的任务卡进来；成果属于画布，侧栏亮「画布」 */
const workflowRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/canvas/tasks/$taskId',
  component: WorkflowPage,
});
const groupsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/groups',
  component: GroupsPage,
});
const dmsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/dms',
  component: DmsPage,
});
const dmRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/dms/$conversationId',
  component: DmPage,
});
const meRoute = createRoute({ getParentRoute: () => shellRoute, path: '/me', component: MePage });
const plazaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/plaza',
  beforeLoad: requireSession,
  component: PlazaPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  shellRoute.addChildren([
    homeRoute,
    aisRoute,
    canvasRoute,
    workflowRoute,
    artifactRoute,
    groupsRoute,
    dmsRoute,
    dmRoute,
    meRoute,
  ]),
  plazaRoute,
]);

export function createAppRouter(options: { queryClient: QueryClient; history?: RouterHistory }) {
  return createRouter({
    routeTree,
    history: options.history,
    context: { queryClient: options.queryClient },
    defaultPreload: 'intent',
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
