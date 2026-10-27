const STORAGE_KEY = 'todo-list-ai';
const DELETED_KEY = 'todo-list-ai.deleted';
const PRIORITIES = ['critical', 'high', 'medium', 'low'];
const PRIORITY_LABELS = { critical: 'Критичный', high: 'Высокий', medium: 'Средний', low: 'Низкий' };
const MAX_AI_TASKS = 50;
const UNDO_MS = 10000;

const $ = id => document.getElementById(id);
const form = $('add-form');
const titleInput = $('add-title');
const descInput = $('add-desc');
const dueInput = $('add-due');
const list = $('list');
const empty = $('empty');
const counter = $('counter');
const filters = $('filters');
const sortSelect = $('sort');
const clearDone = $('clear-done');
const aiStatus = $('ai-status');
const aiBtn = $('ai-btn');
const aiHint = $('ai-hint');
const toast = $('toast');
const toastText = $('toast-text');
const toastUndo = $('toast-undo');

let tasks = load();
// id удалённых задач и время удаления: нужны, чтобы удаление не «воскресло» при синхронизации
let deleted = loadDeleted();
let filter = 'all';
let sort = 'priority';
let ai = { enabled: false, checked: false };
let aiBusy = false;
let undoSnapshot = null;
let toastTimer = null;
const openReasons = new Set();
// Редактируемая задача и черновик полей: черновик переживает перерисовку (например, при синхронизации)
let editing = null; // { id, title, description, dueDate }

// ---------- хранение ----------

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function loadDeleted() {
  try {
    const data = JSON.parse(localStorage.getItem(DELETED_KEY));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    localStorage.setItem(DELETED_KEY, JSON.stringify(deleted));
  } catch {}
}

function commit(next) {
  const now = new Date().toISOString();
  const kept = new Set(next.map(t => t.id));
  for (const t of tasks) if (!kept.has(t.id)) deleted[t.id] = now;
  tasks = next;
  save();
  render();
  Cloud.schedule();
}

// ---------- обмен данными с cloud.js ----------

function snapshot() {
  return { tasks: structuredClone(tasks), deleted: { ...deleted } };
}

function applyData(data) {
  tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  deleted = data?.deleted && typeof data.deleted === 'object' ? data.deleted : {};
  save();
  render();
}

function hasLocalTasks() {
  return tasks.length > 0;
}

function wipeLocal() {
  tasks = [];
  deleted = {};
  openReasons.clear();
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(DELETED_KEY);
  } catch {}
  render();
}

function patch(id, changes) {
  const now = new Date().toISOString();
  commit(tasks.map(t => t.id === id ? { ...t, ...changes, updatedAt: now } : t));
}

