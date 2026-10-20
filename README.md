# Casino para Discord (moneda virtual)

- `docs/index.html` → frontend estático (GitHub Pages: Settings → Pages → carpeta `/docs`)
- `backend/` → API Node.js. Guarda los datos en `DATA_DIR` (un JSON por servidor, permisos 600, fuera de carpetas públicas)

## Puesta en marcha
1. Discord Developer Portal → tu app → OAuth2 → Redirect: `https://TU_API/auth/callback`
2. `cd backend && cp .env.example .env` (rellena valores) → `npm i && npm start`
3. En `docs/index.html` cambia `API` por la URL de tu backend. Sube a GitHub.
4. Tu bot da el enlace: `https://TU_USUARIO.github.io/TU_REPO/?guild=<ID_DEL_SERVIDOR>`

## Conectar cualquier bot (header `x-api-key: BOT_API_KEY`)
- `GET  /bot/:guildId/users/:userId` → saldo y stats
- `POST /bot/:guildId/users/:userId/balance` con `{"add":100}` o `{"set":500}`
- `GET  /bot/:guildId/config`

Ejemplo (discord.js): 
```js
await fetch(`${API}/bot/${msg.guild.id}/users/${msg.author.id}/balance`, {
  method:'POST', headers:{'Content-Type':'application/json','x-api-key':KEY}, body: JSON.stringify({add:50}) });
```

## Hosting del backend
GitHub Pages no ejecuta servidores: aloja `backend/` en Render, Railway, Fly.io o un VPS (con disco persistente para `DATA_DIR`).
