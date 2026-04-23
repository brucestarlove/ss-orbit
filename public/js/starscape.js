// Animated starfield background, signature stars, meteors, and the theme
// toggle (which drives the starscape's dark/light state). Self-initializing:
// importing this module starts the canvas, schedules the first meteor, and
// wires the theme toggle button.
//
// Background stars are drawn on a 2D canvas so each star has its own twinkle
// period, phase, and warmth — scintillation that reads as per-star rather
// than whole-layer. Layers parallax to the cursor by depth. The Milky Way,
// nebula ghosts, signature stars with spikes, and meteors stay in CSS.

import { themeToggle, themeIcon } from "./dom.js";

// Stored theme must be applied before startStarscape() so its first sync()
// sees the real theme; otherwise the canvas stays stopped until next resize.
{
  const storedTheme = localStorage.getItem("mab_theme");
  if (storedTheme) document.documentElement.setAttribute("data-theme", storedTheme);
}

const starscape = startStarscape();
scheduleMeteor();

// Sticky top bar gets a tinted glass panel once the page scrolls, so its
// controls don't blend into whatever content is slipping behind them.
{
  const updateScrolled = () => {
    document.body.classList.toggle("is-scrolled", window.scrollY > 4);
  };
  window.addEventListener("scroll", updateScrolled, { passive: true });
  updateScrolled();
}

syncThemeIcon();
themeToggle.addEventListener("click", () => {
  const next =
    document.documentElement.getAttribute("data-theme") === "dark"
      ? "light"
      : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("mab_theme", next);
  syncThemeIcon();
  starscape.sync();
});

function syncThemeIcon() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  themeIcon.innerHTML = dark
    ? '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />'
    : '<circle cx="12" cy="12" r="5" /><path d="M12 1v2m0 18v2M4.2 4.2l1.4 1.4m12.8 12.8l1.4 1.4M1 12h2m18 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />';
}

