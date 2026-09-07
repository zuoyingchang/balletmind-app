require('dotenv').config();

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_KEY = process.env.ADMIN_KEY; // optional — gates the /stats.html metrics page

// Guards against a runaway retry loop or a single oversized request burning
// through the Anthropic budget — not a business feature, just a safety cap.
const DAILY_AI_LIMIT = Number(process.env.DAILY_AI_LIMIT) || 30; // per user, per calendar day
const MAX_TRANSCRIPT_LENGTH = Number(process.env.MAX_TRANSCRIPT_LENGTH) || 4000; // characters

// Model is env-configurable so swapping tiers (e.g. to A/B a cheaper/faster
// model against quality) doesn't require a code change or redeploy of logic.
const AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-4-6';
const AI_MAX_OUTPUT_TOKENS = Number(process.env.AI_MAX_OUTPUT_TOKENS) || 1000;
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 25000;

if (!JWT_SECRET) {
  console.error('缺少 JWT_SECRET，请在 .env 里配置（用于登录令牌签名）');
  process.exit(1);
}

module.exports = {
  PORT, JWT_SECRET, ADMIN_KEY, DAILY_AI_LIMIT, MAX_TRANSCRIPT_LENGTH,
  AI_MODEL, AI_MAX_OUTPUT_TOKENS, AI_TIMEOUT_MS,
};
