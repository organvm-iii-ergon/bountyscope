import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', '.wrangler/**', 'node_modules/**', 'public/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        Request: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        Headers: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        process: 'readonly',
        globalThis: 'readonly',
      }
    },
    rules: {
      // The Worker leans on `any` for the Workers AI binding and a few JSON
      // boundaries; allow it rather than paper over with bogus types.
      '@typescript-eslint/no-explicit-any': 'off',
      // Unused vars are an error, but allow a leading underscore to mark intent.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // `try { … } catch {}` is a deliberate best-effort pattern here (e.g. HEAD
      // polling that should never throw); empty catch blocks are fine.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['tests/**/*.mjs', 'test/**/*.mjs'],
    languageOptions: {
      globals: {
        Request: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        Headers: 'readonly',
        fetch: 'readonly',
      },
    },
  },
);
