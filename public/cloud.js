/* Аккаунт и синхронизация задач с сервером (Vercel + Neon).
   Задачи по-прежнему живут в браузере; если пользователь вошёл, копия хранится на сервере
   и подтягивается на других устройствах. Если сервера нет — работает только режим без аккаунта.
   app.js предоставляет: snapshot(), applyData(data), hasLocalTasks(), wipeLocal(), renderAccount(), showToast(). */

const CLOUD_META = 'todo-list-ai.cloud';
const DELETED_TTL = 30 * 24 * 60 * 60 * 1000;

const Cloud = {
  available: false,   // есть ли серверная часть с аккаунтами
  user: null,         // { id, email, name }
  status: 'off',      // off | synced | saving | offline | error
  meta: { version: 0, dirty: false, syncedAt: null },
  _timer: null, _retry: null, _pushing: false, _quiet: false, _rev: 0, _again: false,

  /* ---------- запросы ---------- */
  async api(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch('/api/' + path, {
        method, credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-td': '1' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw Object.assign(new Error('Нет связи с сервером'), { code: 'OFFLINE' });
    }
    let data = null;
    if ((res.headers.get('content-type') || '').includes('json')) { try { data = await res.json(); } catch {} }
    if (!res.ok) {
      const code = data?.code || 'HTTP_' + res.status;
      throw Object.assign(new Error(data?.detail || 'Ошибка сервера'), { code, status: res.status, data });
    }
    return data;
  },

  loadMeta() { try { Object.assign(this.meta, JSON.parse(localStorage.getItem(CLOUD_META) || '{}')); } catch {} },
  saveMeta() { try { localStorage.setItem(CLOUD_META, JSON.stringify(this.meta)); } catch {} },
  resetMeta() { this.meta = { version: 0, dirty: false, syncedAt: null }; try { localStorage.removeItem(CLOUD_META); } catch {} },

  setStatus(s) {
    this.status = s;
    renderAccount();
  },

  /* ---------- запуск ---------- */
  async init() {
    this.loadMeta();
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin', headers: { 'x-td': '1' } });
      const json = (res.headers.get('content-type') || '').includes('json');
      this.available = json && (res.ok || res.status === 401);
      if (res.ok) { this.user = (await res.json()).user; await this.pull(); }
      else if (this.available && this.meta.email) this.resetMeta(); // сессия истекла
    } catch {
      this.available = false;
      if (this.meta.email) { this.available = true; this.user = { email: this.meta.email, name: this.meta.name || '' }; this.status = 'offline'; }
    }
    renderAccount();
    window.addEventListener('online', () => this.user && this.flush());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.user && !this.meta.dirty) this.pull();
    });
  },

  /* ---------- данные ---------- */
  apply(data) {
    this._quiet = true;
    applyData(data);
    this._quiet = false;
  },

  // Объединение при правках на двух устройствах: по каждой задаче побеждает более свежая правка,
  // удаление побеждает, если сделано позже последней правки задачи.
  merge(server, local) {
    const deleted = { ...(server?.deleted || {}) };
    for (const [id, at] of Object.entries(local.deleted || {})) {
      if (!deleted[id] || deleted[id] < at) deleted[id] = at;
    }
    const byId = new Map();
    for (const t of [...(server?.tasks || []), ...(local.tasks || [])]) {
      const prev = byId.get(t.id);
      if (!prev || (t.updatedAt || '') > (prev.updatedAt || '')) byId.set(t.id, t);
    }
    const tasks = [...byId.values()].filter(t => !deleted[t.id] || deleted[t.id] < (t.updatedAt || ''));
    const cutoff = new Date(Date.now() - DELETED_TTL).toISOString();
    for (const [id, at] of Object.entries(deleted)) if (at < cutoff) delete deleted[id];
    return { tasks, deleted };
  },

  async pull() {
    if (!this.user) return;
    try {
      const r = await this.api('data');
      if (!r.data) {
        // на сервере пусто — отправляем то, что есть локально
        this.meta.version = 0; this.meta.dirty = true; this.saveMeta();
        await this.push();
        return;
      }
      if (this.meta.dirty) {
        // есть неотправленные правки: при расхождении объединяем и отправляем
        if (r.version !== this.meta.version) this.apply(this.merge(r.data, snapshot()));
        this.meta.version = r.version;
        await this.push();
      } else if (r.version !== this.meta.version) {
        this.apply(r.data);
        this.meta.version = r.version;
      }
      this.meta.syncedAt = Date.now(); this.saveMeta();
      if (!this.meta.dirty) this.setStatus('synced');
    } catch (e) { this.handleError(e); }
  },

  // вызывается из app.js после каждого изменения: отложенная отправка на сервер
  schedule() {
    if (!this.user || this._quiet) return;
    this._rev++;
    this.meta.dirty = true; this.saveMeta();
    this.setStatus('saving');
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.push(), 1000);
  },
  async flush() { clearTimeout(this._timer); if (this.meta.dirty) await this.push(); },

  async push(retry = true) {
    if (!this.user) return;
    // отправка уже идёт — повторим сразу после неё, чтобы не потерять свежие правки
    if (this._pushing) { this._again = true; return; }
    this._pushing = true;
    const rev = this._rev;
    let conflict = null;
    try {
      const r = await this.api('data', { method: 'PUT', body: { data: snapshot(), version: this.meta.version } });
      this.meta.version = r.version; this.meta.syncedAt = Date.now();
      this.meta.dirty = this._rev !== rev; // пока шла отправка, могли появиться новые правки
      this.saveMeta();
      if (!this.meta.dirty) this.setStatus('synced');
    } catch (e) {
      if (e.code === 'CONFLICT' && retry && e.data) conflict = e.data;
      else this.handleError(e);
    } finally { this._pushing = false; }
    if (conflict) {
      // на сервере правки с другого устройства: объединяем и отправляем ещё раз
      this.apply(this.merge(conflict.data, snapshot()));
      this.meta.version = conflict.version; this._rev++; this.meta.dirty = true;
      return this.push(false);
    }
    if (this._again || (this.meta.dirty && this.status !== 'offline' && this.status !== 'error')) {
      this._again = false;
      return this.push();
    }
  },

  handleError(e) {
    if (e.code === 'UNAUTHORIZED') {
      this.user = null; this.resetMeta(); this.setStatus('off');
      showToast('Сессия истекла, войдите снова', { error: true });
      return;
    }
    this.setStatus(e.code === 'OFFLINE' ? 'offline' : 'error');
    clearTimeout(this._retry);
    this._retry = setTimeout(() => this.user && this.meta.dirty && this.push(), 30000);
  },

  /* ---------- аккаунт ---------- */
  remember(user) {
    this.user = user;
    this.meta.email = user.email; this.meta.name = user.name || '';
    this.saveMeta();
  },
  async register(email, password, name) {
    const r = await this.api('auth/register', { method: 'POST', body: { email, password, name } });
    this.resetMeta(); this.remember(r.user);
    this.meta.dirty = true; this.saveMeta();
    await this.push();
    return r.user;
  },
  async login(email, password) {
    const r = await this.api('auth/login', { method: 'POST', body: { email, password } });
    const hadLocal = hasLocalTasks();
    this.resetMeta(); this.remember(r.user);
    const d = await this.api('data');
    if (d.data) {
      this.apply(hadLocal ? this.merge(d.data, snapshot()) : d.data);
      this.meta.version = d.version;
      if (hadLocal) { this.meta.dirty = true; await this.push(); }
    } else if (hadLocal) { this.meta.dirty = true; await this.push(); }
    this.meta.syncedAt = Date.now(); this.saveMeta();
    this.setStatus('synced');
    return r.user;
  },
  async logout() {
    try { await this.flush(); } catch {}
    try { await this.api('auth/logout', { method: 'POST' }); } catch {}
    this.user = null; this.resetMeta(); this.setStatus('off');
    wipeLocal(); // на общем устройстве задачи не должны оставаться после выхода
  },
  async changePassword(current, next) {
    await this.api('auth/password', { method: 'POST', body: { current, next } });
  },
  async deleteAccount(password) {
    await this.api('account', { method: 'DELETE', body: { password } });
    this.user = null; this.resetMeta(); this.setStatus('off');
    wipeLocal();
  },
};
