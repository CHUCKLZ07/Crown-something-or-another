// Networking: host-authoritative star topology over PeerJS (WebRTC data channels).
// The host phone runs the rules engine; other phones send answers and receive redacted views.
import { CONFIG } from './config.js';

const HEARTBEAT_MS = 4000;
const TIMEOUT_MS = 15000;
const FAKE = new URLSearchParams(location.search).has('fakenet');

class Emitter {
  constructor() { this._h = {}; }
  on(ev, fn) { (this._h[ev] ||= []).push(fn); return this; }
  emit(ev, ...a) { (this._h[ev] || []).slice().forEach(f => f(...a)); }
}

// ---------- local test transport (BroadcastChannel between tabs; use ?fakenet=1) ----------
const chans = new Map();
const chan = name => { if (!chans.has(name)) chans.set(name, new BroadcastChannel(name)); return chans.get(name); };
const fakeConns = new Map();
const rid = () => Math.random().toString(36).slice(2, 10);

class FakeConn extends Emitter {
  constructor(peer, remote, connId) { super(); this.peer = peer; this.peerId = remote; this.connId = connId; this.open = false; }
  _open() { if (this.open) return; this.open = true; this.emit('open'); }
  send(data) { if (this.open) chan('fp:' + this.peerId).postMessage({ type: 'data', connId: this.connId, data: JSON.parse(JSON.stringify(data)) }); }
  close() { if (!this.open) return; chan('fp:' + this.peerId).postMessage({ type: 'close', connId: this.connId }); this._closed(); }
  _closed() { if (!this.open) return; this.open = false; this.emit('close'); }
}
class FakePeer extends Emitter {
  constructor(id) {
    super();
    this.id = id || 'fp' + rid(); this.destroyed = false; this.disconnected = false;
    this.ch = new BroadcastChannel('fp:' + this.id);
    this.ch.onmessage = e => this._msg(e.data);
    setTimeout(() => this.emit('open', this.id), 30);
  }
  _key(connId) { return connId + ':' + this.id; }
  _msg(m) {
    if (this.destroyed) return;
    if (m.type === 'connect') {
      const c = new FakeConn(this, m.from, m.connId);
      fakeConns.set(this._key(m.connId), c);
      this.emit('connection', c);
      c._open(); // host side is ready before the joiner hears 'accept'
      chan('fp:' + m.from).postMessage({ type: 'accept', connId: m.connId });
    } else {
      const c = fakeConns.get(this._key(m.connId));
      if (!c) return;
      if (m.type === 'accept') c._open();
      else if (m.type === 'data') c.open && c.emit('data', m.data);
      else if (m.type === 'close') c._closed();
    }
  }
  connect(remote) {
    const connId = rid();
    const c = new FakeConn(this, remote, connId);
    fakeConns.set(this._key(connId), c);
    chan('fp:' + remote).postMessage({ type: 'connect', from: this.id, connId });
    setTimeout(() => { if (!c.open) this.emit('error', { type: 'peer-unavailable', message: 'Host not found' }); }, 1500);
    return c;
  }
  reconnect() {}
  destroy() { this.destroyed = true; this.ch.close(); }
}

export function netAvailable() { return FAKE || typeof window.Peer === 'function'; }

function makePeer(id) {
  if (FAKE) return new FakePeer(id);
  if (typeof window.Peer !== 'function') throw new Error('PeerJS failed to load — check your internet connection.');
  const opts = { debug: 1 };
  if (CONFIG.iceServers) opts.config = { iceServers: CONFIG.iceServers };
  if (CONFIG.peerServer) Object.assign(opts, CONFIG.peerServer);
  return id ? new window.Peer(id, opts) : new window.Peer(opts);
}

// A wrapped data connection with heartbeat-based liveness (mobile WebRTC 'close' events are unreliable).
class Link {
  constructor(conn, onData, onDead) {
    this.conn = conn; this.lastSeen = Date.now(); this.dead = false; this.seat = null;
    this.onDead = onDead;
    conn.on('data', raw => {
      this.lastSeen = Date.now();
      let msg = raw;
      if (typeof raw === 'string') { try { msg = JSON.parse(raw); } catch { return; } }
      if (!msg || msg.t === 'hb') return;
      onData(msg);
    });
    conn.on('open', () => { this.lastSeen = Date.now(); if (this.queue) { const q = this.queue; this.queue = null; q.forEach(m => this.send(m)); } });
    conn.on('close', () => this.kill());
    conn.on('error', () => this.kill());
    this.timer = setInterval(() => {
      if (Date.now() - this.lastSeen > TIMEOUT_MS) this.kill();
      else this.send({ t: 'hb' });
    }, HEARTBEAT_MS);
  }
  send(msg) {
    if (this.dead) return;
    if (!this.conn.open) { (this.queue ||= []).push(msg); return; }
    try { if (this.queue) { const q = this.queue; this.queue = null; q.forEach(m => this.conn.send(m)); } this.conn.send(msg); } catch { this.kill(); }
  }
  kill() {
    if (this.dead) return;
    this.dead = true; clearInterval(this.timer);
    try { this.conn.close(); } catch {}
    this.onDead(this);
  }
}

