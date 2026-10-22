// Общий интерфейс AI-провайдера.
//
// interface AIProvider {
//   name: string;
//   enabled: boolean;
//   model?: string;
//   prioritize(tasks: TaskInput[], context: { today: string }): Promise<PriorityResult[]>;
// }
//
// TaskInput      = { id, title, description?, dueDate? }
// PriorityResult = { id, priority, score, reason }

import { config } from '../config.js';
import { createDisabledProvider } from './disabled.js';
import { createMockProvider } from './mock.js';

export const PRIORITIES = ['critical', 'high', 'medium', 'low'];
export const MAX_TASKS = 50;
export const MAX_REASON = 200;

export class AIError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Проверяет ответ провайдера: отбрасывает чужие id, неверные приоритеты и т. п.
export function validateResults(raw, tasks) {
  const ids = new Set(tasks.map(t => t.id));
  const seen = new Set();
  const results = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    const { id, priority, score, reason } = item;
    if (!ids.has(id) || seen.has(id)) continue;
    if (!PRIORITIES.includes(priority)) continue;
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) continue;
    if (typeof reason !== 'string' || !reason.trim()) continue;
    seen.add(id);
    results.push({ id, priority, score: Math.round(score), reason: reason.trim().slice(0, MAX_REASON) });
  }
  if (!results.length) {
    throw new AIError('AI_BAD_RESPONSE', 502, 'AI вернул некорректный ответ');
  }
  return results;
}

// Провайдер создаётся один раз на экземпляр функции.
let _provider;
export const getProvider = () => (_provider ||= createProvider());

async function createProvider() {
  if (config.aiProvider === 'mock') return createMockProvider();
  if (config.aiProvider === 'none') return createDisabledProvider('выключен в AI_PROVIDER');
  if (!config.apiKey) return createDisabledProvider('ключ не задан');

  try {
    const { createAnthropicProvider } = await import('./anthropic.js');
    return createAnthropicProvider(config);
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') {
      return createDisabledProvider('не установлен @anthropic-ai/sdk, выполните npm install');
    }
    throw err;
  }
}