// ---------- утилиты ----------

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function formatDue(date) {
  const [y, m, d] = date.split('-').map(Number);
  const diff = Math.round((new Date(y, m - 1, d) - new Date(today())) / 86400000);
  if (diff === 0) return 'сегодня';
  if (diff === 1) return 'завтра';
  if (diff === -1) return 'вчера';
  return new Date(y, m - 1, d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function compare(a, b) {
  if (a.done !== b.done) return a.done ? 1 : -1;
  if (sort === 'priority') {
    const p = PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority);
    if (p) return p;
    const s = (b.aiScore ?? -1) - (a.aiScore ?? -1);
    if (s) return s;
  }
  if (sort === 'due' || sort === 'priority') {
    if (a.dueDate !== b.dueDate) {
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate < b.dueDate ? -1 : 1;
    }
  }
  return a.createdAt < b.createdAt ? 1 : -1;
}

// ---------- отрисовка ----------

function renderEditor(task, index) {
  const form = el('form', { className: 'item__form', dataset: { action: 'edit-form' } }, [
    el('label', { className: 'field' }, [
      el('span', { textContent: 'название' }),
      el('input', { type: 'text', name: 'title', className: 'item__edit', value: editing.title, maxLength: 200, required: true }),
    ]),
    el('label', { className: 'field' }, [
      el('span', { textContent: 'описание' }),
      el('textarea', { name: 'description', className: 'item__textarea', value: editing.description, maxLength: 2000, rows: 2, placeholder: 'необязательно' }),
    ]),
    el('div', { className: 'item__form-row' }, [
      el('label', { className: 'field field--inline' }, [
        el('span', { textContent: 'срок' }),
        el('input', { type: 'date', name: 'dueDate', value: editing.dueDate }),
      ]),
      el('div', { className: 'item__form-actions' }, [
        el('button', { type: 'button', className: 'btn btn--line', textContent: 'Отмена', dataset: { action: 'edit-cancel' } }),
        el('button', { type: 'submit', className: 'btn btn--dark' }, ['Сохранить ', el('span', { className: 'star', textContent: '✱', 'aria-hidden': 'true' })]),
      ]),
    ]),
    el('p', { className: 'item__form-hint', textContent: 'Enter — сохранить · Esc — отменить' }),
  ]);
  return el('li', { className: 'item is-editing', dataset: { id: task.id } }, [
    el('span', { className: 'item__num', textContent: `ред. ${String(index + 1).padStart(2, '0')}`, 'aria-hidden': 'true' }),
    form,
  ]);
}

function renderTask(task, index) {
  if (editing?.id === task.id) return renderEditor(task, index);
  const overdue = task.dueDate && !task.done && task.dueDate < today();

  const prio = el('select', { className: 'prio', title: 'Приоритет', dataset: { p: task.priority, action: 'priority' } },
    PRIORITIES.map(p => el('option', { value: p, textContent: PRIORITY_LABELS[p], selected: p === task.priority })));

  const meta = [prio];
  if (task.prioritySource === 'manual') {
    meta.push(el('button', {
      type: 'button', className: 'badge badge--lock', textContent: '✱ закреплено',
      title: 'Закреплено вручную, AI не изменит. Нажмите, чтобы снять закрепление', dataset: { action: 'unlock' },
    }));
  } else if (task.prioritySource === 'ai') {
    meta.push(el('button', {
      type: 'button', className: 'badge badge--ai', textContent: openReasons.has(task.id) ? 'скрыть обоснование' : 'почему так — AI',
      title: task.aiReason || 'Приоритет от AI', dataset: { action: 'reason' },
      'aria-expanded': String(openReasons.has(task.id)),
    }));
  }
  meta.push(el('button', {
    type: 'button', className: 'badge badge--edit', textContent: '✎ изменить',
    title: 'Изменить название, описание и срок', dataset: { action: 'edit' },
  }));
  if (task.dueDate) {
    meta.push(el('span', {
      className: 'item__due' + (overdue ? ' is-overdue' : ''),
      textContent: (overdue ? 'просрочено: ' : 'срок: ') + formatDue(task.dueDate),
    }));
  }

  const body = el('div', { className: 'item__body' }, [
    el('div', { className: 'item__title', textContent: task.title, title: 'Дважды щёлкните, чтобы изменить' }),
    ...(task.description ? [el('p', { className: 'item__desc', textContent: task.description })] : []),
    el('div', { className: 'item__meta' }, meta),
  ]);

  const children = [
    el('span', { className: 'item__num', textContent: `зад. ${String(index + 1).padStart(2, '0')}`, 'aria-hidden': 'true' }),
    el('input', { type: 'checkbox', className: 'item__check', checked: task.done, dataset: { action: 'toggle' }, 'aria-label': 'Выполнено' }),
    body,
    el('button', { type: 'button', className: 'item__del', textContent: '×', dataset: { action: 'delete' }, 'aria-label': 'Удалить' }),
  ];
  if (task.prioritySource === 'ai' && task.aiReason) {
    children.push(el('p', { className: 'item__reason', textContent: task.aiReason, hidden: !openReasons.has(task.id) }));
  }

  return el('li', { className: 'item' + (task.done ? ' is-done' : ''), dataset: { id: task.id } }, children);
}

// Сводка на первом экране: числа двузначные, как подписи «зад. 01».
function renderStats() {
  const t = today();
  const active = tasks.filter(x => !x.done);
  const done = tasks.length - active.length;
  const overdue = active.filter(x => x.dueDate && x.dueDate < t).length;
  const due = active.filter(x => x.dueDate === t).length;
  const pad = n => String(n).padStart(2, '0');
  $('stat-active').textContent = pad(active.length);
  $('stat-overdue').textContent = pad(overdue);
  $('stat-overdue').closest('.stat').classList.toggle('is-active', overdue > 0);
  $('stat-today').textContent = pad(due);
  $('stat-done').textContent = pad(done);
  const percent = tasks.length ? Math.round(done / tasks.length * 100) : 0;
  $('progress-bar').style.width = percent + '%';
  counter.textContent = tasks.length ? `готово ${percent}% · ${done} из ${tasks.length}` : 'задач пока нет';
}

function aiCandidates() {
  return tasks.filter(t => !t.done && t.prioritySource !== 'manual');
}

function renderAi() {
  aiStatus.dataset.state = !ai.checked ? 'loading' : ai.enabled ? 'on' : 'off';
  aiStatus.textContent = !ai.checked ? 'AI: проверка…' : ai.enabled ? 'AI: включён' : 'AI: выключен';
  aiStatus.title = ai.enabled ? `Провайдер: ${ai.provider}${ai.model ? `, модель: ${ai.model}` : ''}` : (ai.reason || '');

  const candidates = aiCandidates().length;
  const needsLogin = ai.enabled && ai.requiresAuth && !Cloud.user;
  aiBtn.disabled = !ai.enabled || needsLogin || aiBusy || candidates === 0;
  aiBtn.classList.toggle('is-loading', aiBusy);
  aiBtn.title = !ai.enabled ? 'Добавьте API-ключ, чтобы включить AI' : needsLogin ? 'Войдите в аккаунт, чтобы использовать AI' : '';

  if (!ai.checked) aiHint.textContent = '';
  else if (!ai.enabled) aiHint.textContent = ai.offline
    ? 'Сервер недоступен: запустите приложение через npm run dev'
    : ai.requiresAuth ? 'AI пока не подключён на сервере' : 'Добавьте API-ключ в .env, чтобы включить AI';
  else if (needsLogin) aiHint.textContent = 'Войдите в аккаунт, чтобы использовать AI';
  else if (aiBusy) aiHint.textContent = 'AI анализирует задачи…';
  else if (!candidates) aiHint.textContent = 'Нет активных задач без ручного приоритета';
  else aiHint.textContent = `AI оценит ${Math.min(candidates, MAX_AI_TASKS)} ${plural(candidates, 'задачу', 'задачи', 'задач')}`;
}

function render() {
  const visible = tasks
    .filter(t => filter === 'all' ? true : filter === 'done' ? t.done : !t.done)
    .sort(compare);

  // если перерисовка случилась посреди редактирования, курсор возвращается в то же поле
  const focused = document.activeElement?.closest?.('.is-editing') ? document.activeElement.name : null;
  list.replaceChildren(...visible.map(renderTask));
  if (focused) list.querySelector(`.is-editing [name="${focused}"]`)?.focus();

  const left = tasks.filter(t => !t.done).length;
  counter.textContent = tasks.length ? `Осталось: ${left} ${plural(left, 'задача', 'задачи', 'задач')}` : '';
  renderStats();
  empty.hidden = visible.length > 0;
  empty.textContent = tasks.length ? 'В этом фильтре пусто' : 'Задач пока нет';
  clearDone.hidden = !tasks.some(t => t.done);
  renderAi();
}

// ---------- уведомления ----------

function showToast(text, { undo = false, error = false } = {}) {
  clearTimeout(toastTimer);
  toastText.textContent = text;
  toastUndo.hidden = !undo;
  toast.classList.toggle('is-error', error);
  toast.hidden = false;
  toastTimer = setTimeout(hideToast, undo ? UNDO_MS : 5000);
}

function hideToast() {
  toast.hidden = true;
  undoSnapshot = null;
}

// ---------- AI ----------

async function checkAi() {
  try {
    const res = await fetch('/api/ai/status');
    if (!res.ok) throw new Error();
    ai = { ...(await res.json()), checked: true };
  } catch {
    ai = { enabled: false, checked: true, offline: true, reason: 'Сервер недоступен' };
  }
  renderAi();
}

async function prioritize() {
  const candidates = aiCandidates().slice(0, MAX_AI_TASKS);
  if (!candidates.length || aiBusy) return;

  aiBusy = true;
  renderAi();
  try {
    const res = await fetch('/api/ai/prioritize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Today': today(), 'X-TD': '1' },
      body: JSON.stringify({
        tasks: candidates.map(({ id, title, description, dueDate }) => ({ id, title, description, dueDate })),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || 'Ошибка AI-провайдера');

    const byId = new Map(data.results.map(r => [r.id, r]));
    const snapshot = new Map(tasks.map(({ id, priority, aiScore, aiReason, prioritySource }) =>
      [id, { priority, aiScore, aiReason, prioritySource }]));
    const now = new Date().toISOString();
    // Ручные приоритеты не трогаем, даже если пользователь закрепил задачу во время запроса.
    const next = tasks.map(t => {
      const r = byId.get(t.id);
      if (!r || t.prioritySource === 'manual' || t.done) return t;
      return { ...t, priority: r.priority, aiScore: r.score, aiReason: r.reason, prioritySource: 'ai', updatedAt: now };
    });
    const updated = next.filter((t, i) => t !== tasks[i]).length;

    sort = 'priority';
    sortSelect.value = 'priority';
    commit(next);
    undoSnapshot = snapshot;
    showToast(`Обновлено ${updated} ${plural(updated, 'задача', 'задачи', 'задач')}`, { undo: true });
  } catch (err) {
    showToast(err.message === 'Failed to fetch' ? 'Сервер недоступен' : err.message, { error: true });
  } finally {
    aiBusy = false;
    renderAi();
  }
}

// ---------- события ----------

form.addEventListener('submit', e => {
  e.preventDefault();
  const title = titleInput.value.trim();
  if (!title) return;
  const now = new Date().toISOString();
  const task = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title,
    done: false,
    priority: 'medium',
    prioritySource: 'default',
    createdAt: now,
    updatedAt: now,
  };
  const description = descInput.value.trim();
  if (description) task.description = description;
  if (dueInput.value) task.dueDate = dueInput.value;
  commit([...tasks, task]);
  form.reset();
  titleInput.focus();
});

list.addEventListener('change', e => {
  const id = e.target.closest('.item')?.dataset.id;
  if (!id) return;
  if (e.target.dataset.action === 'toggle') patch(id, { done: e.target.checked });
  if (e.target.dataset.action === 'priority') patch(id, { priority: e.target.value, prioritySource: 'manual' });
});

list.addEventListener('click', e => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  const id = e.target.closest('.item')?.dataset.id;
  if (!id) return;
  if (action === 'delete') {
    openReasons.delete(id);
    commit(tasks.filter(t => t.id !== id));
  }
  if (action === 'unlock') patch(id, { prioritySource: 'default' });
  if (action === 'edit') startEditing(id);
  if (action === 'edit-cancel') stopEditing();
  if (action === 'reason') {
    openReasons.has(id) ? openReasons.delete(id) : openReasons.add(id);
    render();
  }
});

