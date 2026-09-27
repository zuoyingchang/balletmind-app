process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
const app = require('./app');
const { PORT } = require('./config');
const db = require('./db');

db.ready
  .then(() => {
    app.listen(PORT, () => {
      console.log(`BalletMind server running at http://localhost:${PORT}`);
      const cfg = require('./config');
      console.log(`[startup] node=${process.version} env=${process.env.NODE_ENV || 'dev'} model=${cfg.AI_MODEL} asr=${cfg.ASR_MODEL} dailyLimit=${cfg.DAILY_AI_LIMIT}`);
      const provider = require('./ai/provider');
      console.log(`[startup] llmProvider=${provider.providerName()} llmConfigured=${provider.aiConfigured()}`);
      console.log(`[startup] anthropic=${!!process.env.ANTHROPIC_API_KEY} openai=${!!cfg.OPENAI_API_KEY} email=${!!cfg.RESEND_API_KEY} adminKey=${!!cfg.ADMIN_KEY} publicUrl=${!!cfg.APP_PUBLIC_URL}`);
      if (!provider.aiConfigured()) console.error(`[ALERT][config] ${provider.missingConfigHint()}`);
      const wantsFallback = String(process.env.AI_FALLBACK_PROVIDER || '').toLowerCase() === 'anthropic';
      console.log(`[startup] llmFallback=${provider.fallbackProviderName() || 'off'}`);
      if (wantsFallback && !provider.fallbackProviderName()) console.warn('[ALERT][config] AI_FALLBACK_PROVIDER=anthropic is set but not usable (needs AI_PROVIDER=openai-compatible and ANTHROPIC_API_KEY)');
      if (!cfg.RESEND_API_KEY) console.warn('[ALERT][config] RESEND_API_KEY is not set: password-reset emails cannot be sent');
      if (/example\.com/.test(cfg.EMAIL_FROM)) console.warn('[ALERT][config] EMAIL_FROM still uses the example.com placeholder');
    });
  })
  .catch((err) => {
    console.error('数据库初始化失败', err);
    process.exit(1);
  });
