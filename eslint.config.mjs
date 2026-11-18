import { fileURLToPath } from 'node:url';
import prettierConfig from 'eslint-config-prettier';
import unusedImports from 'eslint-plugin-unused-imports';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/.next/**',
      '**/node_modules/**',
      '**/next-env.d.ts',
      // Vendor copies from the AI Elements / shadcn registries — lint Orbit-owned code instead.
      'apps/web/src/components/ai-elements/**',
      'apps/web/src/components/ui/alert.tsx',
      'apps/web/src/components/ui/badge.tsx',
      'apps/web/src/components/ui/button-group.tsx',
      'apps/web/src/components/ui/collapsible.tsx',
      'apps/web/src/components/ui/command.tsx',
      'apps/web/src/components/ui/dialog.tsx',
      'apps/web/src/components/ui/dropdown-menu.tsx',
      'apps/web/src/components/ui/empty.tsx',
      'apps/web/src/components/ui/field.tsx',
      'apps/web/src/components/ui/hover-card.tsx',
      'apps/web/src/components/ui/input-group.tsx',
      'apps/web/src/components/ui/input.tsx',
      'apps/web/src/components/ui/label.tsx',
      'apps/web/src/components/ui/select.tsx',
      'apps/web/src/components/ui/separator.tsx',
      'apps/web/src/components/ui/tabs.tsx',
      'apps/web/src/components/ui/textarea.tsx',
      'apps/web/src/components/ui/tooltip.tsx',
    ],
  },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: fileURLToPath(new URL('.', import.meta.url)),
      },
    },
    plugins: { 'unused-imports': unusedImports },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['./*', '../*'], message: 'Use @/* for application imports.' }] },
      ],
    },
  },
  { files: ['apps/worker/**/*.{ts,tsx}'], rules: { 'no-console': 'off' } },
  prettierConfig,
);