function startStarscape() {
  const grain = document.querySelector(".grain");
  if (!grain) return { sync: () => {} };

  buildSignatureStars(grain);

  const canvas = document.createElement("canvas");
  canvas.className = "starfield-canvas";
  canvas.setAttribute("aria-hidden", "true");
  const milkyWay = grain.querySelector(".milky-way");
  if (milkyWay && milkyWay.nextSibling) {
    grain.insertBefore(canvas, milkyWay.nextSibling);
  } else if (milkyWay) {
    grain.appendChild(canvas);
  } else {
    grain.insertBefore(canvas, grain.firstChild);
  }

  const ctx = canvas.getContext("2d");
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  let width = 0;
  let height = 0;
  let stars = [];
  let rafId = 0;
  let running = false;

  // Eased mouse position, normalized to [-0.5, 0.5]. Lerp gives inertia.
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * DPR);
    canvas.height = Math.round(height * DPR);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    buildStars();
  }

  function buildStars() {
    // Star count scales with viewport area so wide screens don't read empty.
    const density = (width * height) / (1440 * 900);
    const layers = [
      { count: Math.round(320 * density), depth: 0.12, sizes: [[1, 0.9], [1.4, 0.1]], glow: 0 },
      { count: Math.round(160 * density), depth: 0.30, sizes: [[1, 0.5], [1.6, 0.4], [2.4, 0.1]], glow: 1.8 },
      { count: Math.round(44 * density),  depth: 0.58, sizes: [[1.8, 0.5], [2.6, 0.38], [3.6, 0.12]], glow: 2.4 }
    ];
    const rng = mulberry32(0xc0ffee);
    stars = [];
    for (const layer of layers) {
      for (let i = 0; i < layer.count; i++) {
        const size = pickWeighted(rng(), layer.sizes);
        stars.push({
          x: rng() * width,
          y: rng() * height,
          size,
          depth: layer.depth,
          glow: size >= 2 ? layer.glow : 0,
          rgb: pickStarColor(rng()),
          period: 2.2 + rng() * 5.4,
          phase: rng() * Math.PI * 2,
          amp: 0.25 + rng() * 0.5,
          baseAlpha: size < 1.5 ? 0.45 + rng() * 0.28 : 0.55 + rng() * 0.22
        });
      }
    }
  }

  function pickStarColor(r) {
    if (r < 0.80) return [255, 255, 255];
    if (r < 0.93) return [255, 222, 186];
    return [195, 218, 255];
  }

  function onPointerMove(e) {
    if (!width || !height) return;
    mouse.tx = e.clientX / width - 0.5;
    mouse.ty = e.clientY / height - 0.5;
  }

  function frame(t) {
    mouse.x += (mouse.tx - mouse.x) * 0.06;
    mouse.y += (mouse.ty - mouse.y) * 0.06;

    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = "lighter";

    const time = t / 1000;
    const parallaxPx = 70;

    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      const pulse = 0.5 + 0.5 * Math.sin(time * ((2 * Math.PI) / s.period) + s.phase);
      const alpha = s.baseAlpha * (1 - s.amp + s.amp * pulse);
      const px = s.x - mouse.x * s.depth * parallaxPx;
      const py = s.y - mouse.y * s.depth * parallaxPx;
      const [r, g, b] = s.rgb;

      if (s.glow > 0) {
        // Glowed stars: soft halo + circular core (arc, not rect) so the
        // bright center doesn't read as a square at larger zoom levels.
        const radius = s.size * s.glow;
        const grad = ctx.createRadialGradient(px, py, 0, px, py, radius);
        grad.addColorStop(0, `rgba(${r},${g},${b},${alpha * 0.85})`);
        grad.addColorStop(0.35, `rgba(${r},${g},${b},${alpha * 0.3})`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(px, py, radius, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.beginPath();
        ctx.arc(px, py, s.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Sub-pixel dim stars: fillRect is fine — they're one device pixel.
        const half = s.size / 2;
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.fillRect(px - half, py - half, s.size, s.size);
      }
    }

    ctx.globalCompositeOperation = "source-over";
    if (running) rafId = requestAnimationFrame(frame);
  }

  function drawStaticFrame() {
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = "lighter";
    for (const s of stars) {
      const [r, g, b] = s.rgb;
      ctx.fillStyle = `rgba(${r},${g},${b},${s.baseAlpha})`;
      if (s.glow > 0) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const half = s.size / 2;
        ctx.fillRect(s.x - half, s.y - half, s.size, s.size);
      }
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function start() {
    if (running) return;
    running = true;
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(rafId);
  }

  function sync() {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!isDark) {
      stop();
      ctx.clearRect(0, 0, width, height);
      return;
    }
    if (!stars.length) resize();
    if (reduced || document.hidden) {
      stop();
      drawStaticFrame();
    } else {
      start();
    }
  }

  window.addEventListener("resize", () => {
    resize();
    sync();
  }, { passive: true });
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  document.addEventListener("visibilitychange", sync);
  window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", sync);

  resize();
  sync();
  return { sync };
}

function buildSignatureStars(grain) {
  grain.querySelectorAll(".signature-star").forEach((el) => el.remove());
  const rng = mulberry32(0x5ca1e5);
  const SIG_COUNT = 7;
  for (let i = 0; i < SIG_COUNT; i++) {
    const star = document.createElement("div");
    star.className = "signature-star";
    star.setAttribute("aria-hidden", "true");
    star.style.left = (6 + rng() * 88).toFixed(2) + "%";
    star.style.top = (8 + rng() * 78).toFixed(2) + "%";
    star.style.animationDelay = (-rng() * 4.8).toFixed(2) + "s";
    grain.appendChild(star);
  }
}

/* Shooting stars — rare streaks that cross the sky. CSS handles the trail
   and fade; JS picks the trajectory and reschedules the next one. */
function scheduleMeteor() {
  const delay = 14000 + Math.random() * 28000;
  setTimeout(spawnMeteor, delay);
}

function spawnMeteor() {
  const isDark =
    document.documentElement.getAttribute("data-theme") === "dark";
  const reduced = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;
  const grain = document.querySelector(".grain");
  if (!isDark || reduced || document.hidden || !grain) {
    scheduleMeteor();
    return;
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const startX = Math.random() * vw * 0.6;
  const startY = Math.random() * vh * 0.55;
  const distance = 380 + Math.random() * 520;
  const angleDeg = 18 + Math.random() * 26;
  const rad = (angleDeg * Math.PI) / 180;
  const endX = startX + Math.cos(rad) * distance;
  const endY = startY + Math.sin(rad) * distance;

  const m = document.createElement("div");
  m.className = "meteor";
  m.setAttribute("aria-hidden", "true");
  m.style.setProperty("--from-x", startX + "px");
  m.style.setProperty("--from-y", startY + "px");
  m.style.setProperty("--to-x", endX + "px");
  m.style.setProperty("--to-y", endY + "px");
  m.style.setProperty("--angle", angleDeg + "deg");
  grain.appendChild(m);
  m.addEventListener("animationend", () => m.remove(), { once: true });

  scheduleMeteor();
}

function pickWeighted(r, table) {
  let acc = 0;
  for (const [value, weight] of table) {
    acc += weight;
    if (r < acc) return value;
  }
  return table[table.length - 1][0];
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
