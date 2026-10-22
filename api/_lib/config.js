// Настройки из переменных окружения. На Vercel они задаются в проекте,
// локально scripts/dev.mjs подгружает их из .env.

const PROVIDERS = ['anthropic', 'mock', 'none'];

function readProvider() {
  const value = (process.env.AI_PROVIDER || 'anthropic').trim().toLowerCase();
  if (!PROVIDERS.includes(value)) {
    console.warn(`AI_PROVIDER="${value}" не поддерживается, AI выключен. Допустимо: ${PROVIDERS.join(', ')}`);
    return 'none';
  }
  return value;
}

function readInt(name, fallback) {
  const n = Number.parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = Object.freeze({
  aiProvider: readProvider(),
  // Ключ хранится только здесь и никогда не уходит клиенту и в логи.
  apiKey: (process.env.ANTHROPIC_API_KEY || '').trim(),
  aiModel: (process.env.AI_MODEL || 'claude-opus-5-5').trim(),
  aiTimeoutMs: readInt('AI_TIMEOUT_MS', 30000),
});
