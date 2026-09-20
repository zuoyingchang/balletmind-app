const test = require('node:test');
const assert = require('node:assert/strict');
const { isIssueBriefExperimentOn, parseUserIds } = require('../experiments/issue-brief-gate');

test('issue brief experiment is off when env is unset', () => {
  assert.equal(isIssueBriefExperimentOn(11, {}), false);
  assert.equal(isIssueBriefExperimentOn(11, { EXPERIMENT_ISSUE_BRIEF: '1' }), false);
  assert.equal(isIssueBriefExperimentOn(11, { EXPERIMENT_ISSUE_BRIEF_USER_IDS: '11' }), false);
});

test('issue brief experiment requires flag and allowlist together', () => {
  const env = { EXPERIMENT_ISSUE_BRIEF: '1', EXPERIMENT_ISSUE_BRIEF_USER_IDS: '11' };
  assert.equal(isIssueBriefExperimentOn(11, env), true);
  assert.equal(isIssueBriefExperimentOn(12, env), false);
  assert.equal(isIssueBriefExperimentOn(11, { EXPERIMENT_ISSUE_BRIEF: '0', EXPERIMENT_ISSUE_BRIEF_USER_IDS: '11' }), false);
});

test('parseUserIds ignores junk', () => {
  assert.deepEqual(parseUserIds('11, 12, x, 0, -1'), [11, 12]);
});
