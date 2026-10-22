/* GET /api/ai/status — включён ли AI. Ключ никогда не возвращается. */
import { route, send, hasDb } from '../_lib/server.js';
import { getProvider } from '../_lib/ai/provider.js';

export default route(['GET'], async (req, res) => {
  const provider = await getProvider();
  send(res, 200, {
    enabled: provider.enabled,
    provider: provider.name,
    ...(provider.model && { model: provider.model }),
    ...(provider.reason && { reason: provider.reason }),
    // на сервере с аккаунтами AI доступен только после входа: ключ не расходуется анонимно
    requiresAuth: hasDb(),
  });
});
