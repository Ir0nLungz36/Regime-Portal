# ⬡ GEX EDGE — Dealer Positioning Interpreter

> Independent institutional dealer analysis dashboard · GitHub Pages · Polygon.io Options Starter

---

## What Makes This Different From INSTMAP

| INSTMAP | GEX EDGE |
|---------|---------|
| Flow dashboard | Dealer positioning interpreter |
| Identifies setup type | Quantifies dealer control |
| 5-layer analysis | 7 institutional metrics |
| Playbook classification | Control zone + edge zone mapping |

---

## The 7 New Institutional Metrics

### 1. Dealer Control Meter (0–100)
Composite of gamma magnitude, wall proximity, OI density, and range compression. Equivalent to GEX Edge's institutional suppression score.

| Score | Meaning |
|-------|---------|
| 0–30 | Free expansion mode |
| 30–60 | Moderate suppression |
| 60–80 | Strong pinning |
| 80–100 | Full dealer control |

### 2. Pin Pressure Score (0–100)
Six-factor model: distance to max pain, call wall, gamma flip, net gamma magnitude, OI concentration, expected move compression.

### 3. Control Zone Width
Identifies `price ± X` band where dealer gamma dominance is highest. **Avoid momentum chasing inside this zone.**

### 4. Range Compression %
`Wall Width (Put→Call) ÷ Expected Move (1σ)`
- < 1.0x = Chop trap — expansion impossible
- 1.0–1.5x = Possible breakout
- > 2.5x = Free expansion mode

### 5. Wall Strength Score
Ranks each wall by OI concentration:
- **WEAK** — < 6% of total chain OI
- **MODERATE** — 6–12%
- **HARD CEILING** — 12–20%
- **NUCLEAR WALL** — > 20% (pulsing red alert)

### 6. Mid-Range Warning + Edge Zone Map
Visual positioning of current price vs put wall / dead zone / call wall. Flags when price is in the retail trap zone where dealers harvest premium.

### 7. Expansion Likelihood %
10-factor checklist (5 suppressors + 5 accelerators) → outputs LOW / MODERATE / HIGH with explicit action guidance.

---

## Deployment

### GitHub Pages (same as INSTMAP)

```bash
# Create a NEW repo (separate from INSTMAP)
git init
git add .
git commit -m "GEX EDGE v1.0"
git remote add origin https://github.com/YOUR_USERNAME/gex-edge.git
git push -u origin main
```

Settings → Pages → Deploy from main → root `/` → Save

Live at: `https://YOUR_USERNAME.github.io/gex-edge`

---

## API Endpoints Used

All confirmed on Options Starter plan:

| Endpoint | Purpose |
|----------|---------|
| `GET /v3/snapshot/options/{underlying}` | Full option chain (paginated) |
| `GET /v2/aggs/ticker/{ticker}/prev` | Prev day OHLCV for SPY/QQQ/ticker/VIX |
| `GET /v1/indicators/ema/{ticker}` | EMA 20 + EMA 50 |
| `GET /v1/indicators/rsi/{ticker}` | RSI 14 |
| `WS /options/AM` | Live option minute bars |

**Zero calls to blocked endpoints** — no `/range`, no `/snapshot/locale/us/markets/stocks` (403 on Options plan).

---

## How to Use

1. Enter your Polygon.io API key (saved to localStorage)
2. Enter ticker (SPY, IWM, QQQ, or any optionable stock)
3. Click **◈ SCAN**
4. Auto-refreshes every 120 seconds

### Reading the Dashboard

**Top priority: Dealer Control Meter**
- ≥ 70 = don't chase. Trade wall rejections only.
- ≤ 30 = expansion is possible. Look for Firecracker/Magnet Run in INSTMAP.

**Second: Edge Zone Map**
- Mid-Range = avoid. Retail trap. Dealers harvest premium here.
- Call Wall Zone = fade or put entry
- Put Wall Zone = buy dip or call entry

**Third: Expansion Likelihood**
- Use this to validate setups from INSTMAP
- HIGH (≥70%) = Firecracker/Magnet Run setups are valid
- LOW (<35%) = Pin Risk/Chop. Stay defensive.

---

## Using GEX EDGE + INSTMAP Together

```text
GEX EDGE:
  Dealer Control: 35/100 (low suppression)
  Pin Pressure: 28/100 (minimal pin)
  Expansion: HIGH (72%)
  Edge Zone: PUT WALL ZONE

↓

INSTMAP confirms:
  MAGNET RUN active
  Above max pain
  Call staircase: 285→287→290→292

= A+ institutional setup
```

```text
GEX EDGE:
  Dealer Control: 78/100 (strong control)
  Pin Pressure: 64/100 (high pin)
  Expansion: LOW (22%)
  Edge Zone: MID-RANGE WARNING

↓

INSTMAP shows:
  PIN RISK active
  CHOP DAY

= Stay flat. Both systems say the same thing.
```

---

*GEX EDGE v1.0 · Not financial advice · Educational use only*
