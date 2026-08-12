import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'src/**/*.d.ts', '*.config.{js,ts}'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['e2e/**/*.mjs'],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: {
        $: 'readonly',
        before: 'readonly',
        browser: 'readonly',
        describe: 'readonly',
        document: 'readonly',
        expect: 'readonly',
        HTMLMediaElement: 'readonly',
        HTMLVideoElement: 'readonly',
        it: 'readonly',
      },
    },
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['wdio.conf.mjs'],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { process: 'readonly' },
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { react },
    settings: { react: { version: 'detect' } },
    rules: {
      'react/react-in-jsx-scope': 'off',
    },
  },
);
