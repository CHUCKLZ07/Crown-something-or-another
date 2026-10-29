import { Game, randomKingdom } from '../js/engine.js';
import { KINGDOM, PRESETS } from '../js/cards.js';
import { botAnswer } from '../js/bot.js';

let games = 0, turnsTotal = 0, fails = 0, limitHits = 0;
const wins = {};
const kingdoms = [...Object.values(PRESETS), KINGDOM.slice(0, 10), KINGDOM.slice(9, 19)];
for (let n = 2; n <= 6; n++) {
  for (let s = 1; s <= 120; s++) {
    const seed = n * 1000 + s;
    const kingdom = s <= kingdoms.length ? kingdoms[s - 1] : randomKingdom(seed);
    const setup = { names: Array.from({ length: n }, (_, i) => 'P' + i), kingdom, seed };
    try {
      const g = new Game(setup);
      let steps = 0;
      while (!g.over) {
        const p = g.pending.player;
        const a = botAnswer(g.view(p));
        const err = g.answer(g.pending.id, a);
        if (err) throw new Error(`bot answer rejected: ${err} ${JSON.stringify(a)} for ${JSON.stringify(g.pending)}`);
        if (++steps > 20000) throw new Error('stuck');
      }
      // replay determinism + card conservation check
      const g2 = Game.replay(setup, g.answers);
      if (JSON.stringify(g2.results) !== JSON.stringify(g.results)) throw new Error('replay mismatch');
      const owned = g.players.reduce((s, _, p) => s + g.allCards(p).length, 0);
      const startSupply = new Game(setup).supply;
      const startTotal = Object.values(startSupply).reduce((a, b) => a + b, 0) + 10 * n;
      const nowTotal = Object.values(g.supply).reduce((a, b) => a + b, 0) + owned + g.trash.length;
      if (startTotal !== nowTotal) throw new Error(`card count ${startTotal} -> ${nowTotal}`);
      const turns = g.players.reduce((s, p) => s + p.turns, 0);
      if (turns >= 60 * n) limitHits++;
      games++; turnsTotal += turns / n;
      const w = g.results.find(r => r.winner);
      wins[w.p] = (wins[w.p] || 0) + 1;
    } catch (e) { fails++; if (fails < 5) console.log(`n=${n} seed=${seed}:`, e.message); }
  }
}
console.log({ games, fails, limitHits, avgTurnsPerPlayer: (turnsTotal / games).toFixed(1), winsBySeat: wins });
if (fails) process.exit(1);