function startEditing(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  editing = { id, title: task.title, description: task.description || '', dueDate: task.dueDate || '' };
  render();
  const input = list.querySelector('.is-editing .item__edit');
  input?.focus();
  input?.select();
}

function stopEditing() {
  const id = editing?.id;
  editing = null;
  render();
  list.querySelector(`.item[data-id="${id}"] .badge--edit`)?.focus();
}

function saveEditing() {
  const title = editing.title.trim();
  if (!title) {
    list.querySelector('.is-editing .item__edit')?.focus();
    showToast('Название не может быть пустым', { error: true });
    return;
  }
  const { id } = editing;
  const description = editing.description.trim();
  const dueDate = editing.dueDate;
  editing = null;
  // пустые поля удаляются из задачи: undefined не попадает в JSON
  patch(id, { title, description: description || undefined, dueDate: dueDate || undefined });
  showToast('Задача изменена');
}

list.addEventListener('dblclick', e => {
  const titleEl = e.target.closest('.item__title');
  if (titleEl) startEditing(titleEl.closest('.item').dataset.id);
});

list.addEventListener('input', e => {
  if (!editing || !e.target.closest('.is-editing')) return;
  const { name, value } = e.target;
  if (name in editing) editing[name] = value;
});

list.addEventListener('submit', e => {
  if (!e.target.matches('.item__form')) return;
  e.preventDefault();
  saveEditing();
});