export class NetHost {
  /** cb: { onOpen(), onError(type, err), onData(link, msg), onClose(link), onStatus(text) } */
  constructor(code, cb) { this.code = code; this.cb = cb; this.links = new Set(); this.closed = false; this.start(); }
  start() {
    let peer;
    try { peer = makePeer(CONFIG.peerPrefix + this.code); } catch (e) { this.cb.onError('nopeer', e); return; }
    this.peer = peer;
    this.cb.onStatus('Opening room…');
    peer.on('open', () => { if (peer === this.peer) { this.cb.onStatus('online'); this.cb.onOpen(); } });
    peer.on('connection', conn => {
      // attach listeners immediately so nothing sent right after 'open' can be missed
      const link = new Link(conn, msg => this.cb.onData(link, msg), l => { this.links.delete(l); this.cb.onClose(l); });
      this.links.add(link);
    });
    peer.on('disconnected', () => {
      if (this.closed || peer !== this.peer) return;
      this.cb.onStatus('Lost the matchmaking server — reconnecting…');
      setTimeout(() => { if (!this.closed && peer === this.peer && !peer.destroyed) peer.reconnect(); }, 2000);
    });
    peer.on('error', e => {
      if (this.closed || peer !== this.peer) return;
      if (e.type === 'unavailable-id') { this.cb.onError('id-taken', e); return; }
      if (e.type === 'peer-unavailable') return; // not relevant for host
      if (['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'].includes(e.type)) {
        this.cb.onStatus('Network trouble — retrying…');
        this.retrySoon();
        return;
      }
      this.cb.onError(e.type, e);
    });
  }
  retrySoon(ms = 4000) {
    clearTimeout(this.retryT);
    this.retryT = setTimeout(() => { if (this.closed) return; if (this.peer && !this.peer.destroyed && this.peer.disconnected) this.peer.reconnect(); else if (!this.peer || this.peer.destroyed) this.start(); }, ms);
  }
  restart(code) { if (code) this.code = code; try { this.peer && this.peer.destroy(); } catch {} this.peer = null; this.start(); }
  close() { this.closed = true; clearTimeout(this.retryT); for (const l of this.links) l.kill(); try { this.peer && this.peer.destroy(); } catch {} }
}

export class NetClient {
  /** cb: { onOpen(link), onData(msg), onStatus(text) } */
  constructor(code, cb) { this.code = code; this.cb = cb; this.closed = false; this.link = null; this.connect(); }
  ensurePeer() {
    if (this.peer && !this.peer.destroyed) {
      if (this.peer.disconnected) this.peer.reconnect();
      return Promise.resolve(this.peer);
    }
    return new Promise((resolve, reject) => {
      let peer;
      try { peer = makePeer(); } catch (e) { reject(e); return; }
      this.peer = peer;
      const t = setTimeout(() => reject(new Error('Matchmaking server timeout')), 12000);
      peer.on('open', () => { clearTimeout(t); resolve(peer); });
      peer.on('error', e => {
        if (this.closed) return;
        if (e.type === 'peer-unavailable') { this.cb.onStatus('Room not found yet — is the host’s app open? Retrying…'); this.retry(4000); return; }
        clearTimeout(t);
        if (!peer.open) reject(e);
        else { this.cb.onStatus('Network trouble — retrying…'); this.retry(3000); }
      });
      peer.on('disconnected', () => { if (!this.closed) setTimeout(() => !this.closed && !peer.destroyed && peer.reconnect(), 1500); });
    });
  }
  async connect() {
    if (this.closed) return;
    clearTimeout(this.retryT);
    this.cb.onStatus('Connecting…');
    let peer;
    try { peer = await this.ensurePeer(); }
    catch (e) {
      try { this.peer && this.peer.destroy(); } catch {}
      this.peer = null;
      this.cb.onStatus((e && e.message ? e.message : 'Connection failed') + ' — retrying…');
      this.retry(4000); return;
    }
    if (this.closed) return;
    const conn = peer.connect(CONFIG.peerPrefix + this.code, { reliable: true, serialization: 'json' });
    const openT = setTimeout(() => { if (!this.link || this.link.conn !== conn) { try { conn.close(); } catch {} this.retry(1000); } }, 12000);
    conn.on('open', () => {
      clearTimeout(openT);
      if (this.link && !this.link.dead) { try { conn.close(); } catch {} return; } // a late duplicate
      const link = new Link(conn, msg => this.cb.onData(msg), l => {
        if (this.link !== l) return;
        this.link = null;
        if (!this.closed) { this.cb.onStatus('Reconnecting…'); this.retry(1500); }
      });
      this.link = link;
      this.cb.onStatus('online');
      this.cb.onOpen(link);
    });
  }
  retry(ms) { if (this.closed) return; clearTimeout(this.retryT); this.retryT = setTimeout(() => this.connect(), ms); }
  send(msg) { if (this.link) { this.link.send(msg); return true; } return false; }
  close() { this.closed = true; clearTimeout(this.retryT); if (this.link) this.link.kill(); try { this.peer && this.peer.destroy(); } catch {} }
}
