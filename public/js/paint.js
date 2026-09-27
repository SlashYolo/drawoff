'use strict';

/*
 * Рисовалка: кисть, ластик, прямые линии, прямоугольники, эллипсы, треугольники,
 * заливка, пипетка, толщина и прозрачность ползунками, выбор цвета RGB,
 * отмена/повтор. Холст фиксированного размера масштабируется под экран.
 */
(function () {
  const WIDTH = 800;
  const HEIGHT = 600;
  const PAPER = '#ffffff';
  const HISTORY_LIMIT = 40;

  const PALETTE = [
    '#1b1410', '#5b4636', '#8a6d4b', '#c8b08a', '#fbf6e9', '#ffffff',
    '#7a1a1a', '#b3261e', '#d9772b', '#e0b43a', '#f1d98a', '#6e7a2a',
    '#2f5d2a', '#3f7f6b', '#1e3a6e', '#3b6fb6', '#8fb5d9', '#5b2c6f',
    '#a05a8c', '#e8a3a0',
  ];

  const TOOLS = [
    { id: 'brush', label: 'Кисть', key: 'b', icon: '<path d="M4 20c2 0 4-1 4-3s-1-3-2-3-3 1-3 3-1 3 1 3zM9 14l9-9a2 2 0 013 3l-9 9"/>' },
    { id: 'eraser', label: 'Ластик', key: 'e', icon: '<path d="M4 16l8-8 6 6-8 8H7zM12 8l6 6M10 22h10"/>' },
    { id: 'line', label: 'Прямая линия', key: 'l', icon: '<path d="M5 19L19 5"/>' },
    { id: 'rect', label: 'Прямоугольник', key: 'r', icon: '<rect x="4" y="6" width="16" height="12" rx="1"/>' },
    { id: 'ellipse', label: 'Эллипс', key: 'o', icon: '<ellipse cx="12" cy="12" rx="8" ry="6"/>' },
    { id: 'triangle', label: 'Треугольник', key: 't', icon: '<path d="M12 4l9 16H3z"/>' },
    { id: 'fill', label: 'Заливка', key: 'f', icon: '<path d="M5 11l7-7 8 8-7 7zM5 11h15M20 16s2 2.5 2 3.5a2 2 0 01-4 0c0-1 2-3.5 2-3.5z"/>' },
    { id: 'picker', label: 'Пипетка', key: 'i', icon: '<path d="M14 4l6 6M17 7l-9 9-3 1 1-3 9-9M4 20l2-2"/>' },
  ];

  function svg(path) {
    return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgbToHex({ r, g, b }) {
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  // HSV: h — 0..360, s и v — 0..1.
  function rgbToHsv({ r, g, b }) {
    const R = r / 255, G = g / 255, B = b / 255;
    const max = Math.max(R, G, B), min = Math.min(R, G, B);
    const d = max - min;
    let h = 0;
    if (d) {
      if (max === R) h = ((G - B) / d) % 6;
      else if (max === G) h = (B - R) / d + 2;
      else h = (R - G) / d + 4;
      h = (h * 60 + 360) % 360;
    }
    return { h, s: max ? d / max : 0, v: max };
  }

  function hsvToRgb({ h, s, v }) {
    const f = (n) => {
      const k = (n + h / 60) % 6;
      return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
    };
    return { r: f(5), g: f(3), b: f(1) };
  }

  class Paint {
    constructor(root) {
      this.root = root;
      this.tool = 'brush';
      this.color = { r: 27, g: 20, b: 16 };
      this.size = 8;
      this.opacity = 1;
      this.fillShapes = false;
      this.locked = false;
      this.undoStack = [];
      this.redoStack = [];
      this.pointer = null;
      this.build();
      this.clear(false);
      this.bindKeys();
    }

    // ---------- интерфейс ----------

    build() {
      this.root.innerHTML = `
        <div class="paint__tools" role="toolbar" aria-label="Инструменты" aria-orientation="vertical">
          <div class="paint__color">
            <button type="button" class="color-btn" data-action="color" title="Цвет — нажмите, чтобы выбрать" aria-label="Выбрать цвет" aria-haspopup="dialog" aria-expanded="false">
              <span class="color-btn__fill"></span>
            </button>
            <div class="color-pop hidden" role="dialog" aria-label="Выбор цвета">
              <div class="color-pop__title">Цвет</div>
              <div class="wheel" data-wheel>
                <div class="wheel__shade"></div>
                <div class="wheel__marker"></div>
              </div>
              <label class="color-pop__row">
                <span>Яркость</span>
                <input type="range" class="value-range" min="0" max="100" step="1" data-input="value" aria-label="Яркость">
              </label>
              <div class="rgb-inputs">
                ${['r', 'g', 'b'].map((c) => `
                  <label>${c.toUpperCase()}<input class="input input--num" type="number" min="0" max="255" data-input="${c}" aria-label="${c.toUpperCase()}"></label>`).join('')}
                <label>HEX<input class="input input--hex" data-input="hex" maxlength="7" aria-label="HEX-код цвета"></label>
              </div>
              <div class="swatches">
                ${PALETTE.map((c) => `<button type="button" class="swatch" data-color="${c}" style="background:${c}" title="${c}" aria-label="Цвет ${c}"></button>`).join('')}
              </div>
            </div>
          </div>
          <span class="paint__sep"></span>
          ${TOOLS.map((t) => `<button type="button" class="tool" data-tool="${t.id}" title="${t.label} (${t.key.toUpperCase()})" aria-label="${t.label}">${svg(t.icon)}</button>`).join('')}
          <span class="paint__sep"></span>
          <button type="button" class="tool" data-action="shape-fill" title="Фигуры: контур или заливка" aria-label="Фигуры: контур или заливка">${svg('<rect x="5" y="5" width="14" height="14" rx="1"/>')}</button>
          <button type="button" class="tool" data-action="undo" title="Отменить (Ctrl+Z)" aria-label="Отменить">${svg('<path d="M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3"/>')}</button>
          <button type="button" class="tool" data-action="redo" title="Повторить (Ctrl+Y)" aria-label="Повторить">${svg('<path d="M15 14l5-5-5-5M20 9H9a5 5 0 000 10h3"/>')}</button>
          <button type="button" class="tool tool--danger" data-action="clear" title="Очистить холст" aria-label="Очистить холст">${svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>')}</button>
        </div>
        <div class="paint__stage">
          <canvas class="paint__canvas" width="${WIDTH}" height="${HEIGHT}"></canvas>
          <canvas class="paint__overlay" width="${WIDTH}" height="${HEIGHT}"></canvas>
          <div class="paint__lock hidden">Работа сдана</div>
        </div>
        <div class="paint__panel">
          <label class="slider">
            <span>Толщина <output data-out="size"></output></span>
            <input type="range" min="1" max="80" step="1" data-input="size">
          </label>
          <span class="paint__preview" aria-hidden="true"><span></span></span>
          <label class="slider">
            <span>Прозрачность <output data-out="opacity"></output></span>
            <input type="range" min="5" max="100" step="1" data-input="opacity">
          </label>
        </div>`;

      this.canvas = this.root.querySelector('.paint__canvas');
      this.overlay = this.root.querySelector('.paint__overlay');
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      this.octx = this.overlay.getContext('2d');
      this.lockEl = this.root.querySelector('.paint__lock');
      this.q = (sel) => this.root.querySelector(sel);
      this.pop = this.q('.color-pop');
      this.wheel = this.q('[data-wheel]');

      this.root.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => this.setTool(b.dataset.tool)));
      this.q('[data-action="undo"]').addEventListener('click', () => this.undo());
      this.q('[data-action="redo"]').addEventListener('click', () => this.redo());
      this.q('[data-action="clear"]').addEventListener('click', () => {
        if (!this.locked && confirm('Очистить весь холст?')) this.clear(true);
      });
      this.q('[data-action="shape-fill"]').addEventListener('click', () => {
        this.fillShapes = !this.fillShapes;
        this.syncUI();
      });

      this.q('[data-input="size"]').addEventListener('input', (e) => { this.size = +e.target.value; this.syncUI(); });
      this.q('[data-input="opacity"]').addEventListener('input', (e) => { this.opacity = +e.target.value / 100; this.syncUI(); });

      // Цветовой круг: оттенок — угол, насыщенность — расстояние от центра, яркость — ползунок.
      this.q('[data-action="color"]').addEventListener('click', () => this.togglePopover());
      const pickFromWheel = (e) => {
        const rect = this.wheel.getBoundingClientRect();
        const r = rect.width / 2;
        const dx = e.clientX - rect.left - r;
        const dy = e.clientY - rect.top - r;
        const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
        const s = Math.min(1, Math.hypot(dx, dy) / r);
        // Если цвет был слишком тёмным, при выборе на круге поднимаем яркость, иначе круг «не работает».
        const v = this.hsv.v < 0.15 ? 1 : this.hsv.v;
        this.setHsv({ h, s, v });
      };
      this.wheel.addEventListener('pointerdown', (e) => {
        this.wheel.setPointerCapture(e.pointerId);
        this.wheelDrag = true;
        pickFromWheel(e);
      });
      this.wheel.addEventListener('pointermove', (e) => { if (this.wheelDrag) pickFromWheel(e); });
      const stopWheel = () => { this.wheelDrag = false; };
      this.wheel.addEventListener('pointerup', stopWheel);
      this.wheel.addEventListener('pointercancel', stopWheel);
      this.q('[data-input="value"]').addEventListener('input', (e) => this.setHsv({ ...this.hsv, v: +e.target.value / 100 }));
      ['r', 'g', 'b'].forEach((c) => {
        this.q(`[data-input="${c}"]`).addEventListener('change', (e) => {
          const val = Math.max(0, Math.min(255, Math.round(+e.target.value || 0)));
          this.setColor(rgbToHex({ ...this.color, [c]: val }));
        });
      });
      this.q('[data-input="hex"]').addEventListener('change', (e) => {
        const hex = e.target.value.startsWith('#') ? e.target.value : '#' + e.target.value;
        if (!this.setColor(hex)) this.syncUI();
      });
      this.root.querySelectorAll('.swatch').forEach((s) => s.addEventListener('click', () => this.setColor(s.dataset.color)));

      // Закрытие попапа кликом мимо него или клавишей Escape.
      document.addEventListener('pointerdown', (e) => {
        if (!this.pop.classList.contains('hidden') && !e.target.closest('.paint__color')) this.togglePopover(false);
      });

      this.overlay.addEventListener('pointerdown', (e) => this.onDown(e));
      this.overlay.addEventListener('pointermove', (e) => this.onMove(e));
      this.overlay.addEventListener('pointerup', (e) => this.onUp(e));
      this.overlay.addEventListener('pointercancel', (e) => this.onUp(e));
      this.overlay.addEventListener('contextmenu', (e) => e.preventDefault());

      this.hsv = rgbToHsv(this.color);
      this.syncUI();
    }

    togglePopover(open) {
      const show = open === undefined ? this.pop.classList.contains('hidden') : open;
      if (show && this.locked) return;
      this.pop.classList.toggle('hidden', !show);
      this.q('[data-action="color"]').setAttribute('aria-expanded', String(show));
    }

    bindKeys() {
      this.keyHandler = (e) => {
        if (this.locked || !this.root.offsetParent) return;
        if (e.key === 'Escape') { this.togglePopover(false); return; }
        if (e.target.closest && e.target.closest('input, textarea')) return;
        const k = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'я')) {
          e.preventDefault();
          if (e.shiftKey) this.redo(); else this.undo();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && (k === 'y' || k === 'н')) {
          e.preventDefault();
          this.redo();
          return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const tool = TOOLS.find((t) => t.key === k || e.code === `Key${t.key.toUpperCase()}`);
        if (tool) this.setTool(tool.id);
        if (k === '[') { this.size = Math.max(1, this.size - 2); this.syncUI(); }
        if (k === ']') { this.size = Math.min(80, this.size + 2); this.syncUI(); }
      };
      window.addEventListener('keydown', this.keyHandler);
    }

    setTool(tool) {
      this.tool = tool;
      this.syncUI();
    }

    setColor(hex) {
      const rgb = hexToRgb(hex);
      if (!rgb) return false;
      this.color = rgb;
      this.hsv = rgbToHsv(rgb);
      this.syncUI();
      return true;
    }

    setHsv(hsv) {
      this.hsv = hsv;
      this.color = hsvToRgb(hsv);
      this.syncUI();
    }

    syncUI() {
      const hex = rgbToHex(this.color);
      this.root.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('is-active', b.dataset.tool === this.tool));
      this.q('[data-action="shape-fill"]').classList.toggle('is-active', this.fillShapes);
      this.q('[data-action="shape-fill"]').innerHTML = svg(this.fillShapes
        ? '<rect x="5" y="5" width="14" height="14" rx="1" fill="currentColor"/>'
        : '<rect x="5" y="5" width="14" height="14" rx="1"/>');
      if (!this.locked) {
        this.q('[data-action="undo"]').disabled = this.undoStack.length === 0;
        this.q('[data-action="redo"]').disabled = this.redoStack.length === 0;
      }
      this.q('[data-input="size"]').value = this.size;
      this.q('[data-out="size"]').textContent = this.size;
      this.q('[data-input="opacity"]').value = Math.round(this.opacity * 100);
      this.q('[data-out="opacity"]').textContent = Math.round(this.opacity * 100) + '%';

      // Прямоугольник активного цвета (с учётом прозрачности — видно шахматку).
      const fill = this.q('.color-btn__fill');
      fill.style.background = hex;
      fill.style.opacity = this.opacity;
      this.q('[data-action="color"]').title = `Цвет ${hex.toUpperCase()} — нажмите, чтобы выбрать`;

      // Цветовой круг.
      const { h, s, v } = this.hsv;
      this.q('.wheel__shade').style.opacity = 1 - v;
      const marker = this.q('.wheel__marker');
      const rad = (h * Math.PI) / 180;
      marker.style.left = `${50 + Math.cos(rad) * s * 50}%`;
      marker.style.top = `${50 + Math.sin(rad) * s * 50}%`;
      marker.style.background = hex;
      const pure = rgbToHex(hsvToRgb({ h, s, v: 1 }));
      const valueRange = this.q('[data-input="value"]');
      valueRange.value = Math.round(v * 100);
      valueRange.style.background = `linear-gradient(to right, #000, ${pure})`;
      for (const c of ['r', 'g', 'b']) {
        const input = this.q(`[data-input="${c}"]`);
        if (document.activeElement !== input) input.value = this.color[c];
      }
      const hexInput = this.q('[data-input="hex"]');
      if (document.activeElement !== hexInput) hexInput.value = hex;
      this.root.querySelectorAll('.swatch').forEach((sw) => sw.classList.toggle('is-active', sw.dataset.color === hex));

      const dot = this.q('.paint__preview span');
      const d = Math.max(2, Math.min(44, this.size));
      dot.style.width = dot.style.height = d + 'px';
      dot.style.background = this.tool === 'eraser' ? PAPER : hex;
      dot.style.opacity = this.opacity;
      this.overlay.style.cursor = this.tool === 'fill' || this.tool === 'picker' ? 'cell' : 'crosshair';
    }

    // ---------- история ----------

    snapshot() {
      this.undoStack.push(this.ctx.getImageData(0, 0, WIDTH, HEIGHT));
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
    }

    undo() {
      if (this.locked || !this.undoStack.length) return;
      this.redoStack.push(this.ctx.getImageData(0, 0, WIDTH, HEIGHT));
      this.ctx.putImageData(this.undoStack.pop(), 0, 0);
      this.syncUI();
    }

    redo() {
      if (this.locked || !this.redoStack.length) return;
      this.undoStack.push(this.ctx.getImageData(0, 0, WIDTH, HEIGHT));
      this.ctx.putImageData(this.redoStack.pop(), 0, 0);
      this.syncUI();
    }

    clear(withHistory) {
      if (withHistory) this.snapshot();
      this.ctx.save();
      this.ctx.globalAlpha = 1;
      this.ctx.fillStyle = PAPER;
      this.ctx.fillRect(0, 0, WIDTH, HEIGHT);
      this.ctx.restore();
      if (!withHistory) {
        this.undoStack = [];
        this.redoStack = [];
      }
      this.syncUI();
    }

    reset() {
      this.setLocked(false);
      this.clear(false);
    }

    setLocked(locked) {
      this.locked = locked;
      if (locked) this.togglePopover(false);
      this.lockEl.classList.toggle('hidden', !locked);
      this.root.classList.toggle('is-locked', locked);
      this.root.querySelectorAll('button, input').forEach((el) => { el.disabled = locked; });
      if (!locked) this.syncUI();
    }

    exportImage() {
      return this.canvas.toDataURL('image/jpeg', 0.85);
    }

    // ---------- рисование ----------

    pos(e) {
      const rect = this.overlay.getBoundingClientRect();
      return {
        x: ((e.clientX - rect.left) / rect.width) * WIDTH,
        y: ((e.clientY - rect.top) / rect.height) * HEIGHT,
      };
    }

    strokeColor() {
      return this.tool === 'eraser' ? PAPER : rgbToHex(this.color);
    }

    onDown(e) {
      if (this.locked || (e.button !== undefined && e.button !== 0)) return;
      e.preventDefault();
      const p = this.pos(e);
      if (this.tool === 'fill') {
        this.snapshot();
        this.floodFill(Math.floor(p.x), Math.floor(p.y));
        this.syncUI();
        return;
      }
      if (this.tool === 'picker') {
        const d = this.ctx.getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data;
        this.setColor(rgbToHex({ r: d[0], g: d[1], b: d[2] }));
        this.setTool('brush');
        return;
      }
      this.overlay.setPointerCapture(e.pointerId);
      this.pointer = { id: e.pointerId, start: p, last: p, points: [p] };
      // Весь штрих рисуется на слое-превью непрозрачно, а при отпускании
      // переносится на холст с выбранной прозрачностью — без «пятен» на наложениях.
      this.overlay.style.opacity = this.opacity;
      this.octx.clearRect(0, 0, WIDTH, HEIGHT);
      this.octx.lineCap = 'round';
      this.octx.lineJoin = 'round';
      this.octx.strokeStyle = this.octx.fillStyle = this.strokeColor();
      this.octx.lineWidth = this.size;
      if (this.tool === 'brush' || this.tool === 'eraser') this.drawFreehand();
    }

    onMove(e) {
      if (!this.pointer || e.pointerId !== this.pointer.id) return;
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      if (this.tool === 'brush' || this.tool === 'eraser') {
        for (const ev of events.length ? events : [e]) this.pointer.points.push(this.pos(ev));
        this.drawFreehand();
      } else {
        this.pointer.last = this.pos(e);
        this.drawShape(e.shiftKey);
      }
    }

    onUp(e) {
      if (!this.pointer || e.pointerId !== this.pointer.id) return;
      if (this.tool !== 'brush' && this.tool !== 'eraser') {
        this.pointer.last = this.pos(e);
        this.drawShape(e.shiftKey);
      }
      this.pointer = null;
      this.snapshot();
      this.ctx.save();
      this.ctx.globalAlpha = this.opacity;
      this.ctx.drawImage(this.overlay, 0, 0);
      this.ctx.restore();
      this.octx.clearRect(0, 0, WIDTH, HEIGHT);
      this.syncUI();
    }

    drawFreehand() {
      const pts = this.pointer.points;
      const c = this.octx;
      c.clearRect(0, 0, WIDTH, HEIGHT);
      if (pts.length === 1) {
        c.beginPath();
        c.arc(pts[0].x, pts[0].y, this.size / 2, 0, Math.PI * 2);
        c.fill();
        return;
      }
      // Сглаживание: кривые через середины соседних точек.
      c.beginPath();
      c.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        c.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      const last = pts[pts.length - 1];
      c.lineTo(last.x, last.y);
      c.stroke();
    }

    drawShape(constrain) {
      const c = this.octx;
      const { start: a } = this.pointer;
      let b = this.pointer.last;
      c.clearRect(0, 0, WIDTH, HEIGHT);
      c.beginPath();
      if (this.tool === 'line') {
        if (constrain) {
          // Shift — привязка к углам кратным 15°.
          const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 12)) * (Math.PI / 12);
          const len = Math.hypot(b.x - a.x, b.y - a.y);
          b = { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
        }
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();
        return;
      }
      let w = b.x - a.x;
      let h = b.y - a.y;
      if (constrain) {
        const m = Math.max(Math.abs(w), Math.abs(h));
        w = Math.sign(w || 1) * m;
        h = Math.sign(h || 1) * m;
      }
      if (this.tool === 'rect') {
        c.rect(a.x, a.y, w, h);
      } else if (this.tool === 'ellipse') {
        c.ellipse(a.x + w / 2, a.y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
      } else if (this.tool === 'triangle') {
        c.moveTo(a.x + w / 2, a.y);
        c.lineTo(a.x + w, a.y + h);
        c.lineTo(a.x, a.y + h);
        c.closePath();
      }
      if (this.fillShapes) c.fill();
      else c.stroke();
    }

    floodFill(x, y) {
      if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
      const img = this.ctx.getImageData(0, 0, WIDTH, HEIGHT);
      const data = img.data;
      const idx = (y * WIDTH + x) * 4;
      const tr = data[idx], tg = data[idx + 1], tb = data[idx + 2];
      const tol = 48;
      const match = (i) => Math.abs(data[i] - tr) <= tol && Math.abs(data[i + 1] - tg) <= tol && Math.abs(data[i + 2] - tb) <= tol;
      const mask = new Uint8Array(WIDTH * HEIGHT);
      const stack = [[x, y]];
      // Построчная заливка: идём по строке влево-вправо и добавляем соседние строки.
      while (stack.length) {
        let [cx, cy] = stack.pop();
        while (cx >= 0 && !mask[cy * WIDTH + cx] && match((cy * WIDTH + cx) * 4)) cx--;
        cx++;
        let up = false, down = false;
        while (cx < WIDTH && !mask[cy * WIDTH + cx] && match((cy * WIDTH + cx) * 4)) {
          mask[cy * WIDTH + cx] = 1;
          if (cy > 0) {
            const m = !mask[(cy - 1) * WIDTH + cx] && match(((cy - 1) * WIDTH + cx) * 4);
            if (m && !up) stack.push([cx, cy - 1]);
            up = m;
          }
          if (cy < HEIGHT - 1) {
            const m = !mask[(cy + 1) * WIDTH + cx] && match(((cy + 1) * WIDTH + cx) * 4);
            if (m && !down) stack.push([cx, cy + 1]);
            down = m;
          }
          cx++;
        }
      }
      // Расширяем область на пиксель, чтобы не оставалось светлой каймы у сглаженных контуров.
      const grown = mask.slice();
      for (let py = 0; py < HEIGHT; py++) {
        for (let px = 0; px < WIDTH; px++) {
          if (mask[py * WIDTH + px]) continue;
          if ((px > 0 && mask[py * WIDTH + px - 1]) || (px < WIDTH - 1 && mask[py * WIDTH + px + 1]) ||
              (py > 0 && mask[(py - 1) * WIDTH + px]) || (py < HEIGHT - 1 && mask[(py + 1) * WIDTH + px])) {
            grown[py * WIDTH + px] = 1;
          }
        }
      }
      const { r, g, b } = this.color;
      const a = this.opacity;
      for (let i = 0; i < grown.length; i++) {
        if (!grown[i]) continue;
        const j = i * 4;
        data[j] = Math.round(data[j] * (1 - a) + r * a);
        data[j + 1] = Math.round(data[j + 1] * (1 - a) + g * a);
        data[j + 2] = Math.round(data[j + 2] * (1 - a) + b * a);
        data[j + 3] = 255;
      }
      this.ctx.putImageData(img, 0, 0);
    }
  }

  window.Paint = Paint;
})();
