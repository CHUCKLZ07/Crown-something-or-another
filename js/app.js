import { Game, randomKingdom, randomSeed, MAX_PLAYERS } from './engine.js';
import { CARDS, KINGDOM, PRESETS } from './cards.js';
import { botAnswer } from './bot.js';
import { NetHost, NetClient, netAvailable } from './net.js';

// ---------------------------------------------------------------- utilities
const $app = document.getElementById('app');
const qs = new URLSearchParams(location.search);
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const genCode = () => Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
const cleanName = s => (String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14) || 'Player');
function myToken() {
  if (qs.get('tok')) return qs.get('tok');
  let t = LS.get('cf-token');
  if (!t) { t = Math.random().toString(36).slice(2) + Date.now().toString(36); LS.set('cf-token', t); }
  return t;
}
const C = id => CARDS[id];
const is = (id, t) => C(id).types.includes(t);
function kindOf(id) {
  const c = C(id);
  if (c.types.includes('curse')) return 'curse';
  if (c.types.includes('attack')) return 'attack';
  if (c.types.includes('reaction')) return 'reaction';
  if (c.types.includes('action')) return 'action';
  if (c.types.includes('treasure')) return 'treasure';
  return 'victory';
}
const typeLine = id => C(id).types.map(t => t[0].toUpperCase() + t.slice(1)).join(' – ');
const BOT_NAMES = ['Sir Bram', 'Lady Wren', 'Old Cobb', 'Mira Vale', 'Thane Osk', 'Dame Ysolt'];
const BASE_ROWS = [['copper', 'silver', 'gold', 'blight'], ['homestead', 'barony', 'realm']];

// ---------------------------------------------------------------- app state
const S = {
  screen: 'home',
  session: null,
  name: LS.get('cf-name', ''),
  code: (qs.get('join') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5),
  bots: 2,
  net: '',
  lobby: null,
  view: null,
  seats: null,
  ui: { sheet: null, sel: [], drawer: null, rules: false, endArmed: false },
  sentId: null,
  toast: null,
};

let toastT;
function toast(msg, ms = 2200) { S.toast = msg; render(); clearTimeout(toastT); toastT = setTimeout(() => { S.toast = null; render(); }, ms); }
function buzz(ms = 60) { try { navigator.vibrate && navigator.vibrate(ms); } catch {} }

// ---------------------------------------------------------------- host session (runs the game)
class HostSession {
  constructor({ solo = false, resume = null } = {}) {
    this.role = 'host';
    this.solo = solo;
    this.botTimer = null;
    if (resume) {
      this.code = resume.code; this.solo = !!resume.solo;
      this.seats = resume.seats.map(s => ({ ...s, link: null }));
      this.settings = resume.settings;
      this.game = resume.setup ? Game.replay(resume.setup, resume.answers || []) : null;
    } else {
      this.code = genCode();
      this.seats = [{ name: cleanName(S.name), token: myToken(), bot: false, local: true, link: null }];
      this.settings = { mode: 'Random', kingdom: randomKingdom(randomSeed()) };
      this.game = null;
    }
    if (!this.solo) this.openNet();
  }
  get started() { return !!this.game; }

  openNet() {
    S.net = 'Opening room…';
    this.net = new NetHost(this.code, {
      onOpen: () => { this.everOpened = true; S.net = 'online'; this.sync(); },
      onStatus: s => { S.net = s; render(); },
      onError: (type, e) => {
        if (type === 'id-taken') {
          if (!this.started && !this.everOpened) { this.code = genCode(); this.net.restart(this.code); }
          else { S.net = 'Room code still held by the server — retrying in 5s…'; render(); setTimeout(() => this.net && this.net.restart(), 5000); }
          return;
        }
        S.net = 'Network error: ' + (e && e.message ? e.message : type); render();
      },
      onData: (link, msg) => this.onData(link, msg),
      onClose: link => {
        if (link.seat != null && this.seats[link.seat] && this.seats[link.seat].link === link) {
          this.seats[link.seat].link = null;
          if (this.started && this.game && !this.game.over) toast(`${this.seats[link.seat].name} disconnected`);
          this.sync();
        }
      },
    });
  }

  onData(link, msg) {
    if (msg.t === 'hello') {
      let seat = this.seats.findIndex(s => !s.bot && s.token === msg.token);
      if (seat < 0) {
        if (this.started) { link.send({ t: 'reject', reason: 'That game has already started.' }); return; }
        if (this.seats.length >= MAX_PLAYERS) { link.send({ t: 'reject', reason: 'The room is full (6 players).' }); return; }
        this.seats.push({ name: this.uniqueName(cleanName(msg.name)), token: msg.token, bot: false, link: null });
        seat = this.seats.length - 1;
        toast(`${this.seats[seat].name} joined`);
      } else if (!this.started && seat > 0) {
        this.seats[seat].name = this.uniqueName(cleanName(msg.name), seat);
      }
      const old = this.seats[seat].link;
      this.seats[seat].link = link; link.seat = seat;
      if (old && old !== link) old.kill();
      link.send({ t: 'welcome', seat, code: this.code });
      this.save(); this.sync();
    } else if (msg.t === 'answer') {
      if (link.seat == null) return;
      this.apply(link.seat, msg.id, msg.answer, link);
    } else if (msg.t === 'leave') {
      if (link.seat == null || this.started || link.seat === 0) return;
      this.removeSeat(link.seat, true);
    }
  }

