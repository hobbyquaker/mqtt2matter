// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// The module boundaries of docs/architecture.md, enforced where they can be: an importer writes the
// manual model and reads the topic cache, nothing else; a family handler knows the engine's output
// and matter.js, never where a device came from or how the config is loaded; the model and the
// engine are pure. `no-restricted-imports` sees relative paths only, so each rule names the sibling
// folders a layer must not reach into.
const forbid = (...folders) => ({
    patterns: folders.map((folder) => ({
        group: [`**/${folder}/*`, `**/${folder}`],
        message: `this layer must not depend on ${folder}/ (docs/architecture.md)`,
    })),
});

export default tseslint.config(
    {
        // the UI is type-checked by svelte-check (its own tsconfig); eslint has no Svelte parser here
        ignores: [
            'dist/**',
            'coverage/**',
            'data/**',
            'ui/**',
            'playwright-report/**',
            'test-results/**',
            // the release workflow's script, plain JavaScript outside the TypeScript project
            '.github/**',
        ],
    },
    js.configs.recommended,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,
    prettier,
    {
        languageOptions: {
            globals: {...globals.node},
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@typescript-eslint/restrict-template-expressions': ['error', {allowNumber: true, allowBoolean: true}],
            '@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_'}],
            '@typescript-eslint/consistent-type-definitions': 'off',
            'no-console': 'error',
        },
    },
    {
        files: ['src/log.ts', 'src/main.ts'],
        rules: {'no-console': 'off'},
    },
    {
        files: ['src/importers/**/*.ts'],
        rules: {'no-restricted-imports': ['error', forbid('matter', 'families', 'engine', 'server', 'config', 'ui')]},
    },
    {
        files: ['src/families/**/*.ts'],
        rules: {'no-restricted-imports': ['error', forbid('importers', 'config', 'server', 'mqtt', 'ui')]},
    },
    {
        files: ['src/engine/**/*.ts', 'src/model/**/*.ts'],
        rules: {
            'no-restricted-imports': ['error', forbid('matter', 'importers', 'server', 'config', 'ui', 'families')],
        },
    },
    {
        files: ['src/mqtt/**/*.ts'],
        rules: {
            'no-restricted-imports': ['error', forbid('matter', 'importers', 'server', 'families', 'engine', 'ui')],
        },
    },
    {
        files: ['eslint.config.js', 'vitest.config.ts'],
        extends: [tseslint.configs.disableTypeChecked],
    },
    {
        files: ['test/**/*.ts'],
        rules: {
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
        },
    },
);
