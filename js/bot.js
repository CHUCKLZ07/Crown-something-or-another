// Simple "money + a few good actions" bot. Works only from the redacted view, like a human seat.
import { CARDS } from './cards.js';

const is = (id, t) => CARDS[id].types.includes(t);
const NON_TERMINAL = new Set(['crossroads', 'jubilee', 'bazaar', 'library', 'gatehouse']);
// Play order: villages / cantrips first, then the strongest terminals.
const PLAY_ORDER = ['crossroads', 'jubilee', 'bazaar', 'library', 'gatehouse', 'coronation', 'warcouncil', 'hexmonger',
  'guild', 'scriptorium', 'raiders', 'goldmine', 'moneychanger', 'tollbridge', 'palisade', 'renovation', 'woodwright', 'shrine'];
const BUY5 = ['library', 'hexmonger', 'bazaar', 'warcouncil', 'jubilee', 'goldmine'];
const BUY4 = ['scriptorium', 'raiders', 'moneychanger', 'coronation', 'renovation'];
const BUY3 = ['tollbridge', 'crossroads', 'woodwright'];
const BUY2 = ['palisade', 'shrine'];

function rank(id) {
  if (id === 'blight') return 0;
  if (is(id, 'victory')) return 1;
  if (id === 'copper') return 2;
  if (id === 'silver') return 4;
  if (id === 'gold') return 7;
  return 5;
}
const lowestFirst = (hand, idxs) => idxs.slice().sort((a, b) => rank(hand[a]) - rank(hand[b]));

function owned(v, id) { return v.mine[id] || 0; }
function totalCards(v) { return Object.values(v.mine).reduce((a, b) => a + b, 0); }
function terminals(v) { return Object.entries(v.mine).filter(([id]) => is(id, 'action') && !NON_TERMINAL.has(id)).reduce((s, [, c]) => s + c, 0); }
function villages(v) { return ['crossroads', 'jubilee'].reduce((s, id) => s + owned(v, id), 0); }

function wantAction(v, id) {
  if (!v.kingdom.includes(id) || !(v.supply[id] > 0)) return false;
  if (id === 'coronation' && terminals(v) < 3) return false;
  if (id === 'crossroads' && terminals(v) < 2) return false;
  if (id === 'shrine') return owned(v, 'shrine') === 0 && totalCards(v) <= 12;
  if (NON_TERMINAL.has(id)) return owned(v, id) < 4;
  const cap = 1 + villages(v) + Math.floor(totalCards(v) / 12);
  return terminals(v) < cap && owned(v, id) < 2;
}

export function pickPile(v, coins, filter = null, gaining = false) {
  const s = v.supply, ok = id => s[id] > 0 && CARDS[id].cost <= coins && (!filter || is(id, filter));
  const realmsLeft = s.realm;
  const late = realmsLeft <= Math.max(3, Math.ceil(v.players.length * 0.75));
  const choose = list => list.find(id => ok(id) && (!is(id, 'action') || wantAction(v, id)));
  if (filter === 'treasure') return ['gold', 'silver', 'copper'].find(ok) || null;
  if (coins >= 8 && ok('realm') && (owned(v, 'gold') > 0 || totalCards(v) > 15)) return 'realm';
  if (coins >= 6) {
    if (late && ok('barony')) return 'barony';
    if (ok('guild') && wantAction(v, 'guild') && owned(v, 'guild') < 1) return 'guild';
    if (ok('gold')) return 'gold';
  }
  if (coins >= 5) {
    if (late && ok('barony')) return 'barony';
    const a = choose(BUY5); if (a) return a;
  }
  if (coins >= 4) {
    if (realmsLeft <= 2 && ok('orchard')) return 'orchard';
    const a = choose(BUY4); if (a) return a;
  }
  if (coins >= 3) {
    if (realmsLeft <= 2 && ok('homestead')) return 'homestead';
    const a = choose(BUY3); if (a) return a;
    if (ok('silver')) return 'silver';
  }
  if (coins >= 2) {
    if (realmsLeft <= 3 && ok('homestead')) return 'homestead';
    const a = choose(BUY2); if (a) return a;
  }
  if (gaining) return Object.keys(s).filter(ok).sort((a, b) => CARDS[b].cost - CARDS[a].cost)[0] || null;
  return null;
}

