/* POST /api/ai/prioritize — расставить приоритеты задачам.
   Тело: { tasks: [{ id, title, description?, dueDate? }] }, ответ: { results: [{ id, priority, score, reason }] } */
import { route, body, send, problem, hasDb, currentSession } from '../_lib/server.js';
import { AIError, MAX_TASKS, getProvider, validateResults } from '../_lib/ai/provider.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function str(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Оставляет только поля, которые разрешено отправлять AI.
function toTaskInputs(data) {
  const list = Array.isArray(data?.tasks) ? data.tasks : [];
  const tasks = [];
  for (const t of list) {
    const id = str(t?.id, 64);
    const title = str(t?.title, 200);
    if (!id || !title) continue;
    const task = { id, title };
    const description = str(t.description, 2000);
    if (description) task.description = description;
    if (DATE.test(t.dueDate || '')) task.dueDate = t.dueDate;
    tasks.push(task);
  }
  if (!tasks.length) throw new AIError('BAD_REQUEST', 400, 'Нет задач для приоритезации');
  if (tasks.length > MAX_TASKS) throw new AIError('BAD_REQUEST', 400, `Не больше ${MAX_TASKS} задач за раз`);
  return tasks;
}

function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

export default route(['POST'], async (req, res) => {
  try {
    const provider = await getProvider();
    if (!provider.enabled) await provider.prioritize();
    if (hasDb() && !(await currentSession(req))) {
      return problem(res, 401, 'UNAUTHORIZED', 'Войдите в аккаунт, чтобы использовать AI');
    }
    const tasks = toTaskInputs(body(req));
    const today = DATE.test(req.headers['x-today'] || '') ? req.headers['x-today'] : utcToday();
    const raw = await provider.prioritize(tasks, { today });
    send(res, 200, { results: validateResults(raw, tasks) });
  } catch (err) {
    if (err instanceof AIError) return problem(res, err.status, err.code, err.message);
    throw err;
  }
});
