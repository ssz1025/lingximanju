// 事件总线：进程内广播 + SSE 订阅管理（自主实现，无第三方依赖）
const clients = new Set();

export function emit(type, payload = {}) {
  const event = { type, ts: Date.now(), ...payload };
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(line);
    } catch {
      clients.delete(client);
    }
  }
  return event;
}

export function subscribe(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 1500\n\n`);
  const client = { req, res, timer: null };
  clients.add(client);
  emit('hello', { clients: clients.size });
  client.timer = setInterval(() => {
    try { res.write(`: keepalive ${Date.now()}\n\n`); } catch { /* ignore */ }
  }, 20000);
  req.on('close', () => {
    clearInterval(client.timer);
    clients.delete(client);
  });
  return client;
}

export function clientCount() {
  return clients.size;
}
