// Dual gate for the multi-agent pre-class brief experiment.
// Both must be on or every user stays on the 0-LLM rule card.
// Default: flag off, allowlist empty → nobody is impacted.
function parseUserIds(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function isIssueBriefExperimentOn(userId, env = process.env) {
  const flagOn = /^(1|true|yes)$/i.test(String(env.EXPERIMENT_ISSUE_BRIEF || ''));
  if (!flagOn) return false;
  const allowlist = parseUserIds(env.EXPERIMENT_ISSUE_BRIEF_USER_IDS);
  if (!allowlist.length) return false;
  return allowlist.includes(Number(userId));
}

module.exports = { isIssueBriefExperimentOn, parseUserIds };
