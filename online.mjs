import { createHmac, randomBytes } from 'node:crypto';

const roomLifetime = 4 * 60 * 60 * 1000;
const roomLimit = 100;
const token = () => randomBytes(16).toString('hex');
const defaultStun = [{ urls: 'stun:stun.l.google.com:19302' }];

export function internetOrigin(value) {
  if (!value) return null;
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('MYRLO_ONLINE_URL must be an HTTPS origin');
  }
  return url.origin;
}

export function internetRooms(closeRoom) {
  const rooms = new Map();
  const stun = JSON.parse(process.env.MYRLO_ICE_SERVERS || JSON.stringify(defaultStun));
  const turnUrls = JSON.parse(process.env.MYRLO_TURN_URLS || '[]');
  const secret = process.env.MYRLO_TURN_SECRET;
  const keyId = process.env.KUZIYA_CF_TURN_KEY_ID;
  const apiToken = process.env.KUZIYA_CF_TURN_API_TOKEN;
  if (Boolean(keyId) !== Boolean(apiToken) || (keyId && !/^[a-zA-Z0-9_-]+$/.test(keyId))) {
    throw new Error('Configure both KUZIYA_CF_TURN_KEY_ID and KUZIYA_CF_TURN_API_TOKEN');
  }
  if (keyId && turnUrls.length) throw new Error('Configure only one TURN provider');
  if (!Array.isArray(turnUrls) || Boolean(turnUrls.length) !== Boolean(secret)
    || turnUrls.some((url) => typeof url !== 'string' || !/^turns?:/.test(url))) {
    throw new Error('Set MYRLO_TURN_URLS to a JSON array of TURN URLs and MYRLO_TURN_SECRET to the shared secret');
  }

  function remove(code) {
    clearTimeout(rooms.get(code)?.timer);
    rooms.delete(code);
    closeRoom(code);
  }

  function find(code) {
    const room = rooms.get(code);
    if (room && room.expiresAt <= Date.now()) {
      remove(code);
      return null;
    }
    return room;
  }

  async function ice(room, participant) {
    if (keyId) {
      const ttl = Math.max(1, Math.ceil((room.expiresAt - Date.now()) / 1000));
      const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Managed TURN credentials unavailable');
      const { iceServers } = await response.json();
      if (!Array.isArray(iceServers) || !iceServers.length) {
        throw new Error('Managed TURN returned no ICE servers');
      }
      return iceServers;
    }
    if (!secret) return stun;
    const username = `${Math.ceil(room.expiresAt / 1000)}:${participant}`;
    const credential = createHmac('sha1', secret).update(username).digest('base64');
    return [...stun, { urls: turnUrls, username, credential }];
  }

  function route(request, response, url) {
    if (!url.pathname.startsWith('/online/')) return false;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      response.writeHead(403).end('{}');
    } else if (request.method === 'GET' && url.pathname === '/online/health') {
      response.setHeader('X-Kuziya-Service', '1');
      response.writeHead(204).end();
    } else if (request.method === 'POST' && url.pathname === '/online/create') {
      if (rooms.size >= roomLimit) {
        response.writeHead(503).end('{}');
      } else {
        const code = token();
        const owner = token();
        const expiresAt = Date.now() + roomLifetime;
        const timer = setTimeout(() => remove(code), roomLifetime);
        timer.unref();
        rooms.set(code, { owner, expiresAt, timer });
        response.writeHead(201).end(JSON.stringify({ code, owner, expiresAt }));
      }
    } else if (request.method === 'GET' && url.pathname === '/online/check') {
      response.writeHead(find(url.searchParams.get('code')) ? 204 : 404).end();
    } else if (request.method === 'POST' && url.pathname === '/online/close') {
      const code = url.searchParams.get('code');
      const room = find(code);
      if (!room || request.headers.authorization !== `Bearer ${room.owner}`) {
        response.writeHead(404).end('{}');
      } else {
        remove(code);
        response.writeHead(204).end();
      }
    } else {
      response.writeHead(404).end('{}');
    }
    return true;
  }

  return { find, ice, route };
}