  uniqueName(name, except = -1) {
    let n = name, k = 2;
    while (this.seats.some((s, i) => i !== except && s.name === n)) n = `${name} ${k++}`;
    return n;
  }
  submit(id, answer) { this.apply(0, id, answer, null); }
  apply(seat, id, answer, link) {
    const g = this.game;
    if (!g || !g.pending || g.pending.player !== seat) { this.sendState(seat); return; }
    const err = g.answer(id, answer);
    if (err) {
      if (link) { link.send({ t: 'error', msg: err }); this.sendState(seat); } else toast(err);
      return;
    }
    this.afterChange();
  }
  afterChange() { this.save(); this.sync(); this.scheduleBot(); }
  scheduleBot() {
    clearTimeout(this.botTimer);
    const g = this.game, d = g && g.pending;
    if (!d || !this.seats[d.player].bot) return;
    this.botTimer = setTimeout(() => {
      if (!this.game || this.game.pending !== d) return;
      const err = this.game.answer(d.id, botAnswer(this.game.view(d.player)));
      if (err) { console.warn('bot error', err); this.game.answer(d.id, d.type === 'turn' ? { kind: 'endTurn' } : d.type === 'yesno' ? false : d.type === 'supply' ? null : []); }
      this.afterChange();
    }, d.type === 'turn' ? 650 : 450);
  }

  seatInfo() { return this.seats.map((s, i) => ({ name: s.name, bot: s.bot, host: i === 0, online: !!(s.local || s.bot || s.link) })); }
  lobbyPayload() { return { code: this.code, solo: this.solo, seats: this.seatInfo(), mode: this.settings.mode, kingdom: this.settings.kingdom }; }
  sendState(i) {
    const s = this.seats[i];
    if (!this.game) return;
    if (i === 0) setView(this.game.view(0), this.seatInfo());
    else if (s.link) s.link.send({ t: 'state', view: this.game.view(i), seats: this.seatInfo() });
  }
  sync() {
    if (!this.started) {
      const p = this.lobbyPayload();
      for (const s of this.seats) if (s.link) s.link.send({ t: 'lobby', lobby: p });
      S.lobby = p; S.screen = 'lobby'; render();
      return;
    }
    this.seats.forEach((_, i) => this.sendState(i));
  }

  addBot() {
    if (this.started || this.seats.length >= MAX_PLAYERS) return;
    const name = BOT_NAMES.find(n => !this.seats.some(s => s.name === n)) || 'Bot';
    this.seats.push({ name, token: 'bot-' + Math.random().toString(36).slice(2), bot: true, link: null });
    this.save(); this.sync();
  }
  removeSeat(i, left = false) {
    if (this.started || i <= 0 || i >= this.seats.length) return;
    const s = this.seats[i];
    if (s.link) { if (!left) s.link.send({ t: 'reject', reason: 'The host removed you from the room.' }); const l = s.link; s.link = null; l.seat = null; setTimeout(() => l.kill(), 300); }
    this.seats.splice(i, 1);
    this.seats.forEach((st, k) => { if (st.link) st.link.seat = k; });
    this.save(); this.sync();
  }
  setMode(mode) {
    this.settings.mode = mode;
    this.settings.kingdom = mode === 'Random' ? randomKingdom(randomSeed()) : PRESETS[mode].slice();
    this.save(); this.sync();
  }
  reroll() { this.settings.mode = 'Random'; this.settings.kingdom = randomKingdom(randomSeed()); this.save(); this.sync(); }
  start() {
    if (this.started || this.seats.length < 2) return;
    // shuffle seating so the host isn't always first? turn order randomised by the engine's first player
    this.game = new Game({ names: this.seats.map(s => s.name), kingdom: this.settings.kingdom.slice(), seed: randomSeed() });
    S.screen = 'game';
    this.afterChange();
  }
  rematch() {
    this.game = null;
    if (this.settings.mode === 'Random') this.settings.kingdom = randomKingdom(randomSeed());
    S.view = null; S.ui.sheet = null; S.ui.drawer = null;
    this.save(); this.sync();
  }
  save() {
    LS.set('cf-host', {
      code: this.code, solo: this.solo, settings: this.settings,
      seats: this.seats.map(({ name, token, bot, local }) => ({ name, token, bot, local })),
      setup: this.game ? this.game.setup : null, answers: this.game ? this.game.answers : [],
      finished: !!(this.game && this.game.over), savedAt: Date.now(),
    });
  }
  close() {
    clearTimeout(this.botTimer);
    if (!this.net) return;
    const keep = this.started && this.game && !this.game.over;
    for (const s of this.seats) if (s.link) s.link.send({ t: 'reject', reason: keep ? 'The host left. They can resume the game later — tap Rejoin then.' : 'The host closed the room.', keep });
    setTimeout(() => this.net.close(), 200);
  }
}

