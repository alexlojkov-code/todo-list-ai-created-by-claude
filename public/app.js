const STORAGE_KEY = 'todo-list-ai';
const DELETED_KEY = 'todo-list-ai.deleted';
const PRIORITIES = ['critical', 'high', 'medium', 'low'];
const PRIORITY_LABELS = { critical: 'Срочно', high: 'Высокий', medium: 'Обычный', low: 'Низкий' };
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
let doneOpen = false; // раскрыта ли группа «Готово»
let undoAction = null; // отмена последнего удаления (уведомление «Отменить»)

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

// Иконка из спрайта icons.svg
function icon(name, className = 'icon') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `icons.svg#${name}`);
  svg.append(use);
  return svg;
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

const DAY_MS = 86400000;
const WEEKDAY_DATE = { weekday: 'long', day: 'numeric', month: 'long' };

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Отметка приоритета формой, а не только цветом: низкий — полый кружок, обычный — без отметки,
// высокий — залитая точка, срочно — точка «Кирпич» и слово «срочно».
function priorityMark(task) {
  if (task.priority === 'medium') return null;
  const mark = el('span', { className: 'prio-mark', dataset: { p: task.priority }, title: `Приоритет: ${PRIORITY_LABELS[task.priority].toLowerCase()}` });
  if (task.priority === 'critical') mark.append(el('span', { className: 'prio-mark__text', textContent: 'срочно' }));
  else mark.append(el('span', { className: 'sr-only', textContent: `приоритет ${PRIORITY_LABELS[task.priority].toLowerCase()}` }));
  return mark;
}

function renderEditor(task) {
  const priority = el('select', { className: 'select prio', name: 'priority', 'aria-label': 'Приоритет', dataset: { action: 'priority' } },
    ['low', 'medium', 'high', 'critical'].map(p => el('option', { value: p, textContent: PRIORITY_LABELS[p], selected: p === task.priority })));
  const form = el('form', { className: 'item__form', dataset: { action: 'edit-form' } }, [
    el('label', { className: 'field' }, [
      el('span', { className: 'field__label', textContent: 'Название' }),
      el('input', { type: 'text', name: 'title', className: 'input input--title item__edit', value: editing.title, maxLength: 200, required: true, enterKeyHint: 'done' }),
    ]),
    el('label', { className: 'field' }, [
      el('span', { className: 'field__label', textContent: 'Описание' }),
      el('textarea', { name: 'description', className: 'textarea', value: editing.description, maxLength: 2000, rows: 2, placeholder: 'Необязательно' }),
    ]),
    el('div', { className: 'composer__row' }, [
      el('label', { className: 'field' }, [
        el('span', { className: 'field__label', textContent: 'Срок' }),
        el('input', { type: 'date', name: 'dueDate', className: 'input input--date', value: editing.dueDate }),
      ]),
      el('label', { className: 'field field--priority' }, [
        el('span', { className: 'field__label', textContent: 'Приоритет' }),
        priority,
      ]),
    ]),
    el('div', { className: 'item__form-actions' }, [
      el('button', { type: 'button', className: 'btn btn--quiet btn--danger-text', dataset: { action: 'delete' } }, [icon('trash'), 'Удалить']),
      el('span', { className: 'spacer' }),
      el('button', { type: 'button', className: 'btn btn--secondary', textContent: 'Отмена', dataset: { action: 'edit-cancel' } }),
      el('button', { type: 'submit', className: 'btn btn--primary' }, [icon('check'), 'Сохранить']),
    ]),
    el('p', { className: 'item__form-hint', textContent: 'Enter — сохранить · Shift+Enter — новая строка в описании · Esc — отменить' }),
  ]);
  return el('li', { className: 'item is-editing', dataset: { id: task.id } }, [form]);
}

