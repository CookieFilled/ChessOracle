# ChessOracle — Live Engine Assistant & Elo Bot

A browser extension (Chrome / Edge, Manifest V3) that adds real-time Stockfish analysis,
move suggestions, an Elo-matched autoplay engine and a **hands-free Autopilot session
mode** to **chess.com** and **lichess.org**.

Everything runs **100% locally**: Stockfish 18 (WASM) is bundled with the extension.
No accounts, no network calls, no telemetry.

---

## Features

### Live analysis
- **Best-move arrows** (1–3 arrows, green = best, blue = 2nd, grey = 3rd)
- **Evaluation bar** beside the board with numeric eval and search depth
- **Threat arrow** (optional, red): what the opponent is about to play
- **Move badges**: brilliant / great / best / excellent / good / inaccuracy / mistake / blunder
- **Live accuracy** for both players (lichess-style formula) + eval graph + move log
- Click any move in the log to flash it on the board

### Autoplay (Elo bot, 400–2900)
- Plays as you at a selected strength with **human-like imperfections**:
  - Elo-mapped engine depth, skill and time
  - Blunder / mistake / inaccuracy rate sliders (auto per-Elo or fully manual)
  - Randomness slider (variety among equal moves)
  - **"Never lose a game"** safety floor — risky human slips are filtered while ahead
  - Risk tolerance slider
- **Opening book** (~76 main lines, variety slider)
- **Human timing**: lognormal think times with rare "deep thinks", near-instant
  replies in forced positions, clock-aware in time trouble, faster opening moves,
  complexity-based modifiers — and the mouse itself is human: drags grab the
  piece, wobble slightly, and drop inside the square; ~1 in 4 moves is played
  click-click style like a real person
- Play as auto / white / black, one-move "Play best" button
- **Color auto-detection** with a live "Detected: you play White/Black" note in
  the panel — re-checked continuously (handles picking black after the page
  loaded, board flips, and games joined late)

### Autopilot sessions (chess.com) — v1.2.0
Plays **whole sessions by itself**: finishes each game, takes a human break, clicks
"New 10 min" / "New Game", and keeps going — like a real player grinding games.

- **Session plan** (togglable):
  - **Mixed** — wins a configurable share of games (~62% by default), loses the rest,
    with a streak cap so it never looks robotic
  - **Win all** — plays above your set Elo, fights back when a game slips
  - **Lose all** — plays below your set Elo with the safety floor off, gradual
    human-looking slips, and realistic resignations of lost games
- The **Elo slider stays the boss**: win/lose plans modulate around whatever
  strength you picked, so the play style always matches your setting