// ---------------------------------------------------------------- client session
class ClientSession {
  constructor(code) {
    this.role = 'client'; this.code = code;
    LS.set('cf-client', { code });
    S.net = 'Connecting…';
    this.net = new NetClient(code, {
      onOpen: link => link.send({ t: 'hello', token: myToken(), name: cleanName(S.name) }),
      onStatus: s => { S.net = s; render(); },
      onData: msg => this.onMsg(msg),
    });
    if (S.screen === 'home') { S.screen = 'lobby'; S.lobby = null; }
  }
  onMsg(m) {
    if (m.t === 'welcome') { this.seat = m.seat; }
    else if (m.t === 'lobby') { S.lobby = m.lobby; S.view = null; S.screen = 'lobby'; S.ui.drawer = null; render(); }
    else if (m.t === 'state') { setView(m.view, m.seats); if (m.view.over) LS.del('cf-client'); }
    else if (m.t === 'error') { S.sentId = null; toast(m.msg); }
    else if (m.t === 'reject') { toast(m.reason, 4500); leave(true, !!m.keep); }
  }
  submit(id, answer) {
    S.sentId = id;
    if (!this.net.send({ t: 'answer', id, answer })) { S.sentId = null; toast('Not connected — retrying…'); }
    render();
  }
  close() { try { if (this.net.link) this.net.send({ t: 'leave' }); } catch {} setTimeout(() => this.net.close(), 150); }
}

// ---------------------------------------------------------------- state updates
function setView(v, seats) {
  const prev = S.view;
  const was = prev && prev.pending && prev.pending.player === prev.you ? prev.pending.id : null;
  if (v.over && !(prev && prev.over)) S.ui.hideResults = false;
  S.view = v; S.seats = seats || S.seats; S.screen = 'game';
  if (!v.pending || v.pending.id !== S.sentId) S.sentId = null;
  const mine = v.pending && v.pending.player === v.you;
  if (mine && v.pending.id !== was) {
    S.ui.sel = []; S.ui.endArmed = false;
    if (v.pending.type === 'turn' && !(prev && prev.turn && prev.turn.player === v.you && prev.turn.no === v.turn.no)) { buzz(80); toast('Your turn!', 1400); }
    else if (v.pending.type !== 'turn') buzz(40);
  }
  if (!mine && S.ui.sheet && S.ui.sheet.kind === 'hand') S.ui.sheet = null;
  document.title = (mine ? '● ' : '') + 'Crownforge';
  render();
}

function act(answer) {
  const v = S.view, d = v && v.pending;
  if (!d || d.player !== v.you || S.sentId === d.id) return;
  S.ui.sheet = null; S.ui.sel = []; S.ui.endArmed = false;
  S.session.submit(d.id, answer);
}

function leave(force = false, keepClient = false) {
  const s = S.session;
  if (!force && s && s.role === 'host' && s.started && s.game && !s.game.over && !s.solo &&
      !confirm('Leave and end this game for everyone? (You can resume it from the home screen.)')) return;
  if (s) s.close();
  if (s && s.role === 'client' && !keepClient) LS.del('cf-client');
  S.session = null; S.view = null; S.lobby = null; S.screen = 'home'; S.ui = { sheet: null, sel: [], drawer: null, rules: false, endArmed: false };
  S.net = ''; document.title = 'Crownforge';
  releaseWake();
  render();
}

// ---------------------------------------------------------------- wake lock (keeps the screen on while playing)
let wake = null;
async function holdWake() { try { if ('wakeLock' in navigator && !wake && document.visibilityState === 'visible') { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch {} }
function releaseWake() { try { wake && wake.release(); } catch {} wake = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.session) holdWake(); });

// ---------------------------------------------------------------- rendering helpers
function cardFace(id, cls = '', attrs = '') {
  const c = C(id);
  return `<button class="card k-${kindOf(id)} ${cls}" ${attrs}>
    <span class="cost">${c.cost}</span><span class="art">${c.art}</span><span class="nm">${esc(c.name)}</span></button>`;
}
function bigCard(id) {
  const c = C(id);
  return `<div class="big k-${kindOf(id)}"><div class="big-top"><span class="cost lg">${c.cost}</span><span class="big-nm">${esc(c.name)}</span></div>
    <div class="big-art">${c.art}</div><div class="big-type">${typeLine(id)}</div><div class="big-text">${esc(c.text)}</div></div>`;
}
function handCoins(v) { const me = v.players[v.you]; return me.hand.reduce((s, id) => s + (C(id).coins || 0), 0); }
function myDecision(v) { return v && v.pending && v.pending.player === v.you ? v.pending : null; }
function turnCtx(v) {
  const d = myDecision(v);
  if (!d || d.type !== 'turn' || S.sentId === d.id) return null;
  const t = v.turn, pot = t.phase === 'action' ? handCoins(v) : 0;
  return { t, coins: t.coins, pot, total: t.coins + pot };
}
function canBuy(v, id) { const k = turnCtx(v); return !!k && k.t.buys > 0 && v.supply[id] > 0 && C(id).cost <= k.total; }
function canPlay(v, idx) {
  const k = turnCtx(v); if (!k) return false;
  const id = v.players[v.you].hand[idx];
  return is(id, 'action') && k.t.phase === 'action' && k.t.actions > 0;
}