function renderTask(task) {
  if (editing?.id === task.id) return renderEditor(task);
  const overdue = task.dueDate && !task.done && task.dueDate < today();

  const meta = [];
  const mark = priorityMark(task);
  if (mark) meta.push(mark);
  if (task.dueDate) {
    meta.push(el('span', { className: 'item__due' + (overdue ? ' is-overdue' : '') },
      overdue ? [icon('clock'), `просрочено · ${formatDue(task.dueDate)}`] : [formatDue(task.dueDate)]));
  }
  if (task.prioritySource === 'manual') {
    meta.push(el('button', {
      type: 'button', className: 'badge badge--lock',
      title: 'Приоритет закреплён вручную, AI его не изменит. Нажмите, чтобы снять закрепление', dataset: { action: 'unlock' },
    }, [icon('pin'), 'закреплено']));
  } else if (task.prioritySource === 'ai' && task.aiReason) {
    meta.push(el('button', {
      type: 'button', className: 'badge badge--ai', dataset: { action: 'reason' },
      'aria-expanded': String(openReasons.has(task.id)), title: 'Почему такой приоритет',
    }, [icon('sparkle'), openReasons.has(task.id) ? 'скрыть' : 'почему']));
  }

  const body = el('div', { className: 'item__body' }, [
    el('div', { className: 'item__title', textContent: task.title, title: 'Дважды щёлкните, чтобы изменить' }),
    ...(task.description ? [el('p', { className: 'item__desc', textContent: task.description })] : []),
    ...(meta.length ? [el('div', { className: 'item__meta' }, meta)] : []),
    ...(task.prioritySource === 'ai' && task.aiReason && openReasons.has(task.id)
      ? [el('p', { className: 'item__reason' }, [icon('sparkle'), task.aiReason])] : []),
  ]);

  const actions = el('div', { className: 'item__actions' }, [
    el('button', { type: 'button', className: 'icon-btn', dataset: { action: 'edit' }, 'aria-label': `Изменить «${task.title}»`, title: 'Изменить' }, [icon('pencil')]),
    el('button', { type: 'button', className: 'icon-btn icon-btn--danger', dataset: { action: 'delete' }, 'aria-label': `Удалить «${task.title}»`, title: 'Удалить' }, [icon('trash')]),
  ]);

  return el('li', { className: 'item' + (task.done ? ' is-done' : '') + (overdue ? ' is-overdue' : ''), dataset: { id: task.id } }, [
    el('input', { type: 'checkbox', className: 'check item__check', checked: task.done, dataset: { action: 'toggle' }, 'aria-label': `Выполнено: ${task.title}` }),
    body,
    actions,
  ]);
}

// Группы зависят от сортировки: по сроку — по датам, по приоритету — по уровням, по дате создания — без групп.
function groupKey(task) {
  if (sort === 'priority') return task.priority;
  if (sort === 'due') {
    if (!task.dueDate) return 'none';
    const t = today();
    if (task.dueDate < t) return 'overdue';
    if (task.dueDate === t) return 'today';
    if (task.dueDate === addDays(1)) return 'tomorrow';
    return 'later';
  }
  return 'all';
}
const GROUPS = {
  priority: [['critical', 'Срочно'], ['high', 'Высокий'], ['medium', 'Обычный'], ['low', 'Низкий']],
  due: [['overdue', 'Просрочено'], ['today', 'Сегодня'], ['tomorrow', 'Завтра'], ['later', 'Позже'], ['none', 'Без срока']],
  created: [['all', '']],
};

function renderGroup(title, items, extraClass = '') {
  const section = el('section', { className: 'group ' + extraClass });
  if (title) section.append(el('h2', { className: 'group__title' }, [title, el('span', { className: 'count', textContent: ` ${items.length}` })]));
  section.append(el('ul', { className: 'group__list' }, items.map(renderTask)));
  return section;
}

// Строка-сводка под шапкой: дата · сколько дел · процент готовых
function renderStats() {
  const t = today();
  const active = tasks.filter(x => !x.done);
  const done = tasks.length - active.length;
  const overdue = active.filter(x => x.dueDate && x.dueDate < t).length;
  const date = new Date().toLocaleDateString('ru-RU', WEEKDAY_DATE);
  const parts = [date[0].toUpperCase() + date.slice(1)];
  if (tasks.length) {
    parts.push(`${active.length} ${plural(active.length, 'дело', 'дела', 'дел')}`);
    if (overdue) parts.push(`${overdue} ${plural(overdue, 'просрочено', 'просрочено', 'просрочено')}`);
    parts.push(`готово ${Math.round(done / tasks.length * 100)}%`);
  }
  counter.textContent = parts.join(' · ');
  const counts = { all: tasks.length, active: active.length, done };
  filters.querySelectorAll('[data-count]').forEach(c => { c.textContent = counts[c.dataset.count] || ''; });
}

