// Accounts that are obviously ours, not real users: reserved example domains plus the
// test / test1 / tes2t @qq.com style throwaway addresses. Used only for the stats page split.
const TEST_EMAIL_DOMAINS = ['test.local', 'example.com', 'example.org', 'example.net'];
const TEST_QQ_LOCAL = /^tes[t0-9]*$/i;

function isTestAccountEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return false;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (TEST_EMAIL_DOMAINS.includes(domain)) return true;
  return domain === 'qq.com' && TEST_QQ_LOCAL.test(local);
}

function splitTestUsers(userRows) {
  const rows = userRows || [];
  const test = rows.filter((u) => isTestAccountEmail(u.email)).length;
  return {
    registered: rows.length,
    test,
    real: rows.length - test,
    rule: '测试账号 = 邮箱是 @test.local / @example.com / @example.org，或 test、test1、tes2t 这类 @qq.com',
  };
}

module.exports = { isTestAccountEmail, splitTestUsers };