// ---------------------------------------------------------------- screens
function renderHome() {
  const host = LS.get('cf-host'), cli = LS.get('cf-client');
  const resumes = [];
  if (host && host.setup && !host.finished) resumes.push(`<div class="resume"><span>${host.solo ? 'Unfinished solo game' : `Your hosted game <b>${esc(host.code)}</b>`}</span>
      <button class="btn sm gold" data-act="resume-host">Resume</button><button class="btn sm ghost" data-act="forget-host">✕</button></div>`);
  if (cli && cli.code) resumes.push(`<div class="resume"><span>Game <b>${esc(cli.code)}</b> in progress</span>
      <button class="btn sm gold" data-act="rejoin">Rejoin</button><button class="btn sm ghost" data-act="forget-client">✕</button></div>`);
  return `<main class="home">
    <div class="crest">♛</div>
    <h1>Crownforge</h1>
    <p class="tag">Build your deck. Grow your realm.</p>
    ${resumes.join('')}
    <label class="fld"><span>Your name</span><input id="name" maxlength="14" autocomplete="nickname" value="${esc(S.name)}" placeholder="e.g. Bill"></label>
    <section class="panel">
      <h2>Play online</h2>
      <button class="btn gold wide" data-act="host">Host a game</button>
      <div class="row"><input id="code" class="code-in" maxlength="5" placeholder="ROOM CODE" autocapitalize="characters" autocomplete="off" spellcheck="false" value="${esc(S.code)}">
        <button class="btn" data-act="join">Join</button></div>
    </section>
    <section class="panel">
      <h2>Play on this phone</h2>
      <div class="row"><select id="bots">${[1, 2, 3, 4, 5].map(k => `<option value="${k}" ${k === S.bots ? 'selected' : ''}>vs ${k} bot${k > 1 ? 's' : ''}</option>`).join('')}</select>
        <button class="btn" data-act="solo">Play solo</button></div>
    </section>
    <button class="link" data-act="rules">How to play</button>
    ${netAvailable() ? '' : '<p class="warn">Online play needs PeerJS, which failed to load. Check your connection and reload.</p>'}
  </main>`;
}

function renderLobby() {
  const s = S.session, L = S.lobby, isHost = s && s.role === 'host';
  if (!L) return `<main class="lobby"><div class="spinner"></div><p class="center">${esc(S.net || 'Connecting…')}</p>
    <p class="center small">Room <b>${esc(s ? s.code : '')}</b></p><button class="btn ghost wide" data-act="leave">Cancel</button></main>`;
  const url = shareUrl(L.code);
  const net = S.net && S.net !== 'online' ? `<p class="netwarn">${esc(S.net)}</p>` : '';
  return `<main class="lobby">
    ${L.solo ? '' : `<div class="codebox"><span class="lbl">Room code</span><span class="code">${esc(L.code)}</span>
      ${isHost ? `<div class="row"><button class="btn sm" data-act="share">Share invite</button><button class="btn sm ghost" data-act="copy">Copy link</button></div>
      <p class="small">Friends open <span class="mono">${esc(url.replace(/^https?:\/\//, ''))}</span> or enter the code.</p>` : ''}</div>`}
    ${net}
    <h3>Players <span class="dim">${L.seats.length}/${MAX_PLAYERS}</span></h3>
    <ul class="seats">${L.seats.map((p, i) => `<li><span class="dot ${p.online ? 'on' : ''}"></span>${esc(p.name)}
      ${p.host ? '<span class="tagc">host</span>' : ''}${p.bot ? '<span class="tagc">bot</span>' : ''}
      ${isHost && i > 0 ? `<button class="x" data-act="rm-seat" data-i="${i}" aria-label="Remove">✕</button>` : ''}</li>`).join('')}</ul>
    ${isHost && L.seats.length < MAX_PLAYERS ? '<button class="btn sm ghost" data-act="add-bot">+ Add bot</button>' : ''}
    <h3>Kingdom cards</h3>
    ${isHost ? `<div class="row"><select id="kmode">${['Random', ...Object.keys(PRESETS)].map(m => `<option ${m === L.mode ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
      <button class="btn sm ghost" data-act="reroll">↻ Reroll</button></div>` : `<p class="small dim">${esc(L.mode)}</p>`}
    <div class="kchips">${L.kingdom.map(id => `<button class="chip k-${kindOf(id)}" data-act="info" data-id="${id}"><span class="cost sm">${C(id).cost}</span>${C(id).art} ${esc(C(id).name)}</button>`).join('')}</div>
    ${isHost ? `<button class="btn gold wide" data-act="start" ${L.seats.length < 2 ? 'disabled' : ''}>${L.seats.length < 2 ? 'Waiting for players…' : `Start game (${L.seats.length} players)`}</button>
      ${L.solo ? '' : '<p class="small dim center">Keep this screen open while you play — your phone runs the game.</p>'}`
      : '<p class="center waiting">Waiting for the host to start…</p>'}
    <button class="btn ghost wide" data-act="leave">Leave</button>
  </main>`;
}

function statusLine(v) {
  if (v.over) return '<b>Game over</b>';
  const d = v.pending, P = v.players;
  if (!d) return '';
  if (d.player === v.you) {
    if (S.sentId === d.id) return 'Sending…';
    if (d.type === 'turn') {
      const t = v.turn, pot = t.phase === 'action' ? handCoins(v) : 0;
      return `<span class="pill">⚡ ${t.actions}</span><span class="pill">🛒 ${t.buys}</span><span class="pill gold">🪙 ${t.coins}${pot ? `<small> +${pot}</small>` : ''}</span><span class="ph">${t.phase === 'action' ? 'Action phase' : 'Buy phase'}</span>`;
    }
    return `<b class="prompt">${esc(d.prompt || 'Make a choice')}</b>`;
  }
  const who = esc(P[d.player].name);
  if (d.type === 'turn') {
    const t = v.turn;
    return `<span class="dim">${who}'s turn</span> <span class="pill sm">⚡ ${t.actions}</span><span class="pill sm">🛒 ${t.buys}</span><span class="pill sm gold">🪙 ${t.coins}</span>`;
  }
  return `<span class="dim">Waiting for ${who}…</span>`;
}

