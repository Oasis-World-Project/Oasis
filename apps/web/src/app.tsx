// 应用的组装：查询缓存 + 路由。会话过期（任何请求返回 401）时清空缓存并回到登录页。
import { onlineManager, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, type RouterHistory } from '@tanstack/react-router';
import { useEffect } from 'react';
import { ApiError, isConnectionError } from './api/client.ts';
import { createAppRouter } from './router.tsx';

export function createApp(options: { history?: RouterHistory } = {}) {
  onlineManager.setOnline(navigator.onLine);
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        const { pathname, hash } = router.state.location;
        if (error instanceof ApiError && error.status === 401 && pathname !== '/login') {
          queryClient.clear();
          void router.navigate({ to: '/login', search: { redirect: pathname }, hash });
        }
      },
    }),
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        refetchInterval: (query) => (isConnectionError(query.state.error) ? 5_000 : false),
      },
    },
  });
  const router = createAppRouter({ queryClient, history: options.history });

  function App() {
    useEffect(() => {
      // 中断正在读取的旧连接；联网事件由 Query 的原有恢复路径刷新。
      const offline = () => {
        void queryClient.cancelQueries({ type: 'active' });
      };
      window.addEventListener('offline', offline);
      return () => window.removeEventListener('offline', offline);
    }, []);
    return (
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    );
  }
  return { App, router, queryClient };
}
