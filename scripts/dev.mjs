/* Локальный сервер разработки: раздаёт public/ и вызывает функции из api/ так же, как Vercel.
   Настройки берёт из .env (переменные окружения важнее). Запуск: npm run dev → http://localhost:3000 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
try { process.loadEnvFile(join(root, '.env')); } catch {}

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = join(root, 'public');
const API = join(root, 'api');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      const file = join(root, normalize(url.pathname).replace(/\/$/, '') + '.js');
      if (!file.startsWith(API + sep) || file.includes(`${sep}_lib${sep}`) || !(await stat(file).catch(() => null))) {
        res.statusCode = 404; return res.end('not found');
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      req.body = raw ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : undefined;
      req.query = Object.fromEntries(url.searchParams);
      const mod = await import(pathToFileURL(file).href);
      return await mod.default(req, res);
    }
    let path = normalize(decodeURIComponent(url.pathname));
    if (path.endsWith(sep)) path += 'index.html';
    const file = join(PUBLIC, path);
    if (!file.startsWith(PUBLIC + sep)) { res.statusCode = 404; return res.end('not found'); }
    const data = await readFile(file);
    res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') { res.statusCode = 404; return res.end('not found'); }
    console.error(e);
    res.statusCode = 500; res.end('error');
  }
}).listen(PORT, '127.0.0.1', async () => {
  const { getProvider } = await import('../api/_lib/ai/provider.js');
  const provider = await getProvider();
  console.log(`Сервер: http://localhost:${PORT}`);
  console.log(process.env.DATABASE_URL ? 'Аккаунты: включены (Neon)' : 'Аккаунты: выключены (нет DATABASE_URL)');
  console.log(provider.enabled ? `AI: включён (${provider.name}, модель ${provider.model})` : `AI: выключен (${provider.reason})`);
});