function renderGame() {
  const v = S.view; if (!v) return '<main class="center">Loading…</main>';
  const me = v.players[v.you], d = myDecision(v), t = v.turn;
  const live = d && S.sentId !== d.id;
  const seats = S.seats || [];
  const chips = v.players.map((p, k) => `<div class="pchip ${t && t.player === k ? 'active' : ''} ${k === v.you ? 'me' : ''}">
      <div class="pn">${seats[k] && !seats[k].online ? '<span class="off" title="offline">⚠</span>' : ''}${esc(p.name)}</div>
      <div class="ps"><b>${p.vp}</b> VP · ${p.handCount}✋ ${p.deckCount}📚</div></div>`).join('');
  const pile = id => {
    const n = v.supply[id] ?? 0, c = C(id);
    const cls = [`k-${kindOf(id)}`, n <= 0 ? 'empty' : '', canBuy(v, id) ? 'buyable' : '',
      live && d.type === 'supply' && d.eligible.includes(id) ? 'eligible' : ''].join(' ');
    return `<button class="pile ${cls}" data-act="pile" data-id="${id}"><span class="cost">${c.cost}</span><span class="cnt">${n}</span>
      <span class="art">${c.art}</span><span class="nm">${esc(c.name)}</span></button>`;
  };
  const active = t ? v.players[t.player] : null;
  const inPlay = active && active.inPlay.length ? active.inPlay.map(id => `<button class="mini k-${kindOf(id)}" data-act="info" data-id="${id}">${C(id).art}<span>${esc(C(id).name)}</span></button>`).join('') : '<span class="dim small">No cards in play</span>';
  const selecting = live && d.type === 'cards';
  const hand = me.hand.map((id, i) => {
    const cls = [];
    if (selecting) { if (d.eligible.includes(i)) cls.push('selectable'); else cls.push('dimmed'); if (S.ui.sel.includes(i)) cls.push('selected'); }
    else if (canPlay(v, i)) cls.push('playable');
    else if (live && d.type === 'turn' && is(id, 'treasure')) cls.push('treasure-ok');
    return cardFace(id, cls.join(' '), `data-act="hand" data-idx="${i}"`);
  }).join('') || '<span class="dim small">Your hand is empty</span>';

  let bar = '';
  if (live && d.type === 'turn') {
    const tre = me.hand.filter(id => is(id, 'treasure')).length;
    bar = `${tre ? `<button class="btn gold" data-act="treasures">Play treasures <small>+${handCoins(v)}</small></button>` : ''}
      <button class="btn ${S.ui.endArmed ? 'danger' : 'ghost'}" data-act="end">${S.ui.endArmed ? 'Tap again to end' : 'End turn'}</button>`;
  } else if (live && d.type === 'cards') {
    const n = S.ui.sel.length, ok = n >= d.min && n <= d.max;
    const rng = d.min === d.max ? `${d.min}` : `${d.min}–${d.max}`;
    bar = `<button class="btn gold" data-act="confirm" ${ok ? '' : 'disabled'}>${esc(d.verb || 'Confirm')} ${n ? `(${n})` : ''}</button>
      <span class="small dim">choose ${rng}</span>${n ? '<button class="btn ghost sm" data-act="clear">Clear</button>' : ''}`;
  } else if (live && d.type === 'supply') {
    bar = `<span class="small">Tap a glowing pile${d.maxCost < 99 ? ` (cost ≤ ${d.maxCost})` : ''}</span>${d.optional ? '<button class="btn ghost" data-act="skip">Skip</button>' : ''}`;
  } else if (live && d.type === 'yesno') {
    bar = `<button class="btn gold" data-act="yes">Yes</button><button class="btn ghost" data-act="no">No</button>`;
  } else if (v.over) {
    bar = `<button class="btn gold" data-act="results">Results</button>`;
  } else {
    bar = `<span class="small dim">${d && S.sentId === d.id ? 'Sending…' : 'Not your move'}</span>`;
  }
  const lastLines = v.log.slice(-2).map(l => `<div>${esc(l.s)}</div>`).join('');
  const net = S.net && S.net !== 'online' && S.session && !S.session.solo ? `<div class="netbar">${esc(S.net)}</div>` : '';

  return `<main class="game ${t && t.player === v.you ? 'my-turn' : ''}">
    <header class="players">${chips}</header>
    ${net}
    <div class="status">${statusLine(v)}</div>
    <div class="ticker" data-act="log">${lastLines}</div>
    <section class="board">
      <div class="base">${BASE_ROWS.flat().map(pile).join('')}<div class="pile meta"><span>🗑️ ${v.trashCount}</span><span>Empty ${v.emptyPiles}/${v.pileLimit}</span></div></div>
      <div class="kingdom">${v.kingdom.map(pile).join('')}</div>
      <div class="inplay"><span class="lbl">${active ? esc(active.name) + ' played' : ''}</span><div class="minis">${inPlay}</div></div>
    </section>
    <section class="hand ${selecting ? 'selecting' : ''}">${hand}</section>
    <footer class="bar"><div class="acts">${bar}</div>
      <div class="tools"><button class="icon" data-act="deck" aria-label="My deck">🃏</button><button class="icon" data-act="menu" aria-label="Menu">☰</button></div></footer>
  </main>`;
}

