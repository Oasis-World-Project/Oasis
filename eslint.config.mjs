// 全仓统一的 ESLint 配置（工程规范 §4、§7）。
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import sonarjs from 'eslint-plugin-sonarjs';
import globals from 'globals';
import tseslint from 'typescript-eslint';

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
    // 已按职责拆开的服务：单个文件不超过 500 行，防止再长回去
    files: ['services/{task,harness,model-gateway}/{src,test}/**/*.ts'],
    rules: { 'max-lines': ['error', { max: 500 }] },
  },
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