export function botAnswer(v) {
  const d = v.pending, me = v.players[v.you], hand = me.hand, t = v.turn;
  if (d.type === 'turn') {
    if (t.phase === 'action' && t.actions > 0) {
      for (const id of PLAY_ORDER) {
        const i = hand.indexOf(id);
        if (i < 0) continue;
        if (id === 'coronation' && !hand.some((h, k) => k !== i && is(h, 'action'))) continue;
        if (id === 'moneychanger' && !hand.includes('copper') && !(t.actions > 1)) { /* still fine for +buy */ }
        if (id === 'goldmine' && !hand.some(h => is(h, 'treasure'))) continue;
        if (id === 'shrine' && !hand.some(h => h === 'blight' || h === 'homestead' || h === 'copper')) continue;
        return { kind: 'play', idx: i };
      }
    }
    const coins = t.coins + (t.phase === 'action' ? hand.reduce((s, id) => s + (CARDS[id].coins || 0), 0) : 0);
    if (t.buys > 0) {
      const first = t.bought.length === 0;
      const pile = pickPile(v, coins);
      if (pile && (first || CARDS[pile].cost >= 3 || pile === 'homestead' && v.supply.realm <= 3)) return { kind: 'buy', pile };
    }
    return { kind: 'endTurn' };
  }
  if (d.type === 'cards') {
    const el = d.eligible;
    const prompt = d.prompt || '';
    let pick;
    if (prompt.startsWith('Gatehouse')) pick = el.filter(i => rank(hand[i]) <= 1);
    else if (prompt.startsWith('Shrine')) {
      const coppers = owned(v, 'copper');
      let copperBudget = Math.max(0, coppers - 4);
      pick = lowestFirst(hand, el).filter(i => {
        const id = hand[i];
        if (id === 'blight') return true;
        if (id === 'homestead' && v.supply.realm > 4) return true;
        if (id === 'copper' && copperBudget > 0) { copperBudget--; return true; }
        return false;
      });
    } else if (prompt.startsWith('Coronation')) {
      const order = PLAY_ORDER.filter(id => id !== 'coronation');
      const i = order.map(id => hand.indexOf(id)).find(i => i >= 0 && el.includes(i));
      pick = i == null ? [] : [i];
    } else if (prompt.startsWith('Gold Mine')) {
      const i = hand.indexOf('silver') >= 0 ? hand.indexOf('silver') : hand.indexOf('copper');
      pick = i >= 0 ? [i] : [];
    } else if (prompt.startsWith('Put a card')) {
      const actionIdx = el.find(i => is(hand[i], 'action'));
      pick = [actionIdx != null && t && t.actions === 0 ? actionIdx : lowestFirst(hand, el).find(i => rank(hand[i]) >= 2) ?? lowestFirst(hand, el)[0]];
    } else if (prompt.startsWith('Renovation')) {
      const sorted = lowestFirst(hand, el);
      const goldIdx = hand.indexOf('gold');
      pick = [v.supply.realm <= 4 && goldIdx >= 0 ? goldIdx : sorted[0]];
    } else {
      pick = lowestFirst(hand, el).slice(0, d.min);
    }
    pick = pick.slice(0, d.max);
    if (pick.length < d.min) {
      for (const i of lowestFirst(hand, el)) { if (pick.length >= d.min) break; if (!pick.includes(i)) pick.push(i); }
    }
    return pick;
  }
  if (d.type === 'supply') {
    const pile = pickPile(v, d.maxCost, d.filter, true);
    if (pile && d.eligible.includes(pile)) return pile;
    return d.eligible.length ? d.eligible.slice().sort((a, b) => CARDS[b].cost - CARDS[a].cost)[0] : null;
  }
  if (d.type === 'yesno') return true;
  return null;
}