function renderSheet() {
  const sh = S.ui.sheet; if (!sh) return '';
  const v = S.view, d = myDecision(v);
  let id = sh.id, btns = [];
  if (sh.kind === 'hand') {
    id = v.players[v.you].hand[sh.idx];
    if (!id) return '';
    if (canPlay(v, sh.idx)) btns.push(`<button class="btn gold wide" data-act="play" data-idx="${sh.idx}">Play ${esc(C(id).name)}</button>`);
    if (turnCtx(v) && is(id, 'treasure')) btns.push(`<button class="btn wide" data-act="play-treasure" data-idx="${sh.idx}">Play this treasure</button>`);
  } else if (sh.kind === 'pile' && v) {
    const n = v.supply[id] ?? 0;
    if (canBuy(v, id)) btns.push(`<button class="btn gold wide" data-act="buy" data-id="${id}">Buy for ${C(id).cost} 🪙</button>`);
    if (d && d.type === 'supply' && S.sentId !== d.id && d.eligible.includes(id)) btns.push(`<button class="btn gold wide" data-act="gain" data-id="${id}">Gain ${esc(C(id).name)}</button>`);
    btns.push(`<p class="small dim center">${n} left in supply${v.mine[id] ? ` · you own ${v.mine[id]}` : ''}</p>`);
  }
  return `<div class="overlay" data-act="close-sheet"><div class="sheet">${bigCard(id)}${btns.join('')}
    <button class="btn ghost wide" data-act="close-sheet">Close</button></div></div>`;
}

function renderDrawer() {
  const dr = S.ui.drawer; if (!dr) return '';
  const v = S.view;
  let body = '';
  if (dr === 'log') body = `<h3>Game log</h3><div class="log">${v.log.slice().reverse().map(l => `<div class="${l.s.startsWith('—') ? 'turnline' : ''}">${esc(l.s)}</div>`).join('')}</div>`;
  else if (dr === 'deck') {
    const me = v.players[v.you];
    const ids = Object.keys(v.mine).sort((a, b) => kindOf(a).localeCompare(kindOf(b)) || C(b).cost - C(a).cost);
    body = `<h3>My cards <span class="dim">${me.total}</span></h3>
      <p class="small dim">Deck ${me.deckCount} · Discard ${me.discardCount} · Hand ${me.handCount} · ${me.vp} VP</p>
      <div class="decklist">${ids.map(id => `<button class="chip k-${kindOf(id)}" data-act="info" data-id="${id}">${C(id).art} ${esc(C(id).name)} <b>×${v.mine[id]}</b></button>`).join('')}</div>`;
  } else if (dr === 'menu') {
    const s = S.session;
    body = `<h3>Menu</h3>${s && s.role === 'host' && !s.solo ? `<p class="small">Room code <b class="mono">${esc(s.code)}</b></p><button class="btn wide" data-act="share">Share invite link</button>` : ''}
      <button class="btn wide" data-act="log">Game log</button>
      <button class="btn wide" data-act="rules">How to play</button>
      <button class="btn danger wide" data-act="leave">${s && s.role === 'host' && !s.solo ? 'End game for everyone' : 'Leave game'}</button>`;
  }
  return `<div class="overlay" data-act="close-drawer"><div class="drawer">${body}<button class="btn ghost wide" data-act="close-drawer">Close</button></div></div>`;
}

function renderResults() {
  const v = S.view; if (!v || !v.over || S.ui.hideResults) return '';
  const vpIds = ['realm', 'barony', 'homestead', 'orchard', 'blight'];
  const s = S.session;
  return `<div class="overlay"><div class="sheet results"><h2>${v.results.filter(r => r.winner).map(r => esc(r.name)).join(' & ')} ${v.results.filter(r => r.winner).length > 1 ? 'share the crown!' : 'takes the crown!'}</h2>
    <table>${v.results.map((r, i) => `<tr class="${r.winner ? 'win' : ''}"><td>${r.winner ? '👑' : i + 1}</td><td>${esc(r.name)}</td><td><b>${r.vp}</b> VP</td>
      <td class="small">${vpIds.filter(id => r.counts[id]).map(id => `${C(id).art}${r.counts[id]}`).join(' ')}</td><td class="small dim">${r.turns}t</td></tr>`).join('')}</table>
    ${s && s.role === 'host' ? `<button class="btn gold wide" data-act="rematch">${s.solo ? 'Play again' : 'Back to lobby (same players)'}</button>` : '<p class="small dim center">The host can start a rematch.</p>'}
    <button class="btn wide" data-act="hide-results">View board</button>
    <button class="btn ghost wide" data-act="leave-now">Home</button></div></div>`;
}

