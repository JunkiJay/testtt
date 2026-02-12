/* global Telegram */

(() => {
  const tg = window.Telegram?.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
  }

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  const elMult = document.getElementById("mult");
  const elStatus = document.getElementById("status");
  const elHistory = document.getElementById("history");

  const elBet = document.getElementById("bet");
  const elAuto = document.getElementById("auto");
  const btnStart = document.getElementById("btnStart");
  const btnCash = document.getElementById("btnCash");
  const elPanel = document.getElementById("panel");

  let W = 0;
  let H = 0;
  let raf = 0;
  let panelTop = 0;
  let safeBottom = 0;

  // ----- Provably-ish crash (deterministic from seed) -----
  const B52 = 2n ** 52n;
  const HOUSE_EDGE_BPS = 350n; // 3.50%

  function b64urlToBytes(s) {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToHex(bytes) {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function sha256Hex(str) {
    const enc = new TextEncoder().encode(str);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return bytesToHex(new Uint8Array(buf));
  }

  // volatility: integer 1..5 (1 = high volatility (more big), 5 = low (more small))
  function crashX100FromSeedInt52(int52, volatilityK) {
    let r = BigInt(int52); // scaled by 2^52
    let rPow = r;
    for (let i = 1; i < volatilityK; i++) {
      rPow = (rPow * r) >> 52n;
    }
    const denom = B52 - rPow;
    if (denom <= 0n) return 100; // 1.00x

    const numerator = (10000n - HOUSE_EDGE_BPS) * 100n * B52;
    const denominator = 10000n * denom;
    let x100 = Number(numerator / denominator);
    if (!Number.isFinite(x100)) x100 = 100;
    if (x100 < 100) x100 = 100;
    if (x100 > 50000) x100 = 50000; // cap 500.00x
    return x100;
  }

  async function crashX100FromSeed(seed, volatilityK) {
    const hex = await sha256Hex(seed);
    // take first 7 bytes = 56 bits, shift >> 4 => 52 bits
    const first14 = hex.slice(0, 14);
    const v56 = BigInt("0x" + first14);
    const int52 = Number(v56 >> 4n);
    return crashX100FromSeedInt52(int52, volatilityK);
  }

  // multiplier curve: 1 + a * (t_s ^ b)
  const CURVE_A = 0.62;
  const CURVE_B = 1.25;
  function multAtMs(ms) {
    const t = Math.max(0, ms) / 1000;
    return 1 + CURVE_A * Math.pow(t, CURVE_B);
  }
  function msForMult(m) {
    const x = Math.max(0, (m - 1) / CURVE_A);
    return Math.pow(x, 1 / CURVE_B) * 1000;
  }

  function fmtX(x) {
    return `${x.toFixed(2)}×`;
  }

  function parseMoneyLike(s) {
    const t = String(s || "").trim().replace(",", ".");
    if (!t) return null;
    const v = Number(t);
    if (!Number.isFinite(v)) return null;
    return v;
  }

  function beep(type) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ac = new AudioCtx();
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = "sine";
      if (type === "start") o.frequency.value = 220;
      else if (type === "cash") o.frequency.value = 740;
      else o.frequency.value = 120;
      g.gain.value = type === "crash" ? 0.12 : 0.06;
      o.connect(g);
      g.connect(ac.destination);
      o.start();
      o.stop(ac.currentTime + (type === "crash" ? 0.12 : 0.06));
      setTimeout(() => ac.close(), 200);
    } catch (_) {
      // ignore
    }
  }

  function addHistoryChip(multX100, kind) {
    const div = document.createElement("div");
    div.className = `chip ${kind}`;
    div.textContent = `${(multX100 / 100).toFixed(2)}×`;
    elHistory.prepend(div);
    while (elHistory.children.length > 12) elHistory.removeChild(elHistory.lastChild);
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function resize() {
    W = Math.floor(window.innerWidth);
    H = Math.floor(window.innerHeight);
    canvas.width = Math.floor(W * devicePixelRatio);
    canvas.height = Math.floor(H * devicePixelRatio);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

    const rect = elPanel?.getBoundingClientRect?.();
    panelTop = rect ? rect.top : H;
    safeBottom = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-bottom") || "0") || 0;
  }

  const round = {
    token: null,
    seed: null,
    volK: 3, // 1..5
    running: false,
    startedAt: 0,
    crashX100: 0,
    crashMs: 0,
    bet: 0,
    autoX100: null,
    playerCashedOut: false,
    cashoutMs: null,
    sent: false,
  };

  function setupNewCrashRound({ keepToken = true } = {}) {
    // Generate a new random seed every round (no page refresh needed)
    if (!keepToken) round.token = null;
    round.seed = randomSeedHex(16);
    // volK is already set from token (if any) or defaults to 3
    return crashX100FromSeed(round.seed, round.volK).then((crashX100) => {
      round.crashX100 = crashX100;
      round.crashMs = msForMult(crashX100 / 100);
    });
  }

  function getPlayBottomY() {
    // Keep rocket above the bottom panel
    const bottom = Math.min(panelTop - 12, H - 12 - safeBottom);
    return clamp(bottom, 200, H);
  }

  function drawRocket(x, y, t, running, crashed) {
    const scale = clamp(W / 430, 0.85, 1.15);
    ctx.save();
    ctx.translate(x, y);
    // slight tilt up-right
    ctx.rotate(-0.12);
    ctx.scale(scale, scale);

    // flame
    const flameLen = running ? 30 + 8 * Math.sin(t / 80) : 10;
    ctx.globalAlpha = running ? 0.95 : 0.35;
    const flame = ctx.createLinearGradient(-28 - flameLen, 0, -28, 0);
    flame.addColorStop(0, "rgba(255,61,141,0)");
    flame.addColorStop(0.55, "rgba(255,212,59,0.85)");
    flame.addColorStop(1, "rgba(48,209,255,0.85)");
    ctx.fillStyle = flame;
    ctx.beginPath();
    ctx.moveTo(-28, 0);
    ctx.quadraticCurveTo(-28 - flameLen * 0.55, 10, -28 - flameLen, 0);
    ctx.quadraticCurveTo(-28 - flameLen * 0.55, -10, -28, 0);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    // body
    const body = ctx.createLinearGradient(-10, -26, 34, 26);
    body.addColorStop(0, "#30d1ff");
    body.addColorStop(1, "#ff3d8d");
    ctx.fillStyle = body;
    roundRect(ctx, -14, -16, 56, 32, 16);
    ctx.fill();

    // nose cone
    ctx.fillStyle = "#e9f0ff";
    ctx.beginPath();
    ctx.moveTo(42, 0);
    ctx.lineTo(62, 11);
    ctx.lineTo(62, -11);
    ctx.closePath();
    ctx.fill();

    // fins
    ctx.fillStyle = "rgba(233,240,255,0.9)";
    ctx.beginPath();
    ctx.moveTo(0, 14);
    ctx.lineTo(14, 14);
    ctx.lineTo(6, 28);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -14);
    ctx.lineTo(14, -14);
    ctx.lineTo(6, -28);
    ctx.closePath();
    ctx.fill();

    // window
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = "#0b0f14";
    ctx.beginPath();
    ctx.arc(10, 0, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    if (crashed) {
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = "rgba(255,77,77,0.22)";
      ctx.beginPath();
      ctx.arc(30, 0, 44, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  function draw() {
    ctx.fillStyle = "#0b0f14";
    ctx.fillRect(0, 0, W, H);

    // sky gradient
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "rgba(48,209,255,0.14)");
    g.addColorStop(1, "rgba(255,61,141,0.02)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // subtle grid
    ctx.globalAlpha = 0.07;
    ctx.strokeStyle = "#30d1ff";
    ctx.lineWidth = 1;
    const step = 36;
    for (let y = 0; y < H; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // rocket position based on multiplier
    const t = round.running ? performance.now() - round.startedAt : 0;
    const m = round.running ? multAtMs(t) : 1;
    const yNorm = Math.log10(Math.max(1, m)) / Math.log10(50); // 0..1
    const playBottom = getPlayBottomY();
    const y = clamp(playBottom - 70 - yNorm * (playBottom - 180), 90, playBottom - 60);
    const x = W * 0.32 + yNorm * (W * 0.35);

    // trail
    ctx.globalAlpha = round.running ? 0.8 : 0.35;
    const trail = ctx.createLinearGradient(x - 120, y + 12, x, y + 12);
    trail.addColorStop(0, "rgba(255,61,141,0)");
    trail.addColorStop(1, "rgba(255,61,141,0.45)");
    ctx.strokeStyle = trail;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(x - 120, y + 20);
    ctx.lineTo(x - 20, y + 20);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // rocket (fuller look)
    drawRocket(x, y, performance.now(), round.running, !round.running && round.crashX100 > 0 && !round.playerCashedOut);
  }

  function loop(ts) {
    if (!round.running) return;
    const elapsed = ts - round.startedAt;
    const m = multAtMs(elapsed);
    elMult.textContent = fmtX(m);

    // crash?
    if (elapsed >= round.crashMs) {
      round.running = false;
      const playerWon = round.playerCashedOut;
      elMult.textContent = fmtX(round.crashX100 / 100);
      elStatus.textContent = playerWon ? `💥 Crash на ${fmtX(round.crashX100 / 100)}.` : "💥 Crash! Ставка сгорела.";
      btnStart.disabled = false;
      btnCash.disabled = true;
      beep("crash");
      // History should show crash multipliers
      addHistoryChip(round.crashX100, round.crashX100 >= 200 ? "good" : "bad");
      if (!round.sent && !playerWon) {
        round.sent = true;
        sendResultToBot({ cashed_out: false, cashout_ms: Math.floor(round.crashMs) });
      }
      draw();
      return;
    }

    // auto cashout
    if (!round.playerCashedOut && round.autoX100 && Math.floor(m * 100) >= round.autoX100) {
      doCashOut(elapsed, true);
    }

    draw();
    raf = requestAnimationFrame(loop);
  }

  function roundRect(ctx2, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx2.beginPath();
    ctx2.moveTo(x + rr, y);
    ctx2.arcTo(x + w, y, x + w, y + h, rr);
    ctx2.arcTo(x + w, y + h, x, y + h, rr);
    ctx2.arcTo(x, y + h, x, y, rr);
    ctx2.arcTo(x, y, x + w, y, rr);
    ctx2.closePath();
  }

  function readTokenFromUrl() {
    const url = new URL(window.location.href);
    const t = url.searchParams.get("t");
    if (!t || !t.includes(".")) return null;
    return t;
  }

  function randomSeedHex(bytesLen = 16) {
    const bytes = new Uint8Array(bytesLen);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function decodeTokenPayload(token) {
    const [p] = token.split(".");
    const bytes = b64urlToBytes(p);
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json);
  }

  async function prepareRoundFromToken() {
    const token = readTokenFromUrl();
    if (!token) {
      // Temporary mode: allow playing without backend-issued token
      round.token = null;
      round.volK = 3;
      await setupNewCrashRound({ keepToken: false });
      elStatus.textContent =
        "Режим без токена: коэффициент раунда генерируется локально. Введи ставку и нажми Start.";
      btnStart.disabled = false;
      return;
    }

    round.token = token;

    const payload = decodeTokenPayload(token);
    // We keep token only for identification, but generate a fresh seed each round
    const vol = Number(payload.vol || 0.6);
    if (!Number.isFinite(vol)) throw new Error("bad volatility");
    // map vol 0..1 to k 5..1
    round.volK = clamp(5 - Math.round(vol * 4), 1, 5);

    await setupNewCrashRound({ keepToken: true });

    elStatus.textContent = "Готово. Введи ставку и нажми Start.";
  }

  function doStart() {
    if (round.running) return;
    const bet = parseMoneyLike(elBet.value);
    if (bet === null || bet <= 0) {
      elStatus.textContent = "Ставка должна быть > 0";
      return;
    }
    const auto = parseMoneyLike(elAuto.value);
    // New crash coefficient each Start, without page refresh
    btnStart.disabled = true;
    btnCash.disabled = true;
    elStatus.textContent = "Подготовка раунда…";

    setupNewCrashRound({ keepToken: true })
      .then(() => {
        round.bet = bet;
        round.autoX100 = auto && auto >= 1.01 ? Math.floor(auto * 100) : null;
        round.startedAt = performance.now();
        round.running = true;
        round.playerCashedOut = false;
        round.cashoutMs = null;
        round.sent = false;

        btnStart.disabled = true;
        btnCash.disabled = false;
        elStatus.textContent = "Ракета летит… успей забрать!";
        beep("start");
        raf = requestAnimationFrame(loop);
      })
      .catch((e) => {
        elStatus.textContent = `Ошибка подготовки: ${String(e)}`;
        btnStart.disabled = false;
        btnCash.disabled = true;
      });
  }

  function doCashOut(elapsedMs, isAuto) {
    if (!round.running || round.playerCashedOut) return;
    round.playerCashedOut = true;
    round.cashoutMs = Math.floor(elapsedMs);

    const m = multAtMs(elapsedMs);
    const mX100 = Math.floor(m * 100);
    btnStart.disabled = true;
    btnCash.disabled = true;
    beep("cash");

    const win = round.bet * (mX100 / 100);
    elStatus.textContent = `${isAuto ? "🤖 " : ""}Cash Out на ${fmtX(mX100 / 100)}. Выигрыш: ${win.toFixed(2)}. Ждём crash…`;

    if (!round.sent) {
      round.sent = true;
      sendResultToBot({ cashed_out: true, cashout_ms: round.cashoutMs });
    }
    draw();
  }

  function sendResultToBot(extra) {
    try {
      const payload = {
        kind: "crash_v1",
        ...(round.token ? { t: round.token } : {}),
        seed: round.seed,
        volatility: 0.6,
        bet: round.bet,
        auto_x100: round.autoX100,
        ...extra,
        init_data: tg?.initData || "",
      };
      if (tg) {
        tg.sendData(JSON.stringify(payload));
      } else {
        elStatus.textContent = `payload: ${JSON.stringify(payload)}`;
      }
    } catch (e) {
      elStatus.textContent = `Ошибка отправки: ${String(e)}`;
    }
  }

  btnStart.addEventListener("click", doStart);
  btnCash.addEventListener("click", () => doCashOut(performance.now() - round.startedAt, false));

  window.addEventListener("resize", resize);
  resize();
  elMult.textContent = "1.00×";
  elStatus.textContent = "Загрузка…";
  draw();
  prepareRoundFromToken().catch((e) => {
    elStatus.textContent = `Ошибка: ${String(e)}`;
    btnStart.disabled = true;
    btnCash.disabled = true;
  });
})();

