require('dotenv').config();

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_KEY = process.env.ADMIN_KEY; // optional — gates the /stats.html metrics page

// Guards against a runaway retry loop or a single oversized request burning
// through the Anthropic budget — not a business feature, just a safety cap.
const DAILY_AI_LIMIT = Number(process.env.DAILY_AI_LIMIT) || 15; // per user, per calendar day
const MAX_TRANSCRIPT_LENGTH = Number(process.env.MAX_TRANSCRIPT_LENGTH) || 4000; // characters

// Same allowlist shape as experiments/issue-brief-gate.js: a higher limit for a short list of
// user IDs (e.g. the builder's own account doing real-device testing), everyone else unaffected.
const DAILY_AI_LIMIT_OVERRIDE = Number(process.env.DAILY_AI_LIMIT_OVERRIDE) || 0;
const DAILY_AI_LIMIT_OVERRIDE_USER_IDS = String(process.env.DAILY_AI_LIMIT_OVERRIDE_USER_IDS || '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);
function dailyAiLimitFor(userId) {
  if (DAILY_AI_LIMIT_OVERRIDE > 0 && DAILY_AI_LIMIT_OVERRIDE_USER_IDS.includes(Number(userId))) {
    return DAILY_AI_LIMIT_OVERRIDE;
  }
  return DAILY_AI_LIMIT;
}

// Model is env-configurable so swapping tiers (e.g. to A/B a cheaper/faster
// model against quality) doesn't require a code change or redeploy of logic.
// Default: Sonnet 5. Do not send `temperature` for this family (API rejects it).
const AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-5';
const AI_MAX_OUTPUT_TOKENS = Number(process.env.AI_MAX_OUTPUT_TOKENS) || 1000;
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 25000;
// Low, not zero: this is faithful extraction (not creative writing), so we
// want consistent phrasing run-to-run over Anthropic's default. Not fully
// deterministic (0) because a little natural-language variation in how a
// point is worded is fine — what matters is the *content* stays stable.
const AI_TEMPERATURE = process.env.AI_TEMPERATURE === undefined ? 0.2 : Number(process.env.AI_TEMPERATURE);

// OpenAI Whisper (or gpt-4o-mini-transcribe). Optional: if unset, recording
// still works as a timer + manual typing, but there is no server-side ASR.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ASR_MODEL = process.env.ASR_MODEL || 'gpt-4o-transcribe';
// Same key as Whisper. Used only when keyword retrieval for 问问档案 is sparse
// (0 or 1 hit). Unset key → skip embedding, keep keyword-only behavior.
const ASR_TIMEOUT_MS = Number(process.env.ASR_TIMEOUT_MS) || 30000;
const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_BYTES) || 10 * 1024 * 1024;

// Password-reset email. Without RESEND_API_KEY, forgot-password still creates
// a token but only returns the reset URL outside production (so tests / local
// demo work). Production needs Resend or the user never sees the link.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'BalletMind <beth.t@example.com>';
const APP_PUBLIC_URL = (process.env.APP_PUBLIC_URL || '').replace(/\/$/, '');
const RESET_TOKEN_TTL_MS = Number(process.env.RESET_TOKEN_TTL_MS) || 60 * 60 * 1000;

// Rough list prices for /stats.html — not a billing API.
function envNum(name) {
  const v = process.env[name];
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const aIn = envNum('ANTHROPIC_INPUT_USD_PER_MTOK');
const aOut = envNum('ANTHROPIC_OUTPUT_USD_PER_MTOK');
const dIn = envNum('DEEPSEEK_INPUT_USD_PER_MTOK');
const dOut = envNum('DEEPSEEK_OUTPUT_USD_PER_MTOK');
// If DeepSeek prices were parked on ANTHROPIC_* (common after the provider switch),
// keep those numbers for DeepSeek and use Claude defaults for Anthropic until both pairs are set.
const anthropicEnvLooksLikeDeepSeek = aIn != null && aIn < 1 && aOut != null && aOut < 2 && dIn == null && dOut == null;
const DEEPSEEK_INPUT_USD_PER_MTOK = dIn ?? (anthropicEnvLooksLikeDeepSeek ? aIn : 0.28);
const DEEPSEEK_OUTPUT_USD_PER_MTOK = dOut ?? (anthropicEnvLooksLikeDeepSeek ? aOut : 0.42);
const ANTHROPIC_INPUT_USD_PER_MTOK = anthropicEnvLooksLikeDeepSeek ? 2 : (aIn ?? 2);
const ANTHROPIC_OUTPUT_USD_PER_MTOK = anthropicEnvLooksLikeDeepSeek ? 10 : (aOut ?? 10);
const WHISPER_USD_PER_MIN = envNum('WHISPER_USD_PER_MIN') ?? 0.006;

// Optional comma-separated emails excluded from the "real users" Layer 3 slice.
const ANALYTICS_INTERNAL_EMAILS = (process.env.ANALYTICS_INTERNAL_EMAILS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Multi-agent 课前卡实验。两道闸都开才会跑 LLM；默认全关，所有用户仍走规则卡。
const EXPERIMENT_ISSUE_BRIEF = /^(1|true|yes)$/i.test(String(process.env.EXPERIMENT_ISSUE_BRIEF || ''));
const EXPERIMENT_ISSUE_BRIEF_USER_IDS = process.env.EXPERIMENT_ISSUE_BRIEF_USER_IDS || '';

if (!JWT_SECRET) {
  console.error('缺少 JWT_SECRET，请在 .env 里配置（用于登录令牌签名）');
  process.exit(1);
}

module.exports = {
  PORT, JWT_SECRET, ADMIN_KEY, DAILY_AI_LIMIT, dailyAiLimitFor, MAX_TRANSCRIPT_LENGTH,
  AI_MODEL, AI_MAX_OUTPUT_TOKENS, AI_TIMEOUT_MS, AI_TEMPERATURE,
  OPENAI_API_KEY, ASR_MODEL, ASR_TIMEOUT_MS, MAX_AUDIO_BYTES,
  RESEND_API_KEY, EMAIL_FROM, APP_PUBLIC_URL, RESET_TOKEN_TTL_MS,
  ANTHROPIC_INPUT_USD_PER_MTOK, ANTHROPIC_OUTPUT_USD_PER_MTOK,
  DEEPSEEK_INPUT_USD_PER_MTOK, DEEPSEEK_OUTPUT_USD_PER_MTOK, WHISPER_USD_PER_MIN,
  ANALYTICS_INTERNAL_EMAILS,
  EXPERIMENT_ISSUE_BRIEF, EXPERIMENT_ISSUE_BRIEF_USER_IDS,
};
