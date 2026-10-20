require('dotenv').config();
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const express = require('express'), cors = require('cors'), jwt = require('jsonwebtoken');
const { PORT = 3000, FRONTEND_URL, API_URL, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET,
  JWT_SECRET, BOT_API_KEY, DATA_DIR = path.join(__dirname, '..', 'secure-data') } = process.env;
if (!JWT_SECRET || !BOT_API_KEY) throw new Error('Falta JWT_SECRET o BOT_API_KEY en .env');

/* ---------- Almacenamiento seguro (un JSON por servidor) ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const cache = new Map();
const validId = id => /^\d{5,25}$/.test(id);
const file = gid => path.join(DATA_DIR, `${gid}.json`);
const DEFAULTS = {
  currency: 'fichas', startBalance: 1000, dailyAmount: 500, dailyCooldownH: 24,
  minBet: 10, maxBet: 5000,
  games: {
    coinflip: { enabled: true, payout: 1.95 },
    dice:     { enabled: true, houseEdge: 0.04 },
    slots:    { enabled: true, payouts: { three: 10, two: 1.5 } },
  },
};
function load(gid) {
  if (cache.has(gid)) return cache.get(gid);
  let g;
  try { g = JSON.parse(fs.readFileSync(file(gid), 'utf8')); }
  catch { g = { config: structuredClone(DEFAULTS), users: {} }; }
  cache.set(gid, g); return g;
}
function save(gid) { // escritura atómica
  const tmp = file(gid) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache.get(gid)), { mode: 0o600 });
  fs.renameSync(tmp, file(gid));
}
const user = (g, uid) => g.users[uid] ||= { balance: g.config.startBalance, lastDaily: 0, wins: 0, losses: 0, name: '' };
const num = (v, min, max, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
const rnd = () => crypto.randomInt(0, 1e9) / 1e9;

/* ---------- App ---------- */
const app = express();
app.use(express.json({ limit: '20kb' }));
app.use(cors({ origin: FRONTEND_URL ? new URL(FRONTEND_URL).origin : false }));

