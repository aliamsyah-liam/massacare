/* Massacare - server mabar (tanpa dependensi, cukup Node.js 18+).
 *  - WebSocket relay: tiap room menyimpan "presence" tiap pemain dan menyiarkannya ~20x/detik.
 *  - Sekaligus menyajikan game (folder ../www) lewat HTTP, jadi PC/iPhone/HP lain bisa main
 *    hanya dengan membuka alamat server di browser.
 *  Jalankan: node server/server.js   (PORT default 8080)
 */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = +process.env.PORT || 8080;
const STATIC = process.env.STATIC_DIR || path.join(__dirname, '..', 'www');
const MAX_PEERS = 8, MAX_FRAME = 16 * 1024, ROOM_RE = /^mc-[a-z0-9]{6}$/;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(STATIC, p));
  if (!f.startsWith(path.normalize(STATIC))) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Massacare server aktif. Folder game (www) tidak ditemukan.'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(d);
  });
});

/* ---------- WebSocket minimal (RFC 6455) ---------- */
function frame(op, payload) {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let h;
  if (b.length < 126) h = Buffer.from([0x80 | op, b.length]);
  else if (b.length < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(b.length, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(b.length), 2); }
  return Buffer.concat([h, b]);
}
const rooms = new Map();
let counter = 0;

class Conn {
  constructor(sock) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.frag = []; this.fragOp = 0; this.alive = true;
    this.room = null; this.id = null; this.presence = {}; this.closed = false;
    sock.on('data', d => this.onData(d));
    sock.on('close', () => this.cleanup());
    sock.on('error', () => this.cleanup());
    sock.setNoDelay(true);
  }
  send(str) { if (!this.closed) try { this.sock.write(frame(1, str)); } catch (e) { } }
  close(code) {
    if (this.closed) return;
    try { const b = Buffer.alloc(2); b.writeUInt16BE(code || 1000); this.sock.write(frame(8, b)); this.sock.end(); } catch (e) { }
    this.cleanup();
  }
  onData(d) {
    this.miss = 0;
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 2 && !this.closed) {
      const b0 = this.buf[0], b1 = this.buf[1], op = b0 & 15, fin = !!(b0 & 128), masked = !!(b1 & 128);
      let len = b1 & 127, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (!masked || len > MAX_FRAME) return this.close(1009);
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.slice(off, off + 4), data = Buffer.from(this.buf.slice(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = this.buf.slice(off + 4 + len);
      if (op === 8) return this.close(1000);
      if (op === 9) { try { this.sock.write(frame(10, data)); } catch (e) { } continue; }
      if (op === 10) { this.alive = true; continue; }
      if (op === 1 || op === 2) { this.frag = [data]; this.fragOp = op; } else if (op === 0) this.frag.push(data); else continue;
      if (!fin) { if (Buffer.concat(this.frag).length > MAX_FRAME) return this.close(1009); continue; }
      if (this.fragOp === 1) this.onMessage(Buffer.concat(this.frag).toString('utf8'));
      this.frag = [];
    }
  }
  onMessage(s) {
    let m; try { m = JSON.parse(s); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'k') { this.send('{"t":"k"}'); return; }
    if (m.t === 'join' && !this.room) {
      if (typeof m.room !== 'string' || !ROOM_RE.test(m.room)) return this.close(1008);
      let r = rooms.get(m.room);
      if (!r) {
        if (m.create === false) { this.send(JSON.stringify({ t: 'noroom' })); return this.close(1008); }
        r = { name: m.room, peers: new Map(), dirty: false, exp: 0 }; rooms.set(m.room, r);
      }
      r.exp = 0;
      if (r.peers.size >= MAX_PEERS) { this.send(JSON.stringify({ t: 'full' })); return this.close(1008); }
      this.id = 'p' + String(++counter).padStart(8, '0'); this.room = r; r.peers.set(this.id, this); r.dirty = true;
      this.send(JSON.stringify({ t: 'welcome', id: this.id }));
      for (const c of r.peers.values()) if (c !== this && c.fc) this.send(JSON.stringify({ t: 'asset', peer: c.id, fc: c.fc }));
    } else if (m.t === 'a' && this.room) {
      const fc = (typeof m.fc === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]{20,2600}$/.test(m.fc)) ? m.fc : '';
      this.fc = fc;
      const msg = JSON.stringify({ t: 'asset', peer: this.id, fc });
      for (const c of this.room.peers.values()) if (c !== this) c.send(msg);
    } else if (m.t === 'p' && this.room && m.d && typeof m.d === 'object' && !Array.isArray(m.d)) {
      const ks = Object.keys(m.d);
      if (ks.length > 24) return;
      const next = Object.assign({}, this.presence);
      for (const k of ks) {
        if (k.length > 12) continue;
        const v = m.d[k];
        if (v === null) delete next[k];
        else { const js = JSON.stringify(v); if (js && js.length <= 1500) next[k] = v; }
      }
      if (JSON.stringify(next).length > 6000) return;
      this.presence = next; this.room.dirty = true;
    }
  }
  cleanup() {
    if (this.closed) return;
    this.closed = true;
    try { this.sock.destroy(); } catch (e) { }
    const r = this.room;
    if (r) { r.peers.delete(this.id); r.dirty = true; if (!r.peers.size) r.exp = Date.now() + 120000; }
  }
}

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  new Conn(sock);
});

setInterval(() => {
  for (const r of rooms.values()) {
    if (!r.dirty) continue;
    r.dirty = false;
    const msg = JSON.stringify({ t: 'state', peers: [...r.peers.values()].map(c => ({ peer: c.id, presence: c.presence })) });
    for (const c of r.peers.values()) c.send(msg);
  }
}, 50);
setInterval(() => {
  for (const r of rooms.values()) {
    if (!r.peers.size && r.exp && Date.now() > r.exp) { rooms.delete(r.name); continue; }
    for (const c of r.peers.values()) {
      if ((c.miss || 0) >= 4) { c.close(1001); continue; }
      c.miss = (c.miss || 0) + 1; try { c.sock.write(frame(9, '')); } catch (e) { }
    }
  }
}, 25000);

if (require.main === module) server.listen(PORT, () => console.log('Massacare server di port ' + PORT));
server._rooms = rooms;
module.exports = server;
