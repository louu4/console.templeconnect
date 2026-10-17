const WebSocket = require('ws');
const os = require('os');
const path = require('path');
const screenshot = require('screenshot-desktop');
const robot = require('robotjs');

const SERVER_URL = process.env.SERVER_URL || 'wss://console-templeconnect.app';

const exeName = path.basename(process.execPath);
const match = exeName.match(/TempleConnect-Setup-([a-fA-F0-9]+)\.exe/);
const enrollmentKey = process.argv[2] || (match ? match[1] : '');

function connect() {
  console.log(`Connecting to TempleConnect relay at ${SERVER_URL} with key: [${enrollmentKey || 'none'}]...`);
  const ws = new WebSocket(SERVER_URL);

  ws.on('open', () => {
    console.log('Connected to server successfully.');
    ws.send(JSON.stringify({
      type: 'register',
      role: 'agent',
      key: enrollmentKey,
      name: os.hostname(),
      meta: {
        os: `${os.type()}${os.release()}`,
        host: os.hostname(),
        user: os.userInfo().username,
        build: '65'
      }
    }));

    // Start streaming desktop frames every 200ms
    setInterval(async () => {
      try {
        const imgBuffer = await screenshot({ format: 'jpeg', quality: 50 });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'screen_frame',
            data: imgBuffer.toString('base64')
          }));
        }
      } catch (err) {
        // Ignore capture errors if screen is locked or unavailable
      }
    }, 200);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'mouse_move') {
        robot.moveMouse(msg.x, msg.y);
      } else if (msg.type === 'mouse_click') {
        robot.mouseClick(msg.button || 'left', msg.double || false);
      } else if (msg.type === 'key_press') {
        robot.keyTap(msg.key);
      }
    } catch (err) {
      console.error('Message parse error:', err);
    }
  });

  ws.on('close', () => {
    console.log('Disconnected from server. Reconnecting in 5 seconds...');
    setTimeout(connect, 5000);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    ws.close();
  });
}

connect();