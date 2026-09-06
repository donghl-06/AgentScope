import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/.vite/**',
      '**/*.tsbuildinfo',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        URL: 'readonly',
        console: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        setInterval: 'readonly',
      },
    },
  },
  {
    files: ['packages/protocol/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@agentscope/*'],
              message: 'Protocol must remain dependency-free from other AgentScope packages.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/core/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@agentscope/adapter-*',
                '@agentscope/storage',
                '@agentscope/observer-*',
                '@agentscope/progress',
                '@agentscope/eta',
              ],
              message:
                'Core may depend on protocol/shared contracts, not provider or infrastructure packages.',
            },
          ],
        },
      ],
    },
  },
);