function render() {
  const visible = tasks
    .filter(t => filter === 'all' ? true : filter === 'done' ? t.done : !t.done)
    .sort(compare);
  const active = visible.filter(t => !t.done);
  const done = visible.filter(t => t.done);

  // если перерисовка случилась посреди редактирования, курсор возвращается в то же поле
  const focused = document.activeElement?.closest?.('.is-editing') ? document.activeElement.name : null;

  const sections = [];
  for (const [key, title] of GROUPS[sort] || GROUPS.created) {
    const items = active.filter(t => groupKey(t) === key);
    if (items.length) sections.push(renderGroup(title, items));
  }
  if (done.length) {
    if (filter === 'done') {
      sections.push(renderGroup('', done));
    } else {
      const group = renderGroup('', doneOpen ? done : [], 'group--done');
      const toggle = el('button', { type: 'button', className: 'group__toggle', 'aria-expanded': String(doneOpen), dataset: { action: 'toggle-done' } },
        [icon('chevron-down'), `Готово `, el('span', { className: 'count', textContent: String(done.length) })]);
      group.prepend(toggle);
      sections.push(group);
    }
  }
  list.replaceChildren(...sections);
  if (focused) list.querySelector(`.is-editing [name="${focused}"]`)?.focus();

  // «Очистить готовые» — внутри группы «Готово», когда она раскрыта
  const doneGroup = list.querySelector('.group--done') || (filter === 'done' && done.length ? list.lastElementChild : null);
  clearDone.hidden = !(doneGroup && (doneOpen || filter === 'done'));
  if (!clearDone.hidden) doneGroup.append(clearDone);

  renderStats();
  empty.hidden = visible.length > 0;
  empty.textContent = tasks.length ? 'В этом фильтре пусто' : 'Добавьте первое дело — оно появится здесь';
  renderAi();
}

function aiCandidates() {
  return tasks.filter(t => !t.done && t.prioritySource !== 'manual');
}

function renderAi() {
  const candidates = aiCandidates().length;
  const needsLogin = ai.enabled && ai.requiresAuth && !Cloud.user;
  // пока AI недоступен, на экране о нём ничего нет
  aiBtn.hidden = !ai.enabled;
  aiBtn.disabled = needsLogin || aiBusy || candidates === 0;
  aiBtn.classList.toggle('is-loading', aiBusy);
  aiBtn.title = needsLogin ? 'Войдите в аккаунт, чтобы упорядочить с AI'
    : candidates ? `AI расставит приоритеты: ${Math.min(candidates, MAX_AI_TASKS)} ${plural(candidates, 'задача', 'задачи', 'задач')}`
    : 'Нет активных задач без ручного приоритета';
  // короткая подсказка — только когда она что-то сообщает
  aiHint.textContent = !ai.enabled ? '' : aiBusy ? 'AI расставляет приоритеты…'
    : needsLogin && accountReady ? 'Войдите, чтобы упорядочить задачи с AI' : '';
}

// ---------- уведомления ----------

function showToast(text, { undo = false, error = false } = {}) {
  clearTimeout(toastTimer);
  toastText.textContent = text;
  $('toast-icon').setAttribute('href', `icons.svg#${error ? 'alert' : undo ? 'undo' : 'check'}`);
  toastUndo.hidden = !undo;
  toast.classList.toggle('is-error', error);
  toast.hidden = false;
  toastTimer = setTimeout(hideToast, undo ? UNDO_MS : 5000);
}

function hideToast() {
  toast.hidden = true;
  undoSnapshot = null;
  undoAction = null;
}

// Удаление с отменой. При отмене задача возвращается с новым updatedAt и убирается из deleted,
// иначе при синхронизации удаление окажется «новее» восстановления.
function removeWithUndo(ids, message) {
  const removed = tasks.filter(t => ids.includes(t.id));
  if (!removed.length) return;
  ids.forEach(id => openReasons.delete(id));
  commit(tasks.filter(t => !ids.includes(t.id)));
  showToast(message, { undo: true });
  undoAction = () => {
    const now = new Date().toISOString();
    for (const t of removed) delete deleted[t.id];
    commit([...tasks.filter(t => !ids.includes(t.id)), ...removed.map(t => ({ ...t, updatedAt: now }))]);
    showToast(removed.length > 1 ? 'Задачи восстановлены' : 'Задача восстановлена');
  };
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
  // приоритет, выбранный при добавлении, считается ручным: AI его не перезапишет
  const priority = $('add-priority').value;
  if (priority !== 'medium') Object.assign(task, { priority, prioritySource: 'manual' });
  commit([...tasks, task]);
  form.reset();
  syncChips();
  titleInput.focus();
  showToast('Дело добавлено');
});

// ---------- форма добавления: раскрывается из строки «Добавить дело» ----------

const composerOpen = $('composer-open');
function setComposer(open) {
  form.hidden = !open;
  composerOpen.hidden = open;
  composerOpen.setAttribute('aria-expanded', String(open));
  $('composer').classList.toggle('is-open', open);
  if (open) titleInput.focus();
  else { form.reset(); syncChips(); }
}
composerOpen.addEventListener('click', () => setComposer(true));
$('composer-cancel').addEventListener('click', () => { setComposer(false); composerOpen.focus(); });
form.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); setComposer(false); composerOpen.focus(); }
  else if (e.key === 'Enter' && e.target === descInput && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
});

