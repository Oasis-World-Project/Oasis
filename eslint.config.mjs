// 全仓统一的 ESLint 配置（工程规范 §4、§7）。
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import sonarjs from 'eslint-plugin-sonarjs';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** 2026-11-08 已经超过 500 行的文件和当时的行数 */
const LONG_FILES = {
  'apps/web/src/canvas/ModelPreview.tsx': 614,
  'apps/web/test/task-cards.test.tsx': 684,
  'scripts/e2e/fake-provider.mjs': 597,
  'scripts/e2e/scenarios.mjs': 1029,
  'services/canvas/test/artifacts.test.ts': 659,
  'services/conversation/src/service/dm-service.ts': 790,
  'services/conversation/src/service/intake-service.ts': 831,
  'services/conversation/test/dm-service.test.ts': 1834,
  'services/conversation/test/groups-postgres.test.ts': 501,
};

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/.tmp/**',
      'out/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    plugins: { sonarjs },
    rules: {
      // 注释掉的代码是 lint 错误，不是安全网（工程规范 §4.4）
      'sonarjs/no-commented-code': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // 服务日志统一走结构化 logger 输出到 stdout（项目工程方向 §2.2）
      'no-console': 'error',
    },
  },
  {
    // 单个文件不超过 500 行（2026-11-08 从四个服务扩到全仓库）：不让补丁一直叠在同几个大文件上
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    rules: { 'max-lines': ['error', { max: 500 }] },
  },
  // 扩到全仓库时已经超长的文件：按当时的行数封顶，只许变短；拆到 500 行以内就从表里删掉
  ...Object.entries(LONG_FILES).map(([file, max]) => ({
    files: [file],
    rules: { 'max-lines': ['error', { max }] },
  })),
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['scripts/**', '**/*.config.{js,mjs,cjs,ts}', '.dependency-cruiser.cjs'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
