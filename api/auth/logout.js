/* POST /api/auth/logout — выйти: удалить сессию и cookie */
import { route, send, destroySession } from '../_lib/server.js';

export default route(['POST'], async (req, res) => {
  await destroySession(req, res);
  send(res, 204);
});
