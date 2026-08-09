import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'packages/contracts/schemas/**',
      'scripts/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'separate-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-syntax': [
        'error',
        {
          // Contracts §1: "Secret values are illegal in contracts." Ambient process.env in
          // library code is how one gets smuggled in. Configuration is passed to a factory.
          selector: 'MemberExpression[object.object.name="process"][object.property.name="env"]',
          message:
            'Read configuration through an injected config object, not process.env, so secrets ' +
            'never become ambient. CLIs, bootstrap and tests are exempt (see the override).',
        },
      ],
      'no-console': 'error',
    },
  },
  {
    // CLIs, bootstrap, spikes and test code legitimately talk to the process and the console.
    //
    // `spikes/**` is exempted from these two rules rather than ignored outright: a spike is
    // throwaway by design, but its *measurements* have to be trustworthy, so the rules that
    // catch real defects — unused bindings, shadowing, `any` — still apply. Added by SP2
    // against a W0-owned file; see the contract request.
    files: [
      'scripts/**',
      'spikes/**',
      '**/bin/**',
      '**/cli.ts',
      '**/*.test.ts',
      '**/test/**',
      'packages/sdk/src/observability/**',
      'packages/example-consumer/**',
    ],
    rules: {
      'no-console': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