function renderRules() {
  if (!S.ui.rules) return '';
  return `<div class="overlay" data-act="close-rules"><div class="drawer rules">
    <h3>How to play</h3>
    <p><b>Goal:</b> have the most victory points (VP) when the game ends. VP come from 🏡 Homestead (1), 🏰 Barony (3), 🗺️ Realm (6) and 🍎 Orchard. 🥀 Blight is −1.</p>
    <p><b>Start:</b> everyone has 7 Copper + 3 Homestead, shuffled; draw 5.</p>
    <p><b>Your turn:</b></p>
    <ol><li><b>Action</b> — you have 1 ⚡ Action: tap an Action card in your hand to play it. Cards can give more Actions, Cards, Buys (🛒) or Coins (🪙).</li>
    <li><b>Buy</b> — play your treasures, then tap a supply pile to buy a card costing up to your coins. You get 1 Buy unless cards give more. Bought cards go to your discard pile.</li>
    <li><b>Clean-up</b> — everything you played or held is discarded and you draw 5 new cards. When your deck runs out, your discard pile is shuffled into a new deck.</li></ol>
    <p><b>Game end:</b> after any turn where the Realm pile is empty, or 3 supply piles are empty (4 with 5–6 players). Ties go to the player who took fewer turns.</p>
    <p><b>Attacks</b> (red) hit every other player. Holding 🛡️ Palisade in your hand makes you immune.</p>
    <p><b>Tips:</b> early on, buy Silver and good Actions; buy Gold at 6+, Realm at 8. Victory cards clog your deck, so don't buy them too early. Trashing weak cards (Shrine, Renovation) makes your deck stronger.</p>
    <button class="btn ghost wide" data-act="close-rules">Close</button></div></div>`;
}

function shareUrl(code) { return location.origin + location.pathname + '?join=' + code; }

// ---------------------------------------------------------------- render loop
function render() {
  const keep = {};
  for (const sel of ['.hand', '.board', '.log', '.drawer']) { const el = $app.querySelector(sel); if (el) keep[sel] = [el.scrollLeft, el.scrollTop]; }
  const focus = document.activeElement && document.activeElement.id;
  let html = '';
  if (S.screen === 'home') html = renderHome();
  else if (S.screen === 'lobby') html = renderLobby();
  else html = renderGame() + renderResults() + renderDrawer() + renderSheet();
  html += renderRules();
  if (S.toast) html += `<div class="toast">${esc(S.toast)}</div>`;
  if (S.screen === 'home' && focus && ['name', 'code'].includes(focus)) {
    // don't clobber an input the user is typing in; just refresh toast/rules
    const t = $app.querySelector('.toast'); if (t) t.remove();
    const r = $app.querySelector('.rules'); if (r) r.parentElement.remove();
    $app.insertAdjacentHTML('beforeend', renderRules() + (S.toast ? `<div class="toast">${esc(S.toast)}</div>` : ''));
    return;
  }
  $app.innerHTML = html;
  for (const sel in keep) { const el = $app.querySelector(sel); if (el) { el.scrollLeft = keep[sel][0]; el.scrollTop = keep[sel][1]; } }
}

// ---------------------------------------------------------------- input handling
function needName() {
  const el = document.getElementById('name');
  if (el) S.name = el.value;
  if (!cleanName(S.name) || !S.name.trim()) { toast('Enter your name first'); el && el.focus(); return true; }
  LS.set('cf-name', S.name.trim());
  return false;
}

async function share(code) {
  const url = shareUrl(code);
  try { if (navigator.share) { await navigator.share({ title: 'Crownforge', text: `Join my Crownforge game! Room code ${code}`, url }); return; } } catch { return; }
  copy(url);
}
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Link copied'); } catch { prompt('Copy this link:', text); } }

