require('dotenv').config();
const db = require('./db');

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_KEY = process.env.ADMIN_KEY; // optional — gates the /stats.html metrics page

// Guards against a runaway retry loop or a single oversized request burning
// through the Anthropic budget — not a business feature, just a safety cap.
// Core flow only (record a class: transcribe + structure into a draft) — see events.js
// CORE_QUOTA_EVENTS. Kept separate from WEEKLY_ASK_LIMIT so an optional feature
// (ask-your-archive, the gated pre-class experiment) can never crowd out the quota a user
// needs to actually record and save a real class.
const DAILY_AI_LIMIT = Number(process.env.DAILY_AI_LIMIT) || 12; // per user, per calendar day; ~4 recaps if 2 ASR + 1 generate
// 问问档案 (+ the gated issue-brief experiment) — weekly, not daily.
// WEEKLY_ASK_LIMIT is the shared fallback both tiers resolve to today (see
// weeklyAskLimitFor below) -- during the trial, free and paid get the same
// 10/week. When the paid tier actually launches: lower
// WEEKLY_ASK_LIMIT_FREE (e.g. to a one-time gift that doesn't refill) and
// leave WEEKLY_ASK_LIMIT_PAID where it is. No payment flow exists yet;
// users.plan is just the column a future admin/payment action will set.
const WEEKLY_ASK_LIMIT = Number(process.env.WEEKLY_ASK_LIMIT) || 10;
const WEEKLY_ASK_LIMIT_PAID = Number(process.env.WEEKLY_ASK_LIMIT_PAID) || WEEKLY_ASK_LIMIT;
const WEEKLY_ASK_LIMIT_FREE = Number(process.env.WEEKLY_ASK_LIMIT_FREE) || WEEKLY_ASK_LIMIT;
const MAX_TRANSCRIPT_LENGTH = Number(process.env.MAX_TRANSCRIPT_LENGTH) || 4000; // characters

// The actual free-tier business quota (unlike DAILY_AI_LIMIT above, which is
// just an anti-abuse safety cap, not a monetization lever). Gates
// /api/generate per calendar day -- see events.js countAiRecapsToday. Once a
// user hits this, the client routes them to 手动记 (skip AI, type
// good/improve points directly) instead of a dead end.
const DAILY_RECAP_LIMIT = Number(process.env.DAILY_RECAP_LIMIT) || 2;

// Same allowlist shape as experiments/issue-brief-gate.js: a higher limit for a short list of
// user IDs (e.g. the builder's own account doing real-device testing), everyone else unaffected.
// Applies to both pools (core and secondary) for whoever is on the allowlist.
const DAILY_AI_LIMIT_OVERRIDE = Number(process.env.DAILY_AI_LIMIT_OVERRIDE) || 0;
const DAILY_AI_LIMIT_OVERRIDE_USER_IDS = String(process.env.DAILY_AI_LIMIT_OVERRIDE_USER_IDS || '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);
function isDailyAiLimitOverridden(userId) {
  return DAILY_AI_LIMIT_OVERRIDE > 0 && DAILY_AI_LIMIT_OVERRIDE_USER_IDS.includes(Number(userId));
}
function dailyAiLimitFor(userId) {
  return isDailyAiLimitOverridden(userId) ? DAILY_AI_LIMIT_OVERRIDE : DAILY_AI_LIMIT;
}
async function isPaidUser(userId) {
  const row = await db.get('SELECT plan FROM users WHERE id = ?', [userId]);
  return !!row && row.plan === 'paid';
}
async function weeklyAskLimitFor(userId) {
  if (isDailyAiLimitOverridden(userId)) return DAILY_AI_LIMIT_OVERRIDE;
  return (await isPaidUser(userId)) ? WEEKLY_ASK_LIMIT_PAID : WEEKLY_ASK_LIMIT_FREE;
}
function dailyRecapLimitFor(userId) {
  return isDailyAiLimitOverridden(userId) ? DAILY_AI_LIMIT_OVERRIDE : DAILY_RECAP_LIMIT;
}

// Model is env-configurable so swapping tiers (e.g. to A/B a cheaper/faster
// model against quality) doesn't require a code change or redeploy of logic.
// Default: Sonnet 5. Do not send `temperature` for this family (API rejects it).
const AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-5';
const AI_MAX_OUTPUT_TOKENS = Number(process.env.AI_MAX_OUTPUT_TOKENS) || 1000;
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 25000;
// Only used for the PRIMARY provider's first attempt when a fallback is
// configured (AI_FALLBACK_PROVIDER) -- with nowhere to fall back to, a
// request still gets the full AI_TIMEOUT_MS. Default 5000: a short
// structured-extraction call (not creative writing) on a healthy provider
// measured well under 2s (535ms / 1.8s on DeepSeek and Anthropic directly);
// a request still running at 5s is already a sign of real degradation, not
// normal variance, so handing off to the fallback here isn't premature.
const AI_PRIMARY_TIMEOUT_MS = Number(process.env.AI_PRIMARY_TIMEOUT_MS) || 5000;
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
  PORT, JWT_SECRET, ADMIN_KEY, DAILY_AI_LIMIT, dailyAiLimitFor,
  WEEKLY_ASK_LIMIT, WEEKLY_ASK_LIMIT_PAID, WEEKLY_ASK_LIMIT_FREE, weeklyAskLimitFor, isPaidUser,
  DAILY_RECAP_LIMIT, dailyRecapLimitFor, MAX_TRANSCRIPT_LENGTH,
  AI_MODEL, AI_MAX_OUTPUT_TOKENS, AI_TIMEOUT_MS, AI_PRIMARY_TIMEOUT_MS, AI_TEMPERATURE,
  OPENAI_API_KEY, ASR_MODEL, ASR_TIMEOUT_MS, MAX_AUDIO_BYTES,
  RESEND_API_KEY, EMAIL_FROM, APP_PUBLIC_URL, RESET_TOKEN_TTL_MS,
  ANTHROPIC_INPUT_USD_PER_MTOK, ANTHROPIC_OUTPUT_USD_PER_MTOK,
  DEEPSEEK_INPUT_USD_PER_MTOK, DEEPSEEK_OUTPUT_USD_PER_MTOK, WHISPER_USD_PER_MIN,
  ANALYTICS_INTERNAL_EMAILS,
  EXPERIMENT_ISSUE_BRIEF, EXPERIMENT_ISSUE_BRIEF_USER_IDS,
};
