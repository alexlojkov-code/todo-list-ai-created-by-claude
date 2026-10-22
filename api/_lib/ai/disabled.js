import { AIError } from './provider.js';

// Заглушка на случай, когда AI недоступен (нет ключа, выключен, нет SDK).
export function createDisabledProvider(reason) {
  return {
    name: 'none',
    enabled: false,
    reason,
    async prioritize() {
      throw new AIError('AI_DISABLED', 503, 'AI выключен: на сервере не задан API-ключ');
    },
  };
}