$app.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const a = el.dataset.act;
  // overlays close only when the backdrop itself (or a close button) is tapped
  if ((a === 'close-sheet' || a === 'close-drawer' || a === 'close-rules') && el.classList.contains('overlay') && e.target !== el) return;
  const v = S.view, s = S.session;
  switch (a) {
    case 'host':
      if (needName()) return;
      if (!netAvailable()) { toast('Online play unavailable — PeerJS did not load'); return; }
      S.session = new HostSession(); S.screen = 'lobby'; holdWake(); S.session.sync(); return;
    case 'join': {
      if (needName()) return;
      const code = (document.getElementById('code').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length !== 5) { toast('Room codes are 5 characters'); return; }
      if (!netAvailable()) { toast('Online play unavailable — PeerJS did not load'); return; }
      S.code = code; S.session = new ClientSession(code); holdWake(); render(); return;
    }
    case 'solo': {
      if (needName()) return;
      S.bots = +document.getElementById('bots').value || 2;
      const h = new HostSession({ solo: true }); S.session = h;
      for (let i = 0; i < S.bots; i++) h.addBot();
      h.start(); holdWake(); return;
    }
    case 'resume-host': {
      const saved = LS.get('cf-host');
      try { S.session = new HostSession({ resume: saved }); holdWake(); S.session.sync(); S.session.scheduleBot(); }
      catch (err) { console.error(err); toast('Could not resume that game'); LS.del('cf-host'); S.session = null; render(); }
      return;
    }
    case 'forget-host': LS.del('cf-host'); render(); return;
    case 'rejoin': { const c = LS.get('cf-client'); if (!c) return; if (!S.name.trim()) S.name = LS.get('cf-name', 'Player'); S.session = new ClientSession(c.code); holdWake(); render(); return; }
    case 'forget-client': LS.del('cf-client'); render(); return;
    case 'rules': S.ui.rules = true; S.ui.drawer = null; render(); return;
    case 'close-rules': S.ui.rules = false; render(); return;
    case 'share': share(s.code); return;
    case 'copy': copy(shareUrl(s.code)); return;
    case 'add-bot': s.addBot(); return;
    case 'rm-seat': s.removeSeat(+el.dataset.i); return;
    case 'reroll': s.reroll(); return;
    case 'start': s.start(); return;
    case 'leave': leave(); return;
    case 'leave-now': leave(true); if (s && s.role === 'host') LS.del('cf-host'); return;
    case 'info': S.ui.sheet = { kind: 'info', id: el.dataset.id }; if (S.screen === 'lobby') { renderLobbySheet(); return; } S.ui.drawer = null; render(); return;
    case 'pile': {
      const id = el.dataset.id;
      const d = myDecision(v);
      S.ui.sheet = { kind: 'pile', id }; S.ui.endArmed = false;
      if (d && d.type === 'supply' && S.sentId !== d.id && !d.eligible.includes(id)) { /* show info only */ }
      render(); return;
    }
    case 'hand': {
      const i = +el.dataset.idx, d = myDecision(v);
      if (d && d.type === 'cards' && S.sentId !== d.id) {
        if (!d.eligible.includes(i)) return;
        const k = S.ui.sel.indexOf(i);
        if (k >= 0) S.ui.sel.splice(k, 1);
        else { if (d.max === 1) S.ui.sel = [i]; else if (S.ui.sel.length < d.max) S.ui.sel.push(i); }
        render(); return;
      }
      S.ui.sheet = { kind: 'hand', idx: i }; S.ui.endArmed = false; render(); return;
    }
    case 'play': act({ kind: 'play', idx: +el.dataset.idx }); return;
    case 'play-treasure': act({ kind: 'treasure', idx: +el.dataset.idx }); return;
    case 'treasures': act({ kind: 'treasures' }); return;
    case 'buy': act({ kind: 'buy', pile: el.dataset.id }); return;
    case 'gain': act(el.dataset.id); return;
    case 'skip': act(null); return;
    case 'yes': act(true); return;
    case 'no': act(false); return;
    case 'confirm': act(S.ui.sel.slice()); return;
    case 'clear': S.ui.sel = []; render(); return;
    case 'end':
      if (!S.ui.endArmed) { S.ui.endArmed = true; render(); setTimeout(() => { if (S.ui.endArmed) { S.ui.endArmed = false; render(); } }, 2500); return; }
      act({ kind: 'endTurn' }); return;
    case 'close-sheet': S.ui.sheet = null; if (S.screen === 'lobby') { render(); return; } render(); return;
    case 'log': S.ui.drawer = 'log'; S.ui.sheet = null; render(); return;
    case 'deck': S.ui.drawer = 'deck'; S.ui.sheet = null; render(); return;
    case 'menu': S.ui.drawer = 'menu'; render(); return;
    case 'close-drawer': S.ui.drawer = null; render(); return;
    case 'results': S.ui.hideResults = false; render(); return;
    case 'hide-results': S.ui.hideResults = true; render(); return;
    case 'rematch': S.ui.hideResults = false; s.rematch(); if (s.solo) s.start(); return;
  }
});

function renderLobbySheet() {
  render();
  const id = S.ui.sheet.id;
  $app.insertAdjacentHTML('beforeend', `<div class="overlay" data-act="close-sheet"><div class="sheet">${bigCard(id)}<button class="btn ghost wide" data-act="close-sheet">Close</button></div></div>`);
}

$app.addEventListener('input', e => {
  if (e.target.id === 'name') { S.name = e.target.value; LS.set('cf-name', S.name.trim()); }
  if (e.target.id === 'code') { const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); if (v !== e.target.value) e.target.value = v; S.code = v; }
});
$app.addEventListener('change', e => {
  if (e.target.id === 'kmode' && S.session && S.session.role === 'host') S.session.setMode(e.target.value);
  if (e.target.id === 'bots') S.bots = +e.target.value;
});
$app.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'code') { e.preventDefault(); $app.querySelector('[data-act="join"]').click(); } });

window.addEventListener('beforeunload', e => {
  const s = S.session;
  if (s && s.role === 'host' && !s.solo && s.started && s.game && !s.game.over) { e.preventDefault(); e.returnValue = ''; }
});

// expose for automated tests / debugging
window.__cf = { S, CARDS, KINGDOM };
render();
