'use strict';

const crypto = require('crypto');
const { generateStory } = require('./stories/generator');

const MAX_PLAYERS = 8;
const MIN_PLAYERS = Number(process.env.MIN_PLAYERS || 2);
const READ_SECONDS = Number(process.env.READ_SECONDS || 60);
const DRAW_SECONDS = Number(process.env.DRAW_SECONDS || 180);
const LOTS_SECONDS = 7;
const COLLECT_GRACE_MS = 6000;
const REVEAL_COVER_SECONDS = 5;
const REVEAL_PAGE_SECONDS = 12;
const VOTE_SECONDS = 60;
const MAX_IMAGE_LENGTH = 3 * 1024 * 1024;
const ROOM_IDLE_MS = 10 * 60 * 1000;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomInt(n) {
  return crypto.randomInt(n);
}

function sanitizeName(name) {
  return String(name || '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}

/**
 * Распределение страниц. choices: { playerId: pageIndex | undefined }.
 * Если на одну страницу претендуют несколько человек — бросается жребий
 * (для двоих — монетка). Проигравшие и те, кто не выбирал, получают
 * оставшиеся страницы случайным образом.
 */
function assignPages(playerIds, pageCount, choices, rand = randomInt) {
  const assignments = {};
  const lots = [];
  const byPage = new Map();
  for (const id of playerIds) {
    const c = choices[id];
    if (Number.isInteger(c) && c >= 0 && c < pageCount) {
      if (!byPage.has(c)) byPage.set(c, []);
      byPage.get(c).push(id);
    }
  }
  for (const [page, contenders] of byPage) {
    const winner = contenders.length === 1 ? contenders[0] : contenders[rand(contenders.length)];
    assignments[winner] = page;
    if (contenders.length > 1) lots.push({ page, contenders, winner });
  }
  const taken = new Set(Object.values(assignments));
  const freePages = [];
  for (let p = 0; p < pageCount; p++) if (!taken.has(p)) freePages.push(p);
  const unassigned = playerIds.filter((id) => !(id in assignments));
  // Перемешиваем свободные страницы — «оставшаяся иллюстрация уходит проигравшему».
  const shuffled = [];
  const pool = freePages.slice();
  while (pool.length) shuffled.push(pool.splice(rand(pool.length), 1)[0]);
  unassigned.forEach((id, i) => {
    if (i < shuffled.length) assignments[id] = shuffled[i];
  });
  for (const lot of lots) {
    lot.consolation = {};
    for (const id of lot.contenders) if (id !== lot.winner) lot.consolation[id] = assignments[id];
  }
  return { assignments, lots };
}

class Room {
  constructor(io, code, onEmpty) {
    this.io = io;
    this.code = code;
    this.onEmpty = onEmpty;
    this.players = new Map(); // id -> { id, token, name, socketId, connected, score }
    this.hostId = null;
    this.phase = 'lobby';
    this.deadline = null;
    this.timer = null;
    this.idleTimer = null;
    this.round = 0;
    this.resetRound();
  }

  resetRound() {
    this.story = null;
    this.order = []; // игроки, участвующие в раунде
    this.choices = {};
    this.ready = new Set();
    this.assignments = {};
    this.lots = [];
    this.drawings = {};
    this.revealIndex = -1;
    this.likes = {}; // voterId -> Set(authorId)
    this.votedDone = new Set();
    this.results = null;
  }

  // ---------- участники ----------

  connectedPlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  addPlayer(socket, name) {
    if (this.phase !== 'lobby') return { error: 'Игра уже идёт — дождитесь следующей партии.' };
    if (this.players.size >= MAX_PLAYERS) return { error: `В комнате уже ${MAX_PLAYERS} игроков.` };
    const clean = sanitizeName(name);
    if (!clean) return { error: 'Введите имя.' };
    const taken = [...this.players.values()].some((p) => p.name.toLowerCase() === clean.toLowerCase());
    if (taken) return { error: 'Это имя уже занято в комнате.' };
    const player = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(16).toString('hex'),
      name: clean,
      socketId: socket.id,
      connected: true,
      score: 0,
    };
    this.players.set(player.id, player);
    if (!this.hostId) this.hostId = player.id;
    this.touch();
    return { player };
  }

  reconnect(socket, token) {
    const player = [...this.players.values()].find((p) => p.token === token);
    if (!player) return null;
    player.socketId = socket.id;
    player.connected = true;
    if (!this.players.get(this.hostId)?.connected) this.hostId = player.id;
    this.touch();
    return player;
  }

  disconnect(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    if (this.phase === 'lobby') {
      this.players.delete(playerId);
    } else {
      player.connected = false;
    }
    if (this.hostId === playerId) {
      const next = this.connectedPlayers()[0];
      this.hostId = next ? next.id : null;
    }
    this.touch();
    this.broadcast();
    this.checkEarlyAdvance();
  }

  touch() {
    clearTimeout(this.idleTimer);
    if (this.connectedPlayers().length === 0) {
      this.idleTimer = setTimeout(() => this.destroy(), ROOM_IDLE_MS);
    }
  }

  destroy() {
    clearTimeout(this.timer);
    clearTimeout(this.idleTimer);
    this.onEmpty(this.code);
  }

  // ---------- фазы ----------

  setPhase(phase, seconds, next) {
    clearTimeout(this.timer);
    this.phase = phase;
    this.deadline = seconds ? Date.now() + seconds * 1000 : null;
    if (seconds && next) this.timer = setTimeout(next, seconds * 1000);
    this.broadcast();
  }

  async start(byId) {
    if (byId !== this.hostId) return { error: 'Начать игру может только хозяин комнаты.' };
    if (this.phase !== 'lobby' && this.phase !== 'results') return { error: 'Игра уже идёт.' };
    // Отключившиеся игроки прошлой партии выбывают.
    for (const [id, p] of this.players) if (!p.connected) this.players.delete(id);
    const players = this.connectedPlayers();
    if (players.length < MIN_PLAYERS) return { error: `Нужно хотя бы ${MIN_PLAYERS} игрока.` };

    this.resetRound();
    this.round += 1;
    const round = this.round;
    this.order = players.map((p) => p.id);
    this.setPhase('generating');
    const story = await generateStory(this.order.length);
    if (round !== this.round || this.phase !== 'generating') return {};
    this.story = story;
    this.setPhase('reading', READ_SECONDS, () => this.resolveLots());
    return {};
  }

  choose(playerId, page) {
    if (this.phase !== 'reading' || !this.order.includes(playerId)) return;
    if (page === null) delete this.choices[playerId];
    else if (Number.isInteger(page) && page >= 0 && page < this.story.pages.length) this.choices[playerId] = page;
    this.broadcast();
  }

  setReady(playerId, value) {
    if (!this.order.includes(playerId)) return;
    if (this.phase === 'reading') {
      if (value) this.ready.add(playerId);
      else this.ready.delete(playerId);
      this.broadcast();
      this.checkEarlyAdvance();
    }
  }

  activeIds() {
    return this.order.filter((id) => this.players.get(id)?.connected);
  }

  checkEarlyAdvance() {
    const active = this.activeIds();
    if (this.phase !== 'lobby' && this.phase !== 'results' && active.length === 0) {
      clearTimeout(this.timer);
      this.resetRound();
      this.phase = 'lobby';
      return;
    }
    if (this.phase === 'reading' && active.every((id) => this.ready.has(id))) this.resolveLots();
    else if ((this.phase === 'drawing' || this.phase === 'collecting') && active.every((id) => id in this.drawings)) this.startReveal();
    else if (this.phase === 'voting' && active.every((id) => this.votedDone.has(id))) this.finish();
  }

  resolveLots() {
    if (this.phase !== 'reading') return;
    const { assignments, lots } = assignPages(this.order, this.story.pages.length, this.choices);
    this.assignments = assignments;
    this.lots = lots;
    // Если спорить не о чем — сразу к рисованию, иначе показываем бросок монетки.
    if (lots.length === 0) this.startDrawing();
    else this.setPhase('lots', LOTS_SECONDS, () => this.startDrawing());
  }

  startDrawing() {
    this.setPhase('drawing', DRAW_SECONDS, () => this.collect());
  }

  collect() {
    if (this.phase !== 'drawing') return;
    // Время вышло: клиенты досылают рисунки, ждём их немного.
    this.setPhase('collecting', COLLECT_GRACE_MS / 1000, () => this.startReveal());
    this.checkEarlyAdvance();
  }

  submitDrawing(playerId, image) {
    if (this.phase !== 'drawing' && this.phase !== 'collecting') return { error: 'Сейчас не время рисовать.' };
    if (!(playerId in this.assignments)) return { error: 'У вас нет страницы.' };
    if (typeof image !== 'string' || image.length > MAX_IMAGE_LENGTH || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) {
      return { error: 'Не удалось принять рисунок.' };
    }
    this.drawings[playerId] = image;
    this.broadcast();
    this.checkEarlyAdvance();
    return {};
  }

  gallery() {
    // Страницы по порядку, с автором и рисунком (если есть).
    const authorByPage = {};
    for (const [id, page] of Object.entries(this.assignments)) authorByPage[page] = id;
    return this.story.pages.map((p, i) => {
      const authorId = authorByPage[i] || null;
      return {
        index: i,
        text: p.text,
        scene: p.scene,
        authorId,
        authorName: authorId ? this.players.get(authorId)?.name || '???' : null,
        image: authorId ? this.drawings[authorId] || null : null,
      };
    });
  }

  startReveal() {
    if (this.phase !== 'drawing' && this.phase !== 'collecting') return;
    clearTimeout(this.timer);
    this.io.to(this.code).emit('gallery', { title: this.story.title, pages: this.gallery() });
    this.revealIndex = -1; // -1 — обложка книги
    this.setPhase('reveal', REVEAL_COVER_SECONDS, () => this.nextPage());
  }

  nextPage(byId) {
    if (this.phase !== 'reveal') return;
    if (byId && byId !== this.hostId) return;
    this.revealIndex += 1;
    if (this.revealIndex >= this.story.pages.length) return this.startVoting();
    this.setPhase('reveal', REVEAL_PAGE_SECONDS, () => this.nextPage());
  }

  startVoting() {
    this.setPhase('voting', VOTE_SECONDS, () => this.finish());
  }

  toggleLike(voterId, authorId) {
    if (this.phase !== 'voting' || voterId === authorId) return;
    if (!this.order.includes(voterId) || !(authorId in this.drawings)) return;
    const set = this.likes[voterId] || (this.likes[voterId] = new Set());
    if (set.has(authorId)) set.delete(authorId);
    else set.add(authorId);
    this.emitTo(voterId);
  }

  voteDone(playerId) {
    if (this.phase !== 'voting') return;
    this.votedDone.add(playerId);
    this.broadcast();
    this.checkEarlyAdvance();
  }

  finish() {
    if (this.phase !== 'voting') return;
    const tally = {};
    for (const set of Object.values(this.likes)) for (const id of set) tally[id] = (tally[id] || 0) + 1;
    const pages = this.gallery();
    this.results = pages
      .filter((p) => p.authorId)
      .map((p) => ({ authorId: p.authorId, authorName: p.authorName, page: p.index, likes: tally[p.authorId] || 0 }))
      .sort((a, b) => b.likes - a.likes || a.page - b.page);
    for (const r of this.results) {
      const pl = this.players.get(r.authorId);
      if (pl) pl.score += r.likes;
    }
    this.setPhase('results');
  }

  backToLobby(byId) {
    if (byId !== this.hostId || this.phase !== 'results') return;
    for (const [id, p] of this.players) if (!p.connected) this.players.delete(id);
    this.resetRound();
    this.setPhase('lobby');
  }

  // ---------- рассылка состояния ----------

  snapshot(forId) {
    const players = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      score: p.score,
      isHost: p.id === this.hostId,
      inRound: this.order.includes(p.id),
      ready: this.ready.has(p.id),
      submitted: p.id in this.drawings,
      votedDone: this.votedDone.has(p.id),
    }));
    const s = {
      code: this.code,
      phase: this.phase,
      deadline: this.deadline,
      serverNow: Date.now(),
      you: forId,
      hostId: this.hostId,
      players,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      durations: { read: READ_SECONDS, draw: DRAW_SECONDS },
    };
    if (this.story && this.phase !== 'generating') {
      s.story = { title: this.story.title, pages: this.story.pages.map((p) => ({ text: p.text, scene: p.scene })), source: this.story.source };
      s.choices = this.choices;
    }
    if (['lots', 'drawing', 'collecting', 'reveal', 'voting', 'results'].includes(this.phase)) {
      s.assignments = this.assignments;
      s.lots = this.lots;
    }
    if (this.phase === 'reveal') s.revealIndex = this.revealIndex;
    if (this.phase === 'voting') s.myLikes = [...(this.likes[forId] || [])];
    if (this.phase === 'results') s.results = this.results;
    return s;
  }

  emitTo(playerId) {
    const p = this.players.get(playerId);
    if (p?.connected) this.io.to(p.socketId).emit('state', this.snapshot(p.id));
  }

  broadcast() {
    for (const p of this.players.values()) if (p.connected) this.emitTo(p.id);
  }

  sendGalleryTo(playerId) {
    const p = this.players.get(playerId);
    if (!p?.connected || !this.story) return;
    if (['reveal', 'voting', 'results'].includes(this.phase)) {
      this.io.to(p.socketId).emit('gallery', { title: this.story.title, pages: this.gallery() });
    }
  }
}

class Lobby {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
  }

  createRoom() {
    let code;
    do {
      code = Array.from({ length: 5 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    } while (this.rooms.has(code));
    const room = new Room(this.io, code, (c) => this.rooms.delete(c));
    this.rooms.set(code, room);
    room.touch(); // пустая комната удалится, если в неё так никто и не зайдёт
    return room;
  }

  get(code) {
    return this.rooms.get(String(code || '').trim().toUpperCase());
  }
}

module.exports = { Lobby, Room, assignPages, sanitizeName };