- **Arena**: play real people ("New 10 min" re-queue) or bots — switchable
- **Never sends rematch challenges** by default (they stall the session when the
  opponent doesn't accept); Rematch is only used as a fallback on bot pages
- **Realism layer**: resign-when-lost probability, minimum resign move, plausible
  mistake escalation (never an instant giveaway), occasional 25–70s "coffee breaks"
- **Session stats**: games / won / lost / drawn, streaks, per-game plan — shown in
  the panel's Autopilot tab and in the popup
- **Games limit** (endless or N games), configurable break length
- Self-healing: dismisses blocking popups, guest sign-in for fresh profiles,
  queue-aware waiting (never navigates away mid-search), declined-challenge
  cancellation, arena re-queue when a finished game view wedges, frozen-game
  recovery, and it never burns the session on a single jammed game

### Coach
- Hanging-piece rings, blunder alerts, optional sound
- On-demand hint (Alt+H)

### Extras
- Glass-style floating panel (dark/light, draggable, collapsible to a pill)
- Browser-action popup with quick controls (incl. autopilot on/off + plan)
- PGN export with move-quality comments
- Keyboard shortcuts: Alt+H hint · Alt+B autoplay · Alt+O autopilot · Alt+A arrows · Alt+P panel

---

## Installation (Edge or Chrome, developer mode)

1. **Unzip** `ChessOracle_v1.2.1.zip` — you get a folder named `ChessOracle`.
2. Open **Edge**: `edge://extensions` (or Chrome: `chrome://extensions`).
3. Turn on **Developer mode** (left sidebar / top right toggle).
4. Click **Load unpacked** and select the unzipped `ChessOracle` folder
   (the one that directly contains `manifest.json`).
   Upgrading from 1.0.x: hit **Reload** ↻ on the ChessOracle card, then refresh
   your chess tabs. Your settings are preserved.
5. (Optional) Pin the icon via the puzzle-piece menu.

First engine start takes ~1–3 seconds after loading a chess page.

### Quick start
1. Open any game on chess.com or lichess (e.g. *Play vs computer*).
2. The ChessOracle panel appears in the bottom-left corner (drag it anywhere).
   Open the **Play** tab.
3. Set your target Elo, flip **Autoplay**, and watch it play like a human —
   it detects your color automatically, white **and black**.
4. For full hands-free sessions open the **Autopilot** tab, pick a plan
   (Mixed / Win all / Lose all), flip **AUTOPILOT**, and leave it running.
   Or leave autoplay off and enjoy the arrows, eval bar and move badges.

---

## How strength works

The Elo slider (400–2900) drives three coordinated layers:

| Layer | What it does |
|---|---|
| Engine limits | depth / movetime / Stockfish Skill mapped from Elo (+ a small strength bias) |
| Selection policy | per-move probability of inaccuracy / mistake / blunder, then a *plausible* move inside that eval-loss window — real oversights, not random garbage |
| Safety floor | when you're winning, moves that would throw the game are filtered (toggleable, tunable via Risk) |

When losing, the bot automatically tries harder (like real humans). When winning
big, it allows slightly sloppy moves (unless the safety floor is strict).

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Panel doesn't appear | Reload the chess page once after install. Check the site is chess.com or lichess.org. |
| "engine starting…" never turns green | Reload the page. Requires Chrome/Edge 116+. Check `edge://extensions` → ChessOracle → errors. |
| Autoplay not moving | Make sure it's your turn. Check the "Detected: you play …" note under **Play as** — if the color is wrong, set Play as to White/Black manually. Press Alt+P if the panel is hidden. |
| Autopilot not re-queuing games | It clicks the modal's **"New 10 min"** / "New Game" button (never "Rematch" on live games). If a finished game view wedges without the modal, it heads back to the arena lobby and re-queues from there after ~30s. Autopilot is chess.com-only. |
| Panel covers something | Drag it by its title bar; position is remembered. "Reset panel position" is in the Data tab. |
| Both sites at once? | Works, but engine requests are serialized — one active game gives the snappiest experience. |

---

## What's new in 1.2.1 — promotion fix

- **Fixed: every promotion became a bishop.** chess.com's promotion picker
  renders its options in the DOM order **Bishop, Knight, Queen, Rook**, but the
  picker click used a positional index that assumed Queen-first — so every
  pawn promotion clicked the **bishop** (usually costing the game). Piece
  selection is now **token-based**: the option whose class token matches the
  wanted piece (`wq` / `bq` / `q` / `queen`…) is clicked, which is
  order-independent and works for both colors and all four pieces. Verified
  against the live picker DOM on chess.com.
- **Fixed: the board mirror lost the promotion move** (the source of the
  “moved but the timer still waits / the piece never moved” glitch family).
  chess.com parks the pawn *on* the promotion square while the picker is
  open — that intermediate board state matches no legal move, so the move
  tracker skipped it and then couldn't interpret the pawn→piece swap either,
  leaving the internal position one ply behind reality. The tracker now
  re-runs move inference against its own last-registered position and
  recovers the promotion exactly (works for underpromotions and captures
  onto the promotion square too).
- **Never drags into an open promotion picker**: if a picker is already open
  when a move retry starts (stale dialog, recovered glitch), the pending
  promotion is completed first instead of letting the drag land on the
  picker's options.
- **Human realism**: sub-optimal moves (mistakes/blunders/sabotage) never
  underpromote — a human blunders by picking a worse *queen* promotion, not
  by promoting to a bishop. The engine's own best line is untouched (rare
  tactical knight/rook promotions stay).

