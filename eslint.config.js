// ESLint (flat config) with type-aware typescript-eslint rules.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/*.js', '**/*.mjs', 'node_modules/', 'dist/', '.dev-profile/', '.claude/'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { project: ['./tsconfig.json', './tsconfig.node.json'], tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    rules: {
      // tmux treats '' and 0 as unset and the code relies on `||` for that,
      // so `||` is not mechanically interchangeable with `??`.
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      // `async` functions keep promise-returning contracts (Ui, plugin hooks) even without an await.
      '@typescript-eslint/require-await': 'off',
      // No-op callbacks and stub methods are intentional.
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: { globals: { ...globals.browser, chrome: 'readonly' } },
  },
  {
    files: ['tests/**/*.ts', 'tests/**/*.mts', 'tools/**/*.ts', 'tools/**/*.mts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // node:test's test() returns a promise the runner tracks itself.
      '@typescript-eslint/no-floating-promises': ['error', { allowForKnownSafeCalls: [{ from: 'package', name: 'test', package: 'node:test' }] }],
    },
  },
);
