// Crownforge rules engine. Pure, deterministic: same setup + same answers => same game.
// The whole game runs as one generator; every player decision is a `yield`.
import { CARDS, BASE, KINGDOM } from './cards.js';

export const MAX_PLAYERS = 6;

export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed() { return (Math.random() * 2 ** 32) >>> 0; }

export function randomKingdom(seed) {
  const r = makeRng(seed);
  const pool = KINGDOM.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return sortKingdom(pool.slice(0, 10));
}

export function sortKingdom(ids) {
  return ids.slice().sort((a, b) => CARDS[a].cost - CARDS[b].cost || CARDS[a].name.localeCompare(CARDS[b].name));
}

export function victoryPileSize(n) { return n <= 2 ? 8 : n <= 4 ? 12 : n === 5 ? 15 : 18; }

export function makeSupply(n, kingdom) {
  const v = victoryPileSize(n);
  const s = {
    copper: n <= 4 ? 60 - 7 * n : 40,
    silver: n <= 4 ? 40 : 60,
    gold: n <= 4 ? 30 : 40,
    homestead: v, barony: v, realm: v,
    blight: 10 * (n - 1),
  };
  for (const k of kingdom) s[k] = CARDS[k].types.includes('victory') ? v : 10;
  return s;
}

const TURN_LIMIT_PER_PLAYER = 60;

export class Game {
  /** setup: { names: string[], kingdom: string[], seed: number } */
  constructor(setup) {
    this.setup = setup;
    const n = setup.names.length;
    if (n < 2 || n > MAX_PLAYERS) throw new Error('2–6 players');
    this.r = makeRng(setup.seed);
    this.supply = makeSupply(n, setup.kingdom);
    this.trash = [];
    this.lines = []; this.lineNo = 0;
    this.seq = 0; this.answers = [];
    this.over = false; this.results = null;
    this.players = setup.names.map(name => ({ name, deck: [], hand: [], discard: [], inPlay: [], turns: 0 }));
    for (const pl of this.players) {
      pl.deck = this.shuffle([...Array(7).fill('copper'), ...Array(3).fill('homestead')]);
    }
    this.players.forEach((_, p) => this.draw(p, 5));
    this.first = Math.floor(this.r() * n);
    this.turn = null; this.pending = null;
    this.gen = this.main();
    this.advance(undefined);
  }

  static replay(setup, answers) {
    const g = new Game(setup);
    for (const a of answers) {
      const err = g.answer(g.pending && g.pending.id, a);
      if (err) throw new Error('Replay failed: ' + err);
    }
    return g;
  }

  // ---------- helpers used by cards ----------
  get n() { return this.players.length; }
  nm(p) { return this.players[p].name; }
  cn(id) { return CARDS[id].name; }
  cost(id) { return CARDS[id].cost; }
  is(id, type) { return CARDS[id].types.includes(type); }
  others(p) { const o = []; for (let i = 1; i < this.n; i++) o.push((p + i) % this.n); return o; }
  log(s) { this.lines.push({ n: ++this.lineNo, s }); if (this.lines.length > 200) this.lines.shift(); }
  shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  addActions(k) { this.turn.actions += k; }
  addBuys(k) { this.turn.buys += k; }
  addCoins(k) { this.turn.coins += k; }

  draw(p, k) {
    const pl = this.players[p];
    for (let i = 0; i < k; i++) {
      if (!pl.deck.length) {
        if (!pl.discard.length) break;
        pl.deck = this.shuffle(pl.discard); pl.discard = [];
      }
      pl.hand.push(pl.deck.pop());
    }
  }
  gain(p, id, to = 'discard') {
    if (!(this.supply[id] > 0)) return false;
    this.supply[id]--;
    const pl = this.players[p];
    (to === 'hand' ? pl.hand : to === 'deck' ? pl.deck : pl.discard).push(id);
    this.log(`${this.nm(p)} gains ${this.cn(id)}${to === 'hand' ? ' (to hand)' : ''}.`);
    return true;
  }
  takeFromHand(p, idxs) {
    const hand = this.players[p].hand;
    return [...idxs].sort((a, b) => b - a).map(i => hand.splice(i, 1)[0]).reverse();
  }
  trashFromHand(p, idxs) {
    const ids = this.takeFromHand(p, idxs);
    this.trash.push(...ids);
    if (ids.length) this.log(`${this.nm(p)} trashes ${ids.map(i => this.cn(i)).join(', ')}.`);
    return ids.length;
  }
  discardFromHand(p, idxs) {
    const ids = this.takeFromHand(p, idxs);
    this.players[p].discard.push(...ids);
    return ids.length;
  }
  allCards(p) { const pl = this.players[p]; return [...pl.deck, ...pl.hand, ...pl.discard, ...pl.inPlay]; }
  vp(p) {
    let t = 0;
    for (const id of this.allCards(p)) { const v = CARDS[id].vp; if (v) t += typeof v === 'function' ? v(this, p) : v; }
    return t;
  }
  matches(id, filter) { return !filter || this.is(id, filter); }

