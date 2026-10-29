# Crownforge 👑

A multiplayer deck-building card game for phones, played in the browser. The mechanics are inspired by classic deck-builders; all cards, names and text are original.

- **2–6 players** online, each on their own phone. Bots can fill empty seats.
- **Solo mode** against 1–5 bots, which works offline once the page has loaded.
- **19 kingdom cards.** Each game uses 10 of them, either chosen at random or from one of 3 presets.
- **No server to run.** The site is plain static files on GitHub Pages. Phones connect directly to each other over WebRTC using [PeerJS](https://peerjs.com).
- **Rejoin after a disconnect.** Players who reload or lose signal can rejoin. The host can resume a game after a reload, because the game is saved on the host's phone and rebuilt from the move log.
- **Home-screen app.** You can add it to your home screen and it runs full-screen like an app (it's a PWA, a web page that installs like an app).

## Put it on GitHub Pages

1. Create a new **public** repo on GitHub, for example `crownforge`.
2. Upload everything in this folder, keeping the folder structure (`index.html`, `css/`, `js/`, `icons/`, …). You can drag and drop it in the GitHub web UI, or use git:
   ```bash
   git init && git add . && git commit -m "Crownforge"
   git branch -M main
   git remote add origin https://github.com/<you>/crownforge.git
   git push -u origin main
   ```
3. In the repo, go to **Settings → Pages → Build and deployment**. Set Source to **Deploy from a branch**, Branch to **main**, and the folder to **/ (root)**, then save.
4. After about a minute the game is live at `https://<you>.github.io/crownforge/`.

## Playing online

1. **Host:** enter your name, tap **Host a game** and share the 5-letter room code or the invite link. Add bots if you want, then tap **Start**.
2. **Others:** open the link, or enter the code and tap **Join**.
3. **Keep the host's screen on and the app in the foreground.** The host's phone runs the game. The app asks the phone to keep the screen awake, but if the host switches apps or locks the phone, other players are paused until the host returns.
4. If a player drops out, they reopen the site and tap **Rejoin**. If the host's page reloads, the host taps **Resume** and everyone else taps **Rejoin**.

## Network notes

- **Room codes:** PeerJS's free public broker (`0.peerjs.com`) matches room codes. It carries only connection setup, not gameplay. It has no uptime guarantee.
- **Mobile data:** phones on the same Wi-Fi almost always connect. Two phones on mobile data sometimes can't reach each other directly because of carrier NAT. In that case the connection needs a TURN relay. PeerJS 1.5.x ships with a free default TURN server, but I haven't been able to test it here, so treat it as best-effort. If joining hangs on "Connecting…", add your own TURN server in `js/config.js`. Metered.ca and Cloudflare Calls both have free tiers.
- **Self-hosting the broker:** you can run your own with `npx peer --port 9000` and point `peerServer` in `js/config.js` at it.
- **PeerJS loading:** PeerJS loads from the jsDelivr CDN, with unpkg as a fallback. To remove that dependency, download `peerjs.min.js` (version 1.5.5) into `js/` and change the `<script>` tag in `index.html` to point at it.

## Rules (short)

- **Setup:** everyone starts with 7 Copper and 3 Homestead and draws 5 cards.
- **Action phase:** you have 1 Action to play an Action card.
- **Buy phase:** play your treasures, then buy 1 card. Bought cards go to your discard pile.
- **Clean-up:** discard everything and draw 5 cards.
- **End:** the game ends when the Realm pile is empty, or 3 supply piles are empty (4 piles with 5–6 players). The most VP wins, and ties go to whoever took fewer turns.

| Players | Homestead / Barony / Realm | Blight |
|---|---|---|
| 2 | 8 each | 10 |
| 3–4 | 12 each | 20–30 |
| 5 | 15 each | 40 |
| 6 | 18 each | 50 |

## Modding

- **Cards** are in `js/cards.js`. Each card has a cost, types, display text, an emoji for art, and a `play` generator. Inside `play`, a `yield` asks a player to make a choice. To add a card, copy an existing one, give it a new key, and it joins the random pool automatically. Add it to the bot's lists in `js/bot.js` if you want bots to buy it.
- **Rules** are in `js/engine.js`. The engine is deterministic: the same seed and the same answers always replay the same game.
- **Tests:** `node tests/sim.js` plays 600 bot games with 2–6 players. It checks that no card is lost or duplicated, that every game finishes, and that replaying a game gives the same result.
- **Local multiplayer testing:** add `?fakenet=1&tok=A` to the URL in one tab and `?fakenet=1&tok=B` in another tab of the same browser. The tabs then talk over BroadcastChannel instead of WebRTC, so you need no internet. Serve the folder locally with `python3 -m http.server`, because opening `index.html` directly won't load the ES modules.

## Files

```
index.html            app shell
css/style.css         mobile-first styles
js/cards.js           card definitions + presets
js/engine.js          rules engine (deterministic, replayable)
js/bot.js             bot player
js/net.js             PeerJS host/client + heartbeat/reconnect (+ test transport)
js/config.js          network settings (TURN / broker)
js/app.js             UI, lobby, sessions
tests/sim.js          headless bot simulation
manifest.webmanifest  install-to-home-screen metadata
```
