const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isValidPassword, PASSWORD_RULE_ERROR, passwordRuleError } = require('../lib/password-format');

test('password must be 6+ chars with a letter and a digit', () => {
  assert.equal(isValidPassword('secret123'), true);
  assert.equal(isValidPassword('Ab1def'), true);
  assert.equal(isValidPassword('123456'), false);
  assert.equal(isValidPassword('abcdef'), false);
  assert.equal(isValidPassword('ab12'), false);
  assert.equal(passwordRuleError('abcdef'), PASSWORD_RULE_ERROR);
  assert.equal(passwordRuleError('secret123'), null);
});
