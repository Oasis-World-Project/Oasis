// 路由表：侧栏 7 个入口就是全部一级页面（PRD 信息架构）。广场是沉浸式页面，不带侧栏。
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  type RouterHistory,
} from '@tanstack/react-router';
import { AppShell } from './layout/AppShell.tsx';
import { AisPage } from './pages/AisPage.tsx';
import { CanvasPage } from './pages/CanvasPage.tsx';
import { DmsPage } from './pages/DmsPage.tsx';
import { GroupsPage } from './pages/GroupsPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { MePage } from './pages/MePage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import { PlazaPage } from './pages/PlazaPage.tsx';

const rootRoute = createRootRoute({ component: Outlet, notFoundComponent: NotFoundPage });

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'shell',
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
  component: CanvasPage,
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
const meRoute = createRoute({ getParentRoute: () => shellRoute, path: '/me', component: MePage });
const plazaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/plaza',
  component: PlazaPage,
});

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([homeRoute, aisRoute, canvasRoute, groupsRoute, dmsRoute, meRoute]),
  plazaRoute,
]);

export function createAppRouter(options: { history?: RouterHistory } = {}) {
  return createRouter({ routeTree, history: options.history, defaultPreload: 'intent' });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