// быстрые сроки: «Сегодня», «Завтра», «Через неделю»
function syncChips() {
  form.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', String(dueInput.value === addDays(Number(c.dataset.due)))));
}
form.querySelector('.chips').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const value = addDays(Number(chip.dataset.due));
  dueInput.value = dueInput.value === value ? '' : value;
  syncChips();
});
dueInput.addEventListener('input', syncChips);

list.addEventListener('change', e => {
  const id = e.target.closest('.item')?.dataset.id;
  if (!id) return;
  if (e.target.dataset.action === 'toggle') patch(id, { done: e.target.checked });
  if (e.target.dataset.action === 'priority') patch(id, { priority: e.target.value, prioritySource: 'manual' });
});

list.addEventListener('click', e => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'toggle-done') {
    doneOpen = !doneOpen;
    render();
    list.querySelector('[data-action="toggle-done"]')?.focus();
    return;
  }
  const id = e.target.closest('.item')?.dataset.id;
  if (!id) return;
  if (action === 'delete') {
    if (editing?.id === id) editing = null;
    removeWithUndo([id], 'Задача удалена');
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
  list.querySelector(`.item[data-id="${id}"] [data-action="edit"]`)?.focus();
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

clearDone.addEventListener('click', () => {
  const ids = tasks.filter(t => t.done).map(t => t.id);
  removeWithUndo(ids, `Удалено ${ids.length} ${plural(ids.length, 'готовое дело', 'готовых дела', 'готовых дел')}`);
});

aiBtn.addEventListener('click', prioritize);

toastUndo.addEventListener('click', () => {
  if (undoAction) {
    const action = undoAction;
    hideToast();
    action();
    return;
  }
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
let accountReady = false; // пока аккаунт загружается, не просим войти

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

// ---------- меню действий: открытие, клавиатура, закрытие по клику мимо ----------

function setupMenu(button, menu, onSelect) {
  const items = () => [...menu.querySelectorAll('[role^="menuitem"]')];
  const outside = e => { if (!menu.contains(e.target) && !button.contains(e.target)) close(false); };
  function open() {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    (items().find(i => i.getAttribute('aria-checked') === 'true') || items()[0])?.focus();
    document.addEventListener('pointerdown', outside, true);
  }
  function close(returnFocus = true) {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (returnFocus) button.focus();
  }
  button.addEventListener('click', () => (menu.hidden ? open() : close()));
  button.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
  });
  menu.addEventListener('keydown', e => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    const move = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (move !== undefined) {
      e.preventDefault();
      list[(move + list.length) % list.length].focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      close(false);
    }
  });
  menu.addEventListener('click', e => {
    const item = e.target.closest('[role^="menuitem"]');
    if (!item) return;
    onSelect(item);
    setTimeout(() => close(), 80);
  });
  return { open, close };
}

// ---------- тема: светлая / тёмная / как в системе (меню «Вид») ----------

const THEME_KEY = 'todo-list-ai.theme';
const THEME_ICONS = { light: 'sun', dark: 'moon', auto: 'contrast' };
const THEME_TITLES = { light: 'светлая', dark: 'тёмная', auto: 'как в системе' };
const viewBtn = $('view-btn');
const viewMenu = $('view-menu');
const systemDark = matchMedia('(prefers-color-scheme: dark)');
let themeMode = document.documentElement.dataset.themeMode || 'light';

function applyTheme() {
  const dark = themeMode === 'dark' || (themeMode === 'auto' && systemDark.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.themeMode = themeMode;
  $('view-icon').setAttribute('href', `icons.svg#${THEME_ICONS[themeMode]}`);
  viewBtn.title = `Вид: тема — ${THEME_TITLES[themeMode]}`;
  viewMenu.querySelectorAll('[data-theme-mode]').forEach(i => i.setAttribute('aria-checked', String(i.dataset.themeMode === themeMode)));
}

setupMenu(viewBtn, viewMenu, item => {
  if (!item.dataset.themeMode) return;
  themeMode = item.dataset.themeMode;
  try { localStorage.setItem(THEME_KEY, themeMode); } catch {}
  applyTheme();
});
systemDark.addEventListener('change', () => { if (themeMode === 'auto') applyTheme(); });
applyTheme();

// линия под шапкой появляется, когда страница прокручена
const topbar = document.querySelector('.topbar');
const onScroll = () => topbar.classList.toggle('is-scrolled', window.scrollY > 4);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

render();
checkAi();
Cloud.init().finally(() => { accountReady = true; renderAi(); });
