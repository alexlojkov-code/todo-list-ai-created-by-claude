/* POST /api/auth/login — вход по email и паролю.
   После 5 неудачных попыток вход в аккаунт блокируется на 15 минут. */
import { route, body, db, send, problem, normEmail, verifyPassword, dummyHash, createSession, publicUser } from '../_lib/server.js';

const MAX_FAILS = 5, LOCK_MINUTES = 15;

export default route(['POST'], async (req, res) => {
  const b = body(req);
  const email = normEmail(b.email);
  const password = String(b.password || '');
  const rows = email ? await db()`select id, email, name, password_hash, failed_logins, locked_until, created_at
                                  from users where email = ${email}` : [];
  const user = rows[0];
  if (!user) {
    await verifyPassword(password, await dummyHash());
    return problem(res, 401, 'INVALID_CREDENTIALS', 'Неверный email или пароль');
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    res.setHeader('Retry-After', String(Math.ceil((new Date(user.locked_until) - Date.now()) / 1000)));
    return problem(res, 429, 'LOCKED', `Слишком много попыток, попробуйте через ${LOCK_MINUTES} минут`);
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    await db()`update users set
                 failed_logins = case when failed_logins + 1 >= ${MAX_FAILS} then 0 else failed_logins + 1 end,
                 locked_until  = case when failed_logins + 1 >= ${MAX_FAILS} then now() + make_interval(mins => ${LOCK_MINUTES}) else locked_until end
               where id = ${user.id}`;
    return problem(res, 401, 'INVALID_CREDENTIALS', 'Неверный email или пароль');
  }
  await db()`update users set failed_logins = 0, locked_until = null, last_login_at = now() where id = ${user.id}`;
  await createSession(req, res, user.id);
  send(res, 200, { user: publicUser(user) });
});