list.addEventListener('keydown', e => {
  if (!editing || !e.target.closest('.is-editing')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    stopEditing();
  } else if (e.key === 'Enter' && e.target.matches('textarea') && !e.shiftKey) {
    // в описании Enter тоже сохраняет, Shift+Enter — новая строка
    e.preventDefault();
    saveEditing();
  }
});

filters.addEventListener('click', e => {
  const btn = e.target.closest('button[data-filter]');
  if (!btn) return;
  filter = btn.dataset.filter;
  filters.querySelectorAll('button').forEach(b => b.classList.toggle('is-active', b === btn));
  render();
});

sortSelect.addEventListener('change', () => {
  sort = sortSelect.value;
  render();
});

clearDone.addEventListener('click', () => commit(tasks.filter(t => !t.done)));

aiBtn.addEventListener('click', prioritize);

toastUndo.addEventListener('click', () => {
  // Возвращаем только поля приоритета: задачи, добавленные или изменённые после AI, сохраняются.
  if (undoSnapshot) {
    commit(tasks.map(t => {
      const prev = undoSnapshot.get(t.id);
      return prev && t.prioritySource === 'ai' ? { ...t, ...prev } : t;
    }));
  }
  hideToast();
  showToast('Приоритеты восстановлены');
});

// ---------- аккаунт ----------