  askCards(p, o) { return { type: 'cards', player: p, min: 0, max: 1, filter: null, ...o }; }
  askSupply(p, o) { return { type: 'supply', player: p, maxCost: 99, filter: null, optional: false, ...o }; }
  askYesNo(p, o) { return { type: 'yesno', player: p, ...o }; }

  *attack(p, fn) {
    for (const t of this.others(p)) {
      if (this.players[t].hand.includes('palisade')) { this.log(`${this.nm(t)} reveals Palisade and is unaffected.`); continue; }
      yield* fn(t);
    }
  }
  *resolve(p, id) { const c = CARDS[id]; if (c.play) yield* c.play(this, p); }

  // ---------- turn structure ----------
  *main() {
    let cur = this.first;
    let turnNo = 0;
    for (;;) {
      turnNo++;
      this.players[cur].turns++;
      this.turn = { player: cur, actions: 1, buys: 1, coins: 0, phase: 'action', no: turnNo, bought: [] };
      this.log(`— ${this.nm(cur)}'s turn ${this.players[cur].turns} —`);
      yield* this.takeTurn(cur);
      this.cleanup(cur);
      if (this.checkEnd() || turnNo >= TURN_LIMIT_PER_PLAYER * this.n) break;
      cur = (cur + 1) % this.n;
    }
    this.finish();
  }

  *takeTurn(p) {
    const pl = this.players[p], t = this.turn;
    for (;;) {
      if (t.phase === 'buy' && t.buys <= 0) return;
      const a = yield { type: 'turn', player: p };
      if (a.kind === 'endTurn') return;
      if (a.kind === 'play') {
        const id = pl.hand.splice(a.idx, 1)[0];
        pl.inPlay.push(id);
        t.actions--;
        this.log(`${this.nm(p)} plays ${this.cn(id)}.`);
        yield* this.resolve(p, id);
      } else if (a.kind === 'treasure') {
        this.playTreasure(p, a.idx);
      } else if (a.kind === 'treasures') {
        this.playAllTreasures(p);
      } else if (a.kind === 'buy') {
        if (t.phase === 'action') this.playAllTreasures(p);
        t.phase = 'buy';
        t.buys--; t.coins -= this.cost(a.pile);
        this.supply[a.pile]--;
        pl.discard.push(a.pile);
        t.bought.push(a.pile);
        this.log(`${this.nm(p)} buys ${this.cn(a.pile)}.`);
      }
    }
  }
  playTreasure(p, idx) {
    const pl = this.players[p];
    const id = pl.hand.splice(idx, 1)[0];
    pl.inPlay.push(id);
    this.turn.coins += CARDS[id].coins || 0;
    this.turn.phase = 'buy';
  }
  playAllTreasures(p) {
    const pl = this.players[p];
    let total = 0, count = 0;
    for (let i = pl.hand.length - 1; i >= 0; i--) {
      if (this.is(pl.hand[i], 'treasure')) { total += CARDS[pl.hand[i]].coins || 0; this.playTreasure(p, i); count++; }
    }
    this.turn.phase = 'buy';
    return total;
  }
  cleanup(p) {
    const pl = this.players[p];
    pl.discard.push(...pl.hand, ...pl.inPlay);
    pl.hand = []; pl.inPlay = [];
    this.draw(p, 5);
  }
  emptyPiles() { return Object.values(this.supply).filter(c => c <= 0).length; }
  pileLimit() { return this.n >= 5 ? 4 : 3; }
  checkEnd() { return this.supply.realm <= 0 || this.emptyPiles() >= this.pileLimit(); }

  finish() {
    this.over = true;
    this.turn = null;
    const rows = this.players.map((pl, p) => {
      const counts = {};
      for (const id of this.allCards(p)) counts[id] = (counts[id] || 0) + 1;
      return { p, name: pl.name, vp: this.vp(p), turns: pl.turns, counts };
    });
    rows.sort((a, b) => b.vp - a.vp || a.turns - b.turns);
    const best = rows[0];
    rows.forEach(r => { r.winner = r.vp === best.vp && r.turns === best.turns; });
    this.results = rows;
    this.log(`Game over! ${rows.filter(r => r.winner).map(r => r.name).join(' & ')} win${rows.filter(r => r.winner).length > 1 ? '' : 's'}.`);
  }

