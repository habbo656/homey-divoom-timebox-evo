import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.homeybuild/**', 'node_modules/**', '.homeycompose/.cache/**', 'app.json', '.hwtest/**'] },
  ...tseslint.configs.recommended,
  {
    // The protocol layer is a pure codec: it may only import its own siblings (docs/architecture.md).
    files: ['src/protocol/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['homey', 'homey/*'], message: 'src/protocol must not depend on Homey.' },
            { group: ['../*'], message: 'src/protocol may only import its own siblings.' },
          ],
        },
      ],
    },
  },
);