const accountBtn = $('account-btn');
const accountLabel = $('account-label');
const syncDot = $('sync');
const dialog = $('account-dialog');
const authForm = $('auth-form');
const authError = $('auth-error');
const authSubmit = $('auth-submit');
const SYNC_TEXT = {
  off: '',
  synced: 'Задачи синхронизированы',
  saving: 'Сохраняем изменения…',
  offline: 'Нет связи — изменения отправятся позже',
  error: 'Не удалось сохранить, повторим через 30 секунд',
};
let authMode = 'login';

function renderAccount() {
  accountBtn.hidden = !Cloud.available;
  const user = Cloud.user;
  accountLabel.textContent = user ? (user.name || user.email) : 'Войти';
  syncDot.dataset.state = user ? Cloud.status : 'off';
  accountBtn.title = user ? `${user.email}${SYNC_TEXT[Cloud.status] ? ' · ' + SYNC_TEXT[Cloud.status] : ''}` : 'Войти или зарегистрироваться';
  $('guest-view').hidden = !!user;
  $('user-view').hidden = !user;
  if (user) {
    $('user-email').textContent = user.email;
    $('sync-text').textContent = SYNC_TEXT[Cloud.status] || '';
  }
  renderAi();
}

function setAuthMode(mode) {
  authMode = mode;
  dialog.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('is-active', b.dataset.mode === mode));
  $('name-field').hidden = mode !== 'register';
  $('password-hint').hidden = mode !== 'register';
  authForm.password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  authSubmit.textContent = mode === 'register' ? 'Зарегистрироваться' : 'Войти';
  authError.textContent = '';
}

// Выполняет действие формы: блокирует кнопку и показывает ошибку под формой.
async function runForm(formEl, action) {
  const btn = formEl.querySelector('button[type="submit"]');
  const errorEl = formEl.querySelector('.form-error');
  errorEl.textContent = '';
  btn.classList.add('is-loading');
  try {
    await action();
    formEl.reset();
    return true;
  } catch (err) {
    errorEl.textContent = err.message || 'Что-то пошло не так';
    return false;
  } finally {
    btn.classList.remove('is-loading');
  }
}

