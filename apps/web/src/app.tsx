// 应用的组装：查询缓存 + 路由。会话过期（任何请求返回 401）时清空缓存并回到登录页。
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, type RouterHistory } from '@tanstack/react-router';
import { ApiError } from './api/client.ts';
import { createAppRouter } from './router.tsx';

export function createApp(options: { history?: RouterHistory } = {}) {
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        const { pathname } = router.state.location;
        if (error instanceof ApiError && error.status === 401 && pathname !== '/login') {
          queryClient.clear();
          void router.navigate({ to: '/login', search: { redirect: pathname } });
        }
      },
    }),
    defaultOptions: { queries: { refetchOnWindowFocus: false } },
  });
  const router = createAppRouter({ queryClient, history: options.history });

  function App() {
    return (
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    );
  }
  return { App, router, queryClient };
}