  // ---------- decisions ----------
  eligibleHand(d) { return this.players[d.player].hand.map((id, i) => this.matches(id, d.filter) ? i : -1).filter(i => i >= 0); }
  eligibleSupply(d) {
    return Object.keys(this.supply).filter(id => this.supply[id] > 0 && this.cost(id) <= d.maxCost && this.matches(id, d.filter));
  }
  cardLimits(d) {
    const e = this.eligibleHand(d).length;
    return { min: Math.min(d.min, e), max: Math.min(d.max, e), eligible: e };
  }
  autoAnswer(d) {
    if (d.type === 'cards') {
      const { min, max } = this.cardLimits(d);
      if (max === 0) return [];
      if (min === max && min === this.eligibleHand(d).length) return this.eligibleHand(d);
    }
    if (d.type === 'supply' && !this.eligibleSupply(d).length) return null;
    return undefined;
  }

  validate(d, a) {
    if (d.type === 'turn') {
      const pl = this.players[d.player], t = this.turn;
      if (!a || typeof a.kind !== 'string') return 'Bad answer';
      switch (a.kind) {
        case 'endTurn': case 'treasures': return null;
        case 'play': {
          const id = pl.hand[a.idx];
          if (!id || !this.is(id, 'action')) return 'Not an action card';
          if (t.phase !== 'action') return 'Action phase is over';
          if (t.actions <= 0) return 'No actions left';
          return null;
        }
        case 'treasure': {
          const id = pl.hand[a.idx];
          return id && this.is(id, 'treasure') ? null : 'Not a treasure';
        }
        case 'buy': {
          if (!(a.pile in this.supply) || this.supply[a.pile] <= 0) return 'Pile is empty';
          if (t.buys <= 0) return 'No buys left';
          const coins = t.coins + (t.phase === 'action' ? pl.hand.reduce((s, id) => s + (CARDS[id].coins || 0), 0) : 0);
          if (this.cost(a.pile) > coins) return 'Not enough coins';
          return null;
        }
      }
      return 'Unknown move';
    }
    if (d.type === 'cards') {
      if (!Array.isArray(a)) return 'Bad answer';
      const { min, max } = this.cardLimits(d);
      const hand = this.players[d.player].hand;
      if (new Set(a).size !== a.length) return 'Duplicate card';
      if (a.length < min || a.length > max) return min === max ? `Choose exactly ${min}` : `Choose ${min}–${max}`;
      for (const i of a) { if (!Number.isInteger(i) || i < 0 || i >= hand.length || !this.matches(hand[i], d.filter)) return 'Invalid card'; }
      return null;
    }
    if (d.type === 'supply') {
      const el = this.eligibleSupply(d);
      if (a === null) return (d.optional || !el.length) ? null : 'You must choose a card';
      return el.includes(a) ? null : 'Not allowed';
    }
    if (d.type === 'yesno') return typeof a === 'boolean' ? null : 'Bad answer';
    return 'Unknown decision';
  }

  answer(id, a) {
    if (this.over) return 'Game is over';
    if (!this.pending || id !== this.pending.id) return 'That choice is out of date';
    const err = this.validate(this.pending, a);
    if (err) return err;
    this.answers.push(a);
    this.advance(a);
    return null;
  }

  advance(a) {
    let r = this.gen.next(a);
    while (!r.done) {
      const auto = this.autoAnswer(r.value);
      if (auto !== undefined) { r = this.gen.next(auto); continue; }
      this.pending = { ...r.value, id: ++this.seq };
      return;
    }
    this.pending = null;
  }

  // ---------- redacted view for one seat ----------
  view(me) {
    const d = this.pending;
    let pending = null;
    if (d) {
      pending = { id: d.id, type: d.type, player: d.player, prompt: d.prompt || null };
      if (d.player === me) {
        Object.assign(pending, { min: d.min, max: d.max, filter: d.filter, verb: d.verb, maxCost: d.maxCost, optional: d.optional });
        if (d.type === 'cards') { const l = this.cardLimits(d); pending.min = l.min; pending.max = l.max; pending.eligible = this.eligibleHand(d); }
        if (d.type === 'supply') pending.eligible = this.eligibleSupply(d);
      }
    }
    const mine = {};
    if (me != null && this.players[me]) for (const id of this.allCards(me)) mine[id] = (mine[id] || 0) + 1;
    return {
      you: me,
      players: this.players.map((pl, k) => ({
        name: pl.name,
        hand: k === me ? pl.hand.slice() : null,
        handCount: pl.hand.length,
        deckCount: pl.deck.length,
        discardCount: pl.discard.length,
        discardTop: pl.discard[pl.discard.length - 1] || null,
        inPlay: pl.inPlay.slice(),
        vp: this.vp(k),
        total: this.allCards(k).length,
      })),
      mine,
      supply: { ...this.supply },
      kingdom: this.setup.kingdom.slice(),
      trashCount: this.trash.length,
      turn: this.turn ? { ...this.turn, bought: this.turn.bought.slice() } : null,
      log: this.lines.slice(-60),
      pending,
      emptyPiles: this.emptyPiles(), pileLimit: this.pileLimit(),
      over: this.over,
      results: this.results,
    };
  }
}

export { CARDS, BASE, KINGDOM };
