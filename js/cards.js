// Crownforge card definitions — original card set (mechanics inspired by classic deck-builders).
// Each kingdom card's `play` is a generator: `yield` a decision to ask a player, receive the answer.

export const BASE = ['copper', 'silver', 'gold', 'homestead', 'barony', 'realm', 'blight'];

export const CARDS = {
  // ---- Treasures ----
  copper: { name: 'Copper', cost: 0, types: ['treasure'], coins: 1, art: '🪙', text: '+1 Coin' },
  silver: { name: 'Silver', cost: 3, types: ['treasure'], coins: 2, art: '🥈', text: '+2 Coins' },
  gold:   { name: 'Gold',   cost: 6, types: ['treasure'], coins: 3, art: '👑', text: '+3 Coins' },

  // ---- Victory / curse ----
  homestead: { name: 'Homestead', cost: 2, types: ['victory'], vp: 1, art: '🏡', text: '1 VP' },
  barony:    { name: 'Barony',    cost: 5, types: ['victory'], vp: 3, art: '🏰', text: '3 VP' },
  realm:     { name: 'Realm',     cost: 8, types: ['victory'], vp: 6, art: '🗺️', text: '6 VP' },
  blight:    { name: 'Blight',    cost: 0, types: ['curse'],   vp: -1, art: '🥀', text: '−1 VP' },

  // ---- Kingdom cards ----
  gatehouse: {
    name: 'Gatehouse', cost: 2, types: ['action'], art: '🚪',
    text: '+1 Action. Discard any number of cards, then draw that many.',
    *play(g, p) {
      g.addActions(1);
      const hand = g.players[p].hand;
      if (!hand.length) return;
      const pick = yield g.askCards(p, { min: 0, max: hand.length, prompt: 'Gatehouse: discard any number of cards to redraw.', verb: 'Discard' });
      const n = g.discardFromHand(p, pick);
      if (n) g.log(`${g.nm(p)} discards ${n} and redraws.`);
      g.draw(p, n);
    },
  },
  shrine: {
    name: 'Shrine', cost: 2, types: ['action'], art: '⛩️',
    text: 'Trash up to 3 cards from your hand.',
    *play(g, p) {
      if (!g.players[p].hand.length) return;
      const pick = yield g.askCards(p, { min: 0, max: 3, prompt: 'Shrine: trash up to 3 cards.', verb: 'Trash' });
      g.trashFromHand(p, pick);
    },
  },
  palisade: {
    name: 'Palisade', cost: 2, types: ['action', 'reaction'], art: '🛡️',
    text: '+2 Cards. Reaction: while this is in your hand, you are immune to other players’ attacks.',
    *play(g, p) { g.draw(p, 2); },
  },
  crossroads: {
    name: 'Crossroads Inn', cost: 3, types: ['action'], art: '🍺',
    text: '+1 Card, +2 Actions.',
    *play(g, p) { g.draw(p, 1); g.addActions(2); },
  },
  woodwright: {
    name: 'Woodwright', cost: 3, types: ['action'], art: '🪓',
    text: 'Gain a card costing up to 4.',
    *play(g, p) {
      const pile = yield g.askSupply(p, { maxCost: 4, optional: false, prompt: 'Woodwright: gain a card costing up to 4.' });
      if (pile) g.gain(p, pile);
    },
  },
  tollbridge: {
    name: 'Toll Bridge', cost: 3, types: ['action'], art: '🌉',
    text: '+1 Buy, +2 Coins.',
    *play(g, p) { g.addBuys(1); g.addCoins(2); },
  },
  scriptorium: {
    name: 'Scriptorium', cost: 4, types: ['action'], art: '📜',
    text: '+3 Cards.',
    *play(g, p) { g.draw(p, 3); },
  },
  raiders: {
    name: 'Raiders', cost: 4, types: ['action', 'attack'], art: '🏴',
    text: '+2 Coins. Each other player discards down to 3 cards in hand.',
    *play(g, p) {
      g.addCoins(2);
      yield* g.attack(p, function* (t) {
        const h = g.players[t].hand;
        if (h.length <= 3) return;
        const k = h.length - 3;
        const pick = yield g.askCards(t, { min: k, max: k, prompt: `Raiders! Discard ${k} card${k > 1 ? 's' : ''}.`, verb: 'Discard' });
        g.discardFromHand(t, pick);
        g.log(`${g.nm(t)} discards ${k}.`);
      });
    },
  },
  moneychanger: {
    name: 'Moneychanger', cost: 4, types: ['action'], art: '⚖️',
    text: '+1 Buy. You may trash a Copper from your hand for +3 Coins.',
    *play(g, p) {
      g.addBuys(1);
      const i = g.players[p].hand.indexOf('copper');
      if (i < 0) return;
      const yes = yield g.askYesNo(p, { prompt: 'Moneychanger: trash a Copper for +3 Coins?' });
      if (yes) { g.trashFromHand(p, [g.players[p].hand.indexOf('copper')]); g.addCoins(3); }
    },
  },
  renovation: {
    name: 'Renovation', cost: 4, types: ['action'], art: '🔨',
    text: 'Trash a card from your hand. Gain a card costing up to 2 more than it.',
    *play(g, p) {
      if (!g.players[p].hand.length) return;
      const pick = yield g.askCards(p, { min: 1, max: 1, prompt: 'Renovation: trash a card.', verb: 'Trash' });
      const id = g.players[p].hand[pick[0]];
      g.trashFromHand(p, pick);
      const pile = yield g.askSupply(p, { maxCost: g.cost(id) + 2, optional: false, prompt: `Renovation: gain a card costing up to ${g.cost(id) + 2}.` });
      if (pile) g.gain(p, pile);
    },
  },
  orchard: {
    name: 'Orchard', cost: 4, types: ['victory'], art: '🍎',
    text: 'Worth 1 VP for every 8 cards you own (round down).',
    vp: (g, p) => Math.floor(g.allCards(p).length / 8),
  },
  coronation: {
    name: 'Coronation Hall', cost: 4, types: ['action'], art: '🎺',
    text: 'You may play an Action card from your hand twice.',
    *play(g, p) {
      const hand = g.players[p].hand;
      if (!hand.some(id => g.is(id, 'action'))) return;
      const pick = yield g.askCards(p, { min: 0, max: 1, filter: 'action', prompt: 'Coronation Hall: choose an Action to play twice.', verb: 'Play twice' });
      if (!pick.length) return;
      const id = hand.splice(pick[0], 1)[0];
      g.players[p].inPlay.push(id);
      g.log(`${g.nm(p)} crowns ${g.cn(id)}.`);
      yield* g.resolve(p, id);
      yield* g.resolve(p, id);
    },
  },
  bazaar: {
    name: 'Grand Bazaar', cost: 5, types: ['action'], art: '🎪',
    text: '+1 Card, +1 Action, +1 Buy, +1 Coin.',
    *play(g, p) { g.draw(p, 1); g.addActions(1); g.addBuys(1); g.addCoins(1); },
  },
  library: {
    name: 'Arcane Library', cost: 5, types: ['action'], art: '📚',
    text: '+2 Cards, +1 Action.',
    *play(g, p) { g.draw(p, 2); g.addActions(1); },
  },
  hexmonger: {
    name: 'Hexmonger', cost: 5, types: ['action', 'attack'], art: '🧙',
    text: '+2 Cards. Each other player gains a Blight.',
    *play(g, p) {
      g.draw(p, 2);
      yield* g.attack(p, function* (t) {
        if (g.supply.blight > 0) { g.gain(t, 'blight'); }
      });
    },
  },
  warcouncil: {
    name: 'War Council', cost: 5, types: ['action'], art: '⚔️',
    text: '+4 Cards, +1 Buy. Each other player draws a card.',
    *play(g, p) {
      g.draw(p, 4); g.addBuys(1);
      for (const t of g.others(p)) g.draw(t, 1);
    },
  },
  goldmine: {
    name: 'Gold Mine', cost: 5, types: ['action'], art: '⛏️',
    text: 'You may trash a Treasure from your hand. Gain a Treasure costing up to 3 more, into your hand.',
    *play(g, p) {
      if (!g.players[p].hand.some(id => g.is(id, 'treasure'))) return;
      const pick = yield g.askCards(p, { min: 0, max: 1, filter: 'treasure', prompt: 'Gold Mine: trash a Treasure to upgrade it?', verb: 'Upgrade' });
      if (!pick.length) return;
      const id = g.players[p].hand[pick[0]];
      g.trashFromHand(p, pick);
      const pile = yield g.askSupply(p, { maxCost: g.cost(id) + 3, filter: 'treasure', optional: false, prompt: `Gold Mine: gain a Treasure costing up to ${g.cost(id) + 3} into your hand.` });
      if (pile) g.gain(p, pile, 'hand');
    },
  },
  jubilee: {
    name: 'Jubilee', cost: 5, types: ['action'], art: '🎉',
    text: '+2 Actions, +1 Buy, +2 Coins.',
    *play(g, p) { g.addActions(2); g.addBuys(1); g.addCoins(2); },
  },
  guild: {
    name: "Architect's Guild", cost: 6, types: ['action'], art: '🏛️',
    text: 'Gain a card costing up to 5 into your hand. Then put a card from your hand on top of your deck.',
    *play(g, p) {
      const pile = yield g.askSupply(p, { maxCost: 5, optional: false, prompt: "Architect's Guild: gain a card costing up to 5 into your hand." });
      if (pile) g.gain(p, pile, 'hand');
      if (!g.players[p].hand.length) return;
      const pick = yield g.askCards(p, { min: 1, max: 1, prompt: 'Put a card from your hand on top of your deck.', verb: 'Top-deck' });
      const id = g.players[p].hand.splice(pick[0], 1)[0];
      g.players[p].deck.push(id);
    },
  },
};

export const KINGDOM = Object.keys(CARDS).filter(k => !BASE.includes(k));

export const PRESETS = {
  'First Crown (beginner)': ['crossroads', 'tollbridge', 'woodwright', 'scriptorium', 'renovation', 'orchard', 'bazaar', 'library', 'jubilee', 'palisade'],
  'Iron & Hex (attacks)': ['palisade', 'shrine', 'crossroads', 'raiders', 'coronation', 'moneychanger', 'hexmonger', 'warcouncil', 'goldmine', 'guild'],
  'Merchant Princes': ['gatehouse', 'tollbridge', 'moneychanger', 'coronation', 'bazaar', 'goldmine', 'jubilee', 'guild', 'orchard', 'woodwright'],
};
