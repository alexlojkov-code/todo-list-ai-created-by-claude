/* POST /api/auth/register — создать аккаунт и сразу войти */
import { route, body, db, send, problem, normEmail, validEmail, passwordProblem, PASSWORD_MESSAGES, hashPassword, createSession, publicUser } from '../_lib/server.js';

export default route(['POST'], async (req, res) => {
  const b = body(req);
  const email = normEmail(b.email);
  const name = String(b.name || '').trim().slice(0, 60);
  if (!validEmail(email)) return problem(res, 400, 'INVALID_EMAIL', 'Некорректный email');
  const pwErr = passwordProblem(b.password, email);
  if (pwErr) return problem(res, 400, pwErr, PASSWORD_MESSAGES[pwErr]);
  const hash = await hashPassword(b.password);
  let rows;
  try {
    rows = await db()`insert into users (email, password_hash, name) values (${email}, ${hash}, ${name})
                      returning id, email, name, created_at`;
  } catch (e) {
    if (e.code === '23505') return problem(res, 409, 'EMAIL_TAKEN', 'Аккаунт с таким email уже есть');
    throw e;
  }
  await createSession(req, res, rows[0].id);
  send(res, 201, { user: publicUser(rows[0]) });
});
