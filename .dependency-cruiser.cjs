'use strict';

const { makeForbiddenRules } = require('./scripts/lib/boundary-rules.cjs');

/**
 * Shared file — owned by the W0 / S20 session (implementation-plan §6 rule 4).
 * The rules live in scripts/lib/boundary-rules.cjs so scripts/__tests__/boundaries.test.mjs
 * can prove that each one actually fails the build when it is violated.
 */
module.exports = {
  forbidden: makeForbiddenRules('^'),
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: '(^|/)(node_modules|dist|coverage|\\.git)/|^scripts/fixtures/',
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.mts', '.js', '.mjs', '.json'],
      mainFields: ['module', 'main', 'types'],
    },
  },
};