/* ---------- Discord OAuth2 ---------- */
app.get('/auth/login', (req, res) => {
  const q = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, redirect_uri: `${API_URL}/auth/callback`,
    response_type: 'code', scope: 'identify guilds' });
  res.redirect(`https://discord.com/oauth2/authorize?${q}`);
});
app.get('/auth/callback', async (req, res) => {
  try {
    const t = await (await fetch('https://discord.com/api/oauth2/token', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code', code: req.query.code, redirect_uri: `${API_URL}/auth/callback` }) })).json();
    const h = { Authorization: `Bearer ${t.access_token}` };
    const me = await (await fetch('https://discord.com/api/users/@me', { headers: h })).json();
    const gs = await (await fetch('https://discord.com/api/users/@me/guilds', { headers: h })).json();
    const guilds = gs.map(x => ({ id: x.id, name: x.name,
      admin: x.owner || (BigInt(x.permissions) & 0x28n) !== 0n })); // ADMINISTRATOR | MANAGE_GUILD
    const token = jwt.sign({ id: me.id, name: me.global_name || me.username, guilds }, JWT_SECRET, { expiresIn: '7d' });
    res.redirect(`${FRONTEND_URL}/#token=${token}`);
  } catch { res.status(500).send('Error de autenticación'); }
});

/* ---------- Middlewares ---------- */
function auth(req, res, next) {
  try { req.u = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Sesión inválida' }); }
}
function member(req, res, next) {
  const gid = req.params.gid;
  if (!validId(gid)) return res.status(400).json({ error: 'Servidor inválido' });
  const gm = req.u.guilds.find(x => x.id === gid);
  if (!gm) return res.status(403).json({ error: 'No perteneces a este servidor' });
  req.gm = gm; next();
}
const admin = (req, res, next) => req.gm.admin ? next() : res.status(403).json({ error: 'Solo administradores' });
const botOnly = (req, res, next) => {
  const k = Buffer.from(req.headers['x-api-key'] || ''), b = Buffer.from(BOT_API_KEY);
  (k.length === b.length && crypto.timingSafeEqual(k, b)) ? next() : res.status(401).json({ error: 'API key inválida' });
};

/* ---------- API de jugadores ---------- */
const G = '/api/guilds/:gid';
app.get(`${G}/me`, auth, member, (req, res) => {
  const g = load(req.params.gid), u = user(g, req.u.id); u.name = req.u.name; save(req.params.gid);
  const c = g.config;
  res.json({ user: { id: req.u.id, name: u.name, balance: u.balance, wins: u.wins, losses: u.losses },
    guild: req.gm.name, isAdmin: req.gm.admin,
    config: { currency: c.currency, minBet: c.minBet, maxBet: c.maxBet, dailyAmount: c.dailyAmount,
      games: Object.fromEntries(Object.entries(c.games).map(([k, v]) => [k, v.enabled])) },
    nextDaily: u.lastDaily + c.dailyCooldownH * 36e5 });
});
app.post(`${G}/daily`, auth, member, (req, res) => {
  const g = load(req.params.gid), u = user(g, req.u.id), c = g.config, now = Date.now();
  const next = u.lastDaily + c.dailyCooldownH * 36e5;
  if (now < next) return res.status(429).json({ error: 'Aún no puedes reclamar', nextDaily: next });
  u.balance += c.dailyAmount; u.lastDaily = now; save(req.params.gid);
  res.json({ balance: u.balance, nextDaily: now + c.dailyCooldownH * 36e5 });
});
const SYM = ['🍒', '🍋', '🔔', '⭐', '7️⃣'];
const games = {
  coinflip(c, b, p) { const pick = p.pick === 'cruz' ? 'cruz' : 'cara', r = rnd() < .5 ? 'cara' : 'cruz';
    return { result: r, win: r === pick ? b * c.payout : 0 }; },
  dice(c, b, p) { const target = Math.round(num(p.target, 5, 95, 50)), over = !!p.over;
    const chance = (over ? 100 - target : target - 1) / 100;
    const roll = Math.floor(rnd() * 100) + 1, win = over ? roll > target : roll < target;
    return { result: roll, win: win ? b * ((1 - c.houseEdge) / chance) : 0 }; },
  slots(c, b) { const r = [0, 1, 2].map(() => SYM[Math.floor(rnd() * SYM.length)]);
    const uniq = new Set(r).size; const m = uniq === 1 ? c.payouts.three : uniq === 2 ? c.payouts.two : 0;
    return { result: r, win: b * m }; },
};
app.post(`${G}/play`, auth, member, (req, res) => {
  const gid = req.params.gid, g = load(gid), c = g.config, u = user(g, req.u.id);
  const name = req.body.game, bet = Math.floor(Number(req.body.bet));
  if (!games[name] || !c.games[name]?.enabled) return res.status(400).json({ error: 'Juego no disponible' });
  if (!(bet >= c.minBet && bet <= c.maxBet)) return res.status(400).json({ error: `Apuesta entre ${c.minBet} y ${c.maxBet}` });
  if (bet > u.balance) return res.status(400).json({ error: 'Saldo insuficiente' });
  const out = games[name](c.games[name], bet, req.body);
  const win = Math.floor(out.win); u.balance += win - bet; win > bet ? u.wins++ : u.losses++;
  u.name = req.u.name; save(gid);
  res.json({ result: out.result, bet, won: win, balance: u.balance });
});
app.get(`${G}/leaderboard`, auth, member, (req, res) => {
  const g = load(req.params.gid);
  res.json(Object.entries(g.users).map(([id, u]) => ({ id, name: u.name || id, balance: u.balance }))
    .sort((a, b) => b.balance - a.balance).slice(0, 10));
});

/* ---------- Dashboard (solo admins del servidor) ---------- */
app.get(`${G}/config`, auth, member, admin, (req, res) => res.json(load(req.params.gid).config));
app.put(`${G}/config`, auth, member, admin, (req, res) => {
  const g = load(req.params.gid), c = g.config, b = req.body || {};
  if (typeof b.currency === 'string') c.currency = b.currency.slice(0, 20) || c.currency;
  c.startBalance = num(b.startBalance, 0, 1e9, c.startBalance);
  c.dailyAmount = num(b.dailyAmount, 0, 1e9, c.dailyAmount);
  c.dailyCooldownH = num(b.dailyCooldownH, 1, 720, c.dailyCooldownH);
  c.minBet = num(b.minBet, 1, 1e9, c.minBet);
  c.maxBet = Math.max(c.minBet, num(b.maxBet, 1, 1e9, c.maxBet));
  const bg = b.games || {};
  for (const k of Object.keys(c.games)) if (bg[k]) {
    c.games[k].enabled = !!bg[k].enabled;
    if (k === 'coinflip') c.games[k].payout = num(bg[k].payout, 1.01, 1.99, c.games[k].payout);
    if (k === 'dice') c.games[k].houseEdge = num(bg[k].houseEdge, 0, 0.5, c.games[k].houseEdge);
    if (k === 'slots' && bg[k].payouts) {
      c.games[k].payouts.three = num(bg[k].payouts.three, 1, 100, c.games[k].payouts.three);
      c.games[k].payouts.two = num(bg[k].payouts.two, 0, 10, c.games[k].payouts.two);
    }
  }
  save(req.params.gid); res.json(c);
});

/* ---------- API para tu bot de Discord (cualquier bot) ---------- */
// GET  /bot/:gid/users/:uid          -> saldo
// POST /bot/:gid/users/:uid/balance  -> { "add": 100 } o { "set": 500 }   (header x-api-key)
app.get('/bot/:gid/users/:uid', botOnly, (req, res) => {
  if (!validId(req.params.gid) || !validId(req.params.uid)) return res.status(400).json({ error: 'ID inválido' });
  const u = user(load(req.params.gid), req.params.uid); save(req.params.gid); res.json(u);
});
app.post('/bot/:gid/users/:uid/balance', botOnly, (req, res) => {
  const { gid, uid } = req.params;
  if (!validId(gid) || !validId(uid)) return res.status(400).json({ error: 'ID inválido' });
  const u = user(load(gid), uid), b = req.body || {};
  if (Number.isFinite(b.set)) u.balance = Math.max(0, Math.floor(b.set));
  else if (Number.isFinite(b.add)) u.balance = Math.max(0, u.balance + Math.floor(b.add));
  else return res.status(400).json({ error: 'Usa "add" o "set"' });
  save(gid); res.json({ balance: u.balance });
});
app.get('/bot/:gid/config', botOnly, (req, res) => validId(req.params.gid)
  ? res.json(load(req.params.gid).config) : res.status(400).json({ error: 'ID inválido' }));

app.listen(PORT, () => console.log(`API lista en :${PORT}  |  datos en ${DATA_DIR}`));
