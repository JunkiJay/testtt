/* global Telegram */

(() => {
  const tg = window.Telegram?.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
  }

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  const elScore = document.getElementById("score");
  const overlay = document.getElementById("overlay");
  const gameover = document.getElementById("gameover");
  const finalScoreEl = document.getElementById("finalScore");
  const sendHint = document.getElementById("sendHint");

  const btnStart = document.getElementById("btnStart");
  const btnAgain = document.getElementById("btnAgain");
  const btnSend = document.getElementById("btnSend");

  let W = 0;
  let H = 0;
  let raf = 0;

  const state = {
    running: false,
    score: 0,
    startTs: 0,
    lastTs: 0,
    paddle: {
      x: 0,
      y: 0,
      w: 120,
      h: 14,
    },
    balls: [],
    spawnedSecondBall: false,
    shrunkPaddle: false,
  };

  function resize() {
    W = Math.floor(window.innerWidth);
    H = Math.floor(window.innerHeight);
    canvas.width = Math.floor(W * devicePixelRatio);
    canvas.height = Math.floor(H * devicePixelRatio);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

    state.paddle.y = H - 28;
    state.paddle.x = Math.max(12, Math.min(W - state.paddle.w - 12, state.paddle.x));
  }

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function beep() {
    // lightweight "hit" sound using WebAudio
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ac = new AudioCtx();
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = "square";
      o.frequency.value = 540 + Math.random() * 60;
      g.gain.value = 0.06;
      o.connect(g);
      g.connect(ac.destination);
      o.start();
      o.stop(ac.currentTime + 0.04);
      setTimeout(() => ac.close(), 80);
    } catch (_) {
      // ignore
    }
  }

  function resetGame() {
    state.running = false;
    state.score = 0;
    state.startTs = 0;
    state.lastTs = 0;
    state.spawnedSecondBall = false;
    state.shrunkPaddle = false;

    state.paddle.w = Math.min(140, Math.max(96, Math.floor(W * 0.32)));
    state.paddle.h = 14;
    state.paddle.x = Math.floor(W / 2 - state.paddle.w / 2);
    state.paddle.y = H - 28;

    state.balls = [spawnBall(true)];
    elScore.textContent = "0";
    sendHint.textContent = "";
  }

  function spawnBall(fromTop) {
    const r = 9;
    const x = rand(r + 10, W - r - 10);
    const y = fromTop ? r + 20 : rand(H * 0.2, H * 0.4);
    const speed = 260 + rand(-30, 30);
    const angle = rand(-0.35, 0.35);
    return {
      x,
      y,
      r,
      vx: speed * Math.sin(angle),
      vy: speed * Math.cos(angle), // downward
    };
  }

  function start() {
    overlay.classList.add("hidden");
    gameover.classList.add("hidden");
    resetGame();
    state.running = true;
    state.startTs = performance.now();
    state.lastTs = state.startTs;
    raf = requestAnimationFrame(loop);
  }

  function endGame() {
    state.running = false;
    cancelAnimationFrame(raf);
    finalScoreEl.textContent = String(state.score);
    gameover.classList.remove("hidden");
    sendHint.textContent = "Нажми «Сохранить», чтобы отправить результат в бота.";
  }

  function maybeDifficulty() {
    const s = state.score;

    if (s >= 25 && !state.spawnedSecondBall) {
      state.spawnedSecondBall = true;
      state.balls.push(spawnBall(true));
    }
    if (s >= 50 && !state.shrunkPaddle) {
      state.shrunkPaddle = true;
      state.paddle.w = Math.max(70, Math.floor(state.paddle.w * 0.72));
      state.paddle.x = Math.max(12, Math.min(W - state.paddle.w - 12, state.paddle.x));
    }

    // speed up each 10 points
    if (s > 0 && s % 10 === 0) {
      for (const b of state.balls) {
        b.vx *= 1.08;
        b.vy *= 1.08;
      }
    }
  }

  function update(dt) {
    const px = state.paddle.x;
    const py = state.paddle.y;
    const pw = state.paddle.w;
    const ph = state.paddle.h;

    for (const b of state.balls) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      // walls
      if (b.x - b.r < 0) {
        b.x = b.r;
        b.vx = Math.abs(b.vx);
      } else if (b.x + b.r > W) {
        b.x = W - b.r;
        b.vx = -Math.abs(b.vx);
      }
      if (b.y - b.r < 0) {
        b.y = b.r;
        b.vy = Math.abs(b.vy);
      }

      // paddle hit (only when falling)
      const withinX = b.x >= px - b.r && b.x <= px + pw + b.r;
      const hitY = b.y + b.r >= py && b.y + b.r <= py + ph + 6;
      if (b.vy > 0 && withinX && hitY) {
        b.y = py - b.r - 0.5;
        state.score += 1;
        elScore.textContent = String(state.score);

        const center = px + pw / 2;
        const rel = (b.x - center) / (pw / 2);
        const base = Math.max(260, Math.hypot(b.vx, b.vy) * 1.02);
        const angle = rel * 0.75 + rand(-0.15, 0.15);
        b.vx = base * Math.sin(angle);
        b.vy = -Math.abs(base * Math.cos(angle));

        beep();
        maybeDifficulty();
      }

      // bottom => game over
      if (b.y - b.r > H) {
        endGame();
        return;
      }
    }
  }

  function draw() {
    // background
    ctx.fillStyle = "#0b0f14";
    ctx.fillRect(0, 0, W, H);

    // subtle grid
    ctx.globalAlpha = 0.08;
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

    // paddle
    const p = state.paddle;
    const grad = ctx.createLinearGradient(p.x, p.y, p.x + p.w, p.y);
    grad.addColorStop(0, "#ff3d8d");
    grad.addColorStop(1, "#30d1ff");
    ctx.fillStyle = grad;
    roundRect(ctx, p.x, p.y, p.w, p.h, 10);
    ctx.fill();

    // balls
    for (const b of state.balls) {
      ctx.fillStyle = "#ffd43b";
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 0.22;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(b.x - 3, b.y - 3, b.r * 0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  function loop(ts) {
    if (!state.running) return;
    const dt = Math.min(0.033, Math.max(0, (ts - state.lastTs) / 1000));
    state.lastTs = ts;
    update(dt);
    draw();
    raf = requestAnimationFrame(loop);
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function setPaddleX(clientX) {
    state.paddle.x = clamp(clientX - state.paddle.w / 2, 10, W - state.paddle.w - 10);
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

  // input
  window.addEventListener("pointermove", (e) => {
    if (!state.running) return;
    setPaddleX(e.clientX);
  });
  window.addEventListener(
    "touchmove",
    (e) => {
      if (!state.running) return;
      if (e.touches && e.touches[0]) setPaddleX(e.touches[0].clientX);
      e.preventDefault();
    },
    { passive: false },
  );

  // buttons
  btnStart.addEventListener("click", start);
  btnAgain.addEventListener("click", start);
  btnSend.addEventListener("click", () => {
    try {
      const durationMs = Math.max(0, Math.floor(performance.now() - state.startTs));
      const payload = {
        score: state.score,
        duration_ms: durationMs,
        init_data: tg?.initData || "",
      };
      if (tg) {
        tg.sendData(JSON.stringify(payload));
        tg.close();
      } else {
        // fallback for browser testing
        sendHint.textContent = `payload: ${JSON.stringify(payload)}`;
      }
    } catch (e) {
      sendHint.textContent = `Ошибка отправки: ${String(e)}`;
    }
  });

  window.addEventListener("resize", resize);
  resize();
  resetGame();
  draw();
})();