accountBtn.addEventListener('click', () => {
  setAuthMode(authMode);
  dialog.showModal();
});
$('dialog-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
dialog.querySelector('.tabs').addEventListener('click', e => {
  const btn = e.target.closest('button[data-mode]');
  if (btn) setAuthMode(btn.dataset.mode);
});

authForm.addEventListener('submit', async e => {
  e.preventDefault();
  const email = authForm.email.value.trim();
  const password = authForm.password.value;
  if (!email || !password) {
    authError.textContent = 'Введите email и пароль';
    return;
  }
  if (authMode === 'register' && password.length < 10) {
    authError.textContent = 'Пароль должен быть не короче 10 символов';
    return;
  }
  const ok = await runForm(authForm, async () => {
    const user = authMode === 'register'
      ? await Cloud.register(email, password, authForm.elements.namedItem('name').value.trim())
      : await Cloud.login(email, password);
    showToast(authMode === 'register' ? `Аккаунт создан: ${user.email}` : `Вы вошли как ${user.email}`);
  });
  if (ok) {
    renderAccount();
    dialog.close();
  }
});

$('password-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.currentTarget;
  if (await runForm(f, () => Cloud.changePassword(f.current.value, f.next.value))) {
    f.closest('details').open = false;
    showToast('Пароль изменён');
  }
});

$('delete-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.currentTarget;
  if (!confirm('Удалить аккаунт и все задачи на сервере? Это нельзя отменить.')) return;
  if (await runForm(f, () => Cloud.deleteAccount(f.password.value))) {
    dialog.close();
    showToast('Аккаунт удалён');
  }
});

$('logout-btn').addEventListener('click', async () => {
  await Cloud.logout();
  dialog.close();
  showToast('Вы вышли из аккаунта');
});

window.addEventListener('beforeunload', () => { Cloud.flush(); });

// ---------- тема: авто → светлая → тёмная ----------

const THEME_KEY = 'todo-list-ai.theme';
const THEMES = {
  auto: { icon: '◐', label: 'авто', title: 'Тема как в системе' },
  light: { icon: '☀', label: 'светлая', title: 'Светлая тема' },
  dark: { icon: '☾', label: 'тёмная', title: 'Тёмная тема' },
};
const NEXT_THEME = { auto: 'light', light: 'dark', dark: 'auto' };
const themeBtn = $('theme-btn');
const systemDark = matchMedia('(prefers-color-scheme: dark)');
let themeMode = document.documentElement.dataset.themeMode || 'light';

function applyTheme() {
  const dark = themeMode === 'dark' || (themeMode === 'auto' && systemDark.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.themeMode = themeMode;
  const t = THEMES[themeMode];
  themeBtn.querySelector('.theme-btn__icon').textContent = t.icon;
  themeBtn.querySelector('.theme-btn__label').textContent = t.label;
  themeBtn.title = `${t.title}. Нажмите, чтобы сменить`;
  themeBtn.setAttribute('aria-label', `Тема: ${t.label}. Сменить`);
}

themeBtn.addEventListener('click', () => {
  themeMode = NEXT_THEME[themeMode] || 'auto';
  try { localStorage.setItem(THEME_KEY, themeMode); } catch {}
  applyTheme();
});
systemDark.addEventListener('change', () => { if (themeMode === 'auto') applyTheme(); });
applyTheme();

// ---------- часы и координаты курсора, как в референсе ----------

const clock = $('clock');
const coords = $('coords');

function tickClock() {
  const now = new Date();
  const date = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  clock.textContent = `${date}_${now.toLocaleTimeString('ru-RU')}`;
  $('hero-date').textContent = now.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
tickClock();
setInterval(tickClock, 1000);

window.addEventListener('pointermove', e => {
  const pad = n => String(Math.round(n)).padStart(4, '0');
  coords.textContent = `${pad(e.clientX)} X ${pad(e.clientY)} Y`;
}, { passive: true });

render();
checkAi();
Cloud.init();