## What's new in 1.2.0 — live-game hardening, human feel

- **Fixed: next-game button.** On live (vs human) games chess.com's modal button
  reads **"New 10 min"**, not "New Game" — the old matcher missed it and fell
  through to **Rematch**, sending a challenge to the same person and stalling the
  session when they didn't accept. The new matcher understands the whole
  "New <time control> / New Game / New Bot" family and never resolves to a
  rematch or challenge button (verified against the live modal DOM).
- **Fixed: the "moved but the clock still waits" glitch.** If the internal board
  mirror desynced from the server, a drag could land while it was actually the
  opponent's turn — chess.com stores that as an unregistered **premove**: the piece
  visually moves, the clock keeps waiting, and on resignation the piece snaps
  back having "never moved". Now every move is gated and verified against the
  server's own game state (turn + FEN + move history via the site SDK): the
  executor refuses to move on a stale mirror, cancels any premove that slips
  through, and rebuilds the mirror from the server's move list.
- **Fixed: resignations on live games.** The SDK resign silently no-ops there —
  and worse, the game-over modal never renders. Autopilot now resigns through
  the real UI (sidebar Resign → confirmation popover), which also makes the
  result modal appear so the outcome is parsed correctly (win/loss/draw).
- **Lose-all mode** is clearly exposed in the panel (with a live description) and
  the popup; mixed mode describes its target win rate.
- **Arena setting**: autopilot plays real people by default ("New 10 min"
  re-queue) or bots — your choice in the Autopilot tab.
- **More human than ever**: lognormal think times with rare deep thinks, snap
  replies in forced positions, human-paced mouse drags (grab → wobble → drop
  inside the square) with click-click moves mixed in, guest sign-in handling,
  queue-aware waiting, and lobby detection (never engages the demo board).
- Session loop hardening: no reload loops, declined-challenge cancellation,
  stuck-queue bail-out, arena re-queue fallback.

## What's new in 1.1.0 — Autopilot sessions

- New **Autopilot mode** (chess.com): the extension plays full sessions on its own —
  game after game — with a togglable outcome plan (mixed win-rate / win all /
  lose all) built on top of the same Elo-matched play style. See *Features* above.
- Outcome plans are best-effort and realistic by design: losses come from
  weakened play, plausible mistakes and resignations — never instant give-ups.
  (Against very weak bots a planned loss can still end as a win when the bot
  resigns while losing — the session records the honest result.)
- Session stats (W/L/D, streaks, games) persist across reloads and are visible
  in the panel and the popup.
- Self-healing loop: popup dismissal, setup-screen game start, frozen-game
  recovery, auto-navigation back to the board.
- Panel now has five tabs; Alt+O toggles autopilot anywhere on the page.

## What's new in 1.0.1 — Black-side fix

Playing as **black** previously confused the extension: the playing color was
read exactly once at startup, so if you picked black after the page loaded
(or a game assigned you black late), it kept thinking it was white — waiting
on your turns and trying to move the opponent's pieces until it gave up.

- The color is now re-detected continuously (chess.com's game SDK via a
  main-world bridge, lichess board orientation) and shown live in the panel.
- Autoplay refuses to move pieces that aren't yours and self-heals instead of
  burning retries; the color is locked once a move of yours is confirmed.
- Moves on chess.com are executed through the real drag event flow first
  (this is what triggers the site bot's reply); the SDK path is a fallback.
- The panel now defaults to the bottom-left corner (out of the way of the
  sites' game controls) and scrolls internally instead of overflowing.

---

## Privacy & responsible use

- All analysis is local. The extension makes **no** network requests of its own.
- Chess.com and lichess prohibit engine assistance in rated games — their terms apply.
  Best enjoyed in bot games, casual/unrated play, training, and analysis.

## Credits & licenses

- **Stockfish 18 (WASM)** — GPLv3, © the Stockfish developers; NNUE net by Linmiao Xu
  (bundled from the nmrugg/stockfish.js npm package)
- **chess.js 0.10.3** — MIT, © Jeff Hlywa
- ChessOracle code — use freely, attribution appreciated.

ChessOracle v1.2.1
