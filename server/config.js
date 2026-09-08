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
const ASR_MODEL = process.env.ASR_MODEL || 'whisper-1';
const ASR_TIMEOUT_MS = Number(process.env.ASR_TIMEOUT_MS) || 30000;
const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_BYTES) || 10 * 1024 * 1024;

// Password-reset email. Without RESEND_API_KEY, forgot-password still creates
// a token but only returns the reset URL outside production (so tests / local
// demo work). Production needs Resend or the user never sees the link.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'BalletMind <beth.t@example.com>';
const APP_PUBLIC_URL = (process.env.APP_PUBLIC_URL || '').replace(/\/$/, '');
const RESET_TOKEN_TTL_MS = Number(process.env.RESET_TOKEN_TTL_MS) || 60 * 60 * 1000;

// Rough $/1M token rates for the internal stats page — not a billing API.
// Override when you switch model tiers so "usd per save" stays in the right ballpark.
const ANTHROPIC_INPUT_USD_PER_MTOK = Number(process.env.ANTHROPIC_INPUT_USD_PER_MTOK) || 2;
const ANTHROPIC_OUTPUT_USD_PER_MTOK = Number(process.env.ANTHROPIC_OUTPUT_USD_PER_MTOK) || 10;

// Optional comma-separated emails excluded from the "real users" Layer 3 slice.
const ANALYTICS_INTERNAL_EMAILS = (process.env.ANALYTICS_INTERNAL_EMAILS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

if (!JWT_SECRET) {
  console.error('缺少 JWT_SECRET，请在 .env 里配置（用于登录令牌签名）');
  process.exit(1);
}

module.exports = {
  PORT, JWT_SECRET, ADMIN_KEY, DAILY_AI_LIMIT, MAX_TRANSCRIPT_LENGTH,
  AI_MODEL, AI_MAX_OUTPUT_TOKENS, AI_TIMEOUT_MS, AI_TEMPERATURE,
  OPENAI_API_KEY, ASR_MODEL, ASR_TIMEOUT_MS, MAX_AUDIO_BYTES,
  RESEND_API_KEY, EMAIL_FROM, APP_PUBLIC_URL, RESET_TOKEN_TTL_MS,
  ANTHROPIC_INPUT_USD_PER_MTOK, ANTHROPIC_OUTPUT_USD_PER_MTOK,
  ANALYTICS_INTERNAL_EMAILS,
};
