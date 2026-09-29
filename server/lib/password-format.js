const MIN_PASSWORD_LENGTH = 6;
const PASSWORD_RULE_ERROR = '密码至少6位，且要同时有字母和数字';

function isValidPassword(password) {
  const value = String(password || '');
  if (value.length < MIN_PASSWORD_LENGTH) return false;
  return /[A-Za-z]/.test(value) && /\d/.test(value);
}

function passwordRuleError(password) {
  return isValidPassword(password) ? null : PASSWORD_RULE_ERROR;
}

module.exports = { MIN_PASSWORD_LENGTH, PASSWORD_RULE_ERROR, isValidPassword, passwordRuleError };
