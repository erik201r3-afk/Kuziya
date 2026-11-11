import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { internetOrigin, internetRooms } from './online.mjs';

const desktop = process.argv.includes('--desktop');
const online = process.argv.includes('--online');
if (online && desktop) throw new Error('Start desktop and internet signaling as separate processes');
const publicOrigin = desktop ? internetOrigin(process.env.MYRLO_ONLINE_URL) : null;
const internet = online ? internetRooms(closeRoom) : null;
const port = Number(process.env.PORT || 8765);
const host = desktop ? '127.0.0.1' : (process.env.HOST || '127.0.0.1');
const limit = 4;
const rooms = new Map();
const sessions = new Map();
const iceServers = JSON.parse(process.env.MYRLO_ICE_SERVERS || (desktop ? '[]' : '[{"urls":"stun:stun.l.google.com:19302"}]'));
const assets = new Map(await Promise.all([
  ...(online ? [
    ['/', 'online.html', 'text/html'],
    ['/room', 'index.html', 'text/html'],
    ['/online.js', 'online.js', 'text/javascript'],
  ] : [['/', 'index.html', 'text/html']]),
  ['/room.js', 'room.js', 'text/javascript'],
  ['/room.css', 'room.css', 'text/css'],
  ['/devices', 'devices.html', 'text/html'],
  ['/devices.js', 'devices.js', 'text/javascript'],
].map(async ([path, file, type]) => [
  path, { body: await readFile(new URL(`./public/${file}`, import.meta.url)), type },
])));

function send(member, type, data) {
  if (member.response.writableLength > 65536) {
    member.response.destroy();
    return;
  }
  member.response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function join(url, response) {
  const roomId = url.searchParams.get('room');
  const name = url.searchParams.get('name')?.trim();
  if (!/^[a-f0-9]{32}$/.test(roomId || '') || !name || name.length > 32) {
    response.writeHead(400).end();
    return;
  }

  const id = randomUUID();
  const internetRoom = internet?.find(roomId);
  let servers = iceServers;
  let turnUnavailable = false;
  if (internetRoom && (rooms.get(roomId)?.size || 0) < limit) {
    try {
      servers = await internet.ice(internetRoom, id);
    } catch {
      turnUnavailable = true;
    }
  }
  if (response.destroyed) return;
  const room = rooms.get(roomId) || new Map();
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'X-Accel-Buffering': 'no',
    'Cache-Control': 'no-cache, no-transform',
  });
  if (internet && !internet.find(roomId)) {
    send({ response }, 'expired', {});
    response.end();
    return;
  }
  if (room.size >= limit) {
    send({ response }, 'full', {});
    response.end();
    return;
  }

  const member = { id, token: randomUUID(), name, room, response };
  const peers = [...room.values()].map(({ id, name: peerName }) => ({ id, name: peerName }));
  rooms.set(roomId, room);
  room.set(member.id, member);
  sessions.set(member.token, member);
  send(member, 'welcome', {
    id: member.id, token: member.token, peers,
    iceServers: servers, turnUnavailable,
  });
  for (const peer of peers) send(room.get(peer.id), 'joined', { id: member.id, name });

  const heartbeat = setInterval(() => send(member, 'heartbeat', {}), 10000);
  response.on('close', () => {
    clearInterval(heartbeat);
    room.delete(member.id);
    sessions.delete(member.token);
    for (const peer of room.values()) send(peer, 'left', { id: member.id });
    if (!room.size) rooms.delete(roomId);
  });
}

async function signal(request, response) {
  const member = sessions.get(request.headers.authorization?.slice(7));
  if (!member || !request.headers.authorization.startsWith('Bearer ')) {
    response.writeHead(401).end();
    return;
  }
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 32768) {
      response.writeHead(413).end();
      return;
    }
  }

  const { to, type, data } = JSON.parse(body) || {};
  const peer = member.room.get(to);
  if (!peer || peer === member || !['description', 'candidate', 'sharing', 'subscribe'].includes(type)) {
    response.writeHead(400).end();
    return;
  }
  send(peer, 'signal', { from: member.id, type, data });
  response.writeHead(204).end();
}

function closeRoom(id) {
  for (const member of rooms.get(id)?.values() || []) {
    send(member, 'closed', {});
    member.response.end();
  }
}

const handleDesktop = desktop
  ? (await import('./desktop.mjs')).desktopRoutes(handleVoice, closeRoom)
  : null;

async function handleVoice(request, response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; media-src 'self' blob:; frame-ancestors 'none'");
  try {
    const url = new URL(request.url, 'http://localhost');
    if (handleDesktop && await handleDesktop(request, response, url)) return;
    if (internet?.route(request, response, url)) return;
    if (desktop && request.method === 'GET' && url.pathname === '/internet') {
      if (publicOrigin) response.writeHead(302, { Location: publicOrigin }).end();
      else response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('Интернет-комнаты ещё не настроены. Укажите адрес сервиса в MYRLO_ONLINE_URL.');
      return;
    }
    const asset = assets.get(url.pathname);
    if (request.method === 'GET' && asset) {
      response.writeHead(200, { 'Content-Type': `${asset.type}; charset=utf-8` }).end(asset.body);
    } else if (request.method === 'GET' && url.pathname === '/events') {
      await join(url, response);
    } else if (request.method === 'POST' && url.pathname === '/signal') {
      await signal(request, response);
    } else {
      response.writeHead(404).end();
    }
  } catch {
    if (!response.headersSent) response.writeHead(400);
    response.end();
  }
}

const listener = createServer(handleVoice).listen(port, host, () => {
  const url = `http://${host}:${listener.address().port}`;
  console.log(`Myrlo Voice: ${url}`);
  if (desktop && process.argv.includes('--open')) {
    const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
    const window = spawn(edge, [`--app=${url}/devices`], { detached: true, stdio: 'ignore' });
    window.on('error', () => console.log(`Откройте ${url}/devices в Chrome или Edge.`));
    window.unref();
  }
});



