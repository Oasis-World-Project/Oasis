/**
 * 依赖方向规则：工程规范 §3，项目工程方向 §2.1（禁止分布式单体）与 §3.3（Adapter 隔离）。
 * 服务内部固定分层：src/api → src/service → src/repo，禁止反向。
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: '禁止循环依赖',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-cross-service-import',
      severity: 'error',
      comment: '服务之间只能通过 API 或事件通信，不能 import 对方代码',
      from: { path: '^services/([^/]+)/' },
      to: { path: '^services/', pathNot: '^services/$1/' },
    },
    {
      name: 'apps-not-to-services',
      severity: 'error',
      comment: '前端只能通过 gateway 的 API 和 packages/contracts 使用后端',
      from: { path: '^apps/' },
      to: { path: '^services/' },
    },
    {
      name: 'services-not-to-apps',
      severity: 'error',
      from: { path: '^services/' },
      to: { path: '^apps/' },
    },
    {
      name: 'packages-are-leaves',
      severity: 'error',
      comment: '共享包只放契约和基础设施库，不得依赖服务或应用',
      from: { path: '^packages/' },
      to: { path: '^(services|apps)/' },
    },
    {
      name: 'dsh-only-in-harness-adapter',
      severity: 'error',
      comment: '全仓只有 services/harness/src/adapter 能接触 DeepSeek Harness',
      from: { pathNot: '^services/harness/src/adapter/' },
      to: { path: 'node_modules/(@deepseek-ai/|deepseek-harness)' },
    },
    {
      name: 'layer-repo-no-upward',
      severity: 'error',
      comment: '数据访问层不能依赖服务层或接口层',
      from: { path: '^services/[^/]+/src/repo/' },
      to: { path: '^services/[^/]+/src/(service|api)/' },
    },
    {
      name: 'layer-service-no-api',
      severity: 'error',
      comment: '服务层不能依赖接口层',
      from: { path: '^services/[^/]+/src/service/' },
      to: { path: '^services/[^/]+/src/api/' },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment: '运行时代码不能依赖 devDependencies',
      from: {
        path: '^(apps|services|packages)/[^/]+/src/',
        pathNot: '\\.(test|spec)\\.(ts|tsx)$',
      },
      to: { dependencyTypes: ['npm-dev'], dependencyTypesNot: ['type-only'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|build|coverage|\\.turbo)/' },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
  },
};
