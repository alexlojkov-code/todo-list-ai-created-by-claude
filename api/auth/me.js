/* GET /api/auth/me — кто вошёл (401, если никто; 503, если аккаунты не настроены) */
import { route, send, problem, hasDb, currentSession, publicUser } from '../_lib/server.js';

export default route(['GET'], async (req, res) => {
  if (!hasDb()) return problem(res, 503, 'ACCOUNTS_DISABLED', 'Аккаунты не настроены на этом сервере');
  const s = await currentSession(req);
  if (!s) return problem(res, 401, 'UNAUTHORIZED', 'Вы не вошли в аккаунт');
  send(res, 200, { user: publicUser(s) });
});
