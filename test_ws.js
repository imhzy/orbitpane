const WebSocket = require('ws');

const ws = new WebSocket('ws://127.0.0.1:8005/api/chat');

ws.on('open', function open() {
  console.log('connected');
  ws.send(JSON.stringify({ conversation_id: 6 }));
  ws.send('hello test from node');
});

ws.on('message', function incoming(data) {
  console.log('RECV:', data.toString());
  const parsed = JSON.parse(data.toString());
  if (parsed.type === 'done' || parsed.type === 'error') {
      ws.close();
  }
});

ws.on('error', function error(err) {
  console.log('Error:', err);
});
