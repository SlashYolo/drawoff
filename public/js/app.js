'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const socket = io();
  const SESSION_KEY = 'drawoff:session';
  const NAME_KEY = 'drawoff:name';

  let state = null;
  let gallery = null;
  let clockOffset = 0;
  let paint = null;
  let submittedRound = false;
  let lastPhase = null;
  let lastRevealIndex = null;
  let lotsAnimated = false;

  const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  const roman = (i) => ROMAN[i] || String(i + 1);

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) node.append(c);
    return node;
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), 3200);
  }

  function emit(event, payload) {
    return new Promise((resolve) => socket.emit(event, payload || {}, (res) => resolve(res || {})));
  }

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function me() {
    return state?.players.find((p) => p.id === state.you);
  }

  function nameOf(id) {
    return state?.players.find((p) => p.id === id)?.name || '???';
  }

  function isHost() {
    return state && state.hostId === state.you;
  }

  // ---------- главный экран ----------

  const params = new URLSearchParams(location.search);
  $('name-input').value = localStorage.getItem(NAME_KEY) || '';
  if (params.get('room')) $('code-input').value = params.get('room').toUpperCase();

  $('code-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  function readName() {
    const name = $('name-input').value.trim();
    if (!name) {
      $('home-error').textContent = 'Сначала назовите себя.';
      $('name-input').focus();
      return null;
    }
    localStorage.setItem(NAME_KEY, name);
    return name;
  }

  $('home-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = readName();
    if (!name) return;
    // «Играть»: если код введён — входим в комнату, иначе создаём новую.
    const code = $('code-input').value.trim();
    const res = code ? await emit('room:join', { code, name }) : await emit('room:create', { name });
    if (res.error) $('home-error').textContent = res.error;
  });

  $('join-btn').addEventListener('click', async () => {
    const name = readName();
    if (!name) return;
    const code = $('code-input').value.trim();
    if (!code) {
      $('home-error').textContent = 'Введите код комнаты.';
      $('code-input').focus();
      return;
    }
    const res = await emit('room:join', { code, name });
    if (res.error) $('home-error').textContent = res.error;
  });

  $('leave-btn').addEventListener('click', async () => {
    if (state && state.phase !== 'lobby' && !confirm('Покинуть игру? Вернуться в эту партию уже не получится.')) return;
    await emit('room:leave');
    sessionStorage.removeItem(SESSION_KEY);
    state = null;
    gallery = null;
    history.replaceState(null, '', location.pathname);
    render();
  });

  socket.on('joined', ({ code, token }) => {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, token }));
    history.replaceState(null, '', `?room=${code}`);
    $('home-error').textContent = '';
  });

  // Переподключение после обновления страницы или обрыва связи.
  socket.on('connect', async () => {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (!saved) return;
    const res = await emit('room:join', { code: saved.code, token: saved.token, name: localStorage.getItem(NAME_KEY) || '' });
    if (res.error) {
      sessionStorage.removeItem(SESSION_KEY);
      state = null;
      render();
    }
  });

  socket.on('disconnect', () => toast('Связь потеряна, переподключаемся…'));

  socket.on('state', (s) => {
    clockOffset = s.serverNow - Date.now();
    state = s;
    render();
  });

  socket.on('gallery', (g) => {
    gallery = g;
    render();
  });

  // ---------- таймер ----------

  function tickTimer() {
    const t = $('timer');
    if (!state || !state.deadline) {
      t.classList.add('hidden');
      return;
    }
    const left = Math.max(0, Math.ceil((state.deadline - (Date.now() + clockOffset)) / 1000));
    t.classList.remove('hidden');
    t.classList.toggle('is-urgent', left <= 10 && ['reading', 'drawing', 'voting'].includes(state.phase));
    $('timer-text').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    if (state.phase === 'drawing' && left <= 0) autoSubmit();
  }
  setInterval(tickTimer, 250);

  // ---------- отрисовка ----------

  const SCREENS = {
    lobby: 'screen-lobby',
    generating: 'screen-generating',
    reading: 'screen-reading',
    lots: 'screen-lots',
    drawing: 'screen-drawing',
    collecting: 'screen-drawing',
    reveal: 'screen-reveal',
    voting: 'screen-voting',
    results: 'screen-results',
  };

  function show(screenId) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('hidden', s.id !== screenId));
  }

  function render() {
    if (!state) {
      $('topbar').classList.add('hidden');
      show('screen-home');
      lastPhase = null;
      return;
    }
    $('topbar').classList.remove('hidden');
    $('topbar-code').textContent = state.code;
    const phaseChanged = state.phase !== lastPhase;
    show(SCREENS[state.phase]);
    ({
      lobby: renderLobby,
      generating: () => { gallery = null; },
      reading: renderReading,
      lots: renderLots,
      drawing: renderDrawing,
      collecting: renderDrawing,
      reveal: renderReveal,
      voting: renderVoting,
      results: renderResults,
    })[state.phase](phaseChanged);
    lastPhase = state.phase;
    tickTimer();
  }

  function playerItem(p, extra) {
    return el('li', { class: `player${p.connected ? '' : ' is-away'}${p.id === state.you ? ' is-me' : ''}` },
      el('span', { class: 'player__shield', 'aria-hidden': 'true', text: p.name.charAt(0).toUpperCase() }),
      el('span', { class: 'player__name', text: p.name }),
      p.isHost ? el('span', { class: 'badge', text: 'хозяин', title: 'Хозяин комнаты' }) : null,
      !p.connected ? el('span', { class: 'badge badge--muted', text: 'отошёл' }) : null,
      extra || null);
  }

  function renderLobby(changed) {
    if (changed) {
      gallery = null;
      $('lobby-error').textContent = '';
    }
    $('lobby-code').textContent = state.code;
    const list = $('lobby-players');
    list.replaceChildren(...state.players.map((p) => playerItem(p)));
    const n = state.players.filter((p) => p.connected).length;
    const need = Math.max(0, state.minPlayers - n);
    $('start-btn').classList.toggle('hidden', !isHost());
    $('start-btn').disabled = need > 0;
    $('lobby-hint').textContent = isHost()
      ? need > 0 ? `Ждём ещё ${need} ${plural(need, 'игрока', 'игроков', 'игроков')}…` : `За столом ${n} из ${state.maxPlayers}. Можно начинать!`
      : `Ждём, пока хозяин начнёт игру. За столом ${n} из ${state.maxPlayers}.`;
  }

  $('start-btn').addEventListener('click', async () => {
    $('start-btn').disabled = true;
    const res = await emit('game:start');
    if (res.error) $('lobby-error').textContent = res.error;
    $('start-btn').disabled = false;
  });

  $('copy-link-btn').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?room=${state.code}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Ссылка скопирована');
    } catch {
      prompt('Скопируйте ссылку:', url);
    }
  });

  // --- чтение ---

  function renderReading(changed) {
    const { story, choices } = state;
    $('reading-title').textContent = story.title;
    const myChoice = choices[state.you];
    const pickers = {};
    for (const [id, page] of Object.entries(choices)) (pickers[page] ||= []).push(id);
    const list = $('reading-pages');
    list.replaceChildren(...story.pages.map((p, i) => {
      const chosen = myChoice === i;
      const who = pickers[i] || [];
      return el('li', { class: `page-card${chosen ? ' is-chosen' : ''}${who.length > 1 ? ' is-contested' : ''}` },
        el('div', { class: 'page-card__num', text: `Страница ${roman(i)}` }),
        el('p', { class: 'page-card__text', text: p.text }),
        el('p', { class: 'page-card__scene', text: `Сцена: ${p.scene}` }),
        el('div', { class: 'page-card__footer' },
          el('div', { class: 'page-card__who' }, ...who.map((id) => el('span', { class: `chip${id === state.you ? ' chip--me' : ''}`, text: nameOf(id) }))),
          el('button', {
            class: `btn btn--small${chosen ? ' btn--seal' : ''}`,
            type: 'button',
            text: chosen ? 'Выбрано ✓' : 'Хочу рисовать',
            onclick: () => emit('game:choose', { page: chosen ? null : i }),
          })));
    }));
    const inRound = state.players.filter((p) => p.inRound && p.connected);
    const ready = inRound.filter((p) => p.ready).length;
    const iAmReady = me()?.ready;
    $('ready-btn').textContent = iAmReady ? 'Подождите, я ещё читаю' : 'Я готов рисовать';
    $('ready-btn').classList.toggle('btn--seal', !iAmReady);
    $('ready-count').textContent = `Готовы: ${ready} из ${inRound.length}`;
    if (changed) window.scrollTo(0, 0);
  }

  $('ready-btn').addEventListener('click', () => emit('game:ready', { ready: !me()?.ready }));

  // --- жребий ---

  function renderLots(changed) {
    const box = $('lots');
    if (changed) lotsAnimated = false;
    if (!lotsAnimated) {
      lotsAnimated = true;
      box.replaceChildren(...state.lots.map((lot) => {
        const coin = el('div', { class: 'coin', 'aria-hidden': 'true' },
          el('div', { class: 'coin__face coin__face--front', text: '♛' }),
          el('div', { class: 'coin__face coin__face--back', text: '⚔' }));
        const names = el('div', { class: 'lot__names' }, ...lot.contenders.map((id) => el('span', { class: 'chip', 'data-id': id, text: nameOf(id) })));
        const verdict = el('p', { class: 'lot__verdict' });
        const title = lot.contenders.length === 2 ? 'Монетка' : 'Жребий';
        const node = el('div', { class: 'lot' },
          el('div', { class: 'lot__title', text: `${title} за страницу ${roman(lot.page)}` }), coin, names, verdict);
        // Анимация: имена мелькают, монетка крутится, затем объявляется победитель.
        let k = 0;
        const chips = [...names.children];
        const spin = setInterval(() => {
          chips.forEach((c, i) => c.classList.toggle('is-lit', i === k % chips.length));
          k++;
        }, 120);
        setTimeout(() => {
          clearInterval(spin);
          chips.forEach((c) => {
            c.classList.toggle('is-lit', c.dataset.id === lot.winner);
            c.classList.toggle('is-lost', c.dataset.id !== lot.winner);
          });
          coin.classList.add('is-done');
          const losers = lot.contenders.filter((id) => id !== lot.winner)
            .map((id) => `${nameOf(id)} → стр. ${lot.consolation[id] != null ? roman(lot.consolation[id]) : '—'}`);
          verdict.textContent = `Страница достаётся: ${nameOf(lot.winner)}. ${losers.length ? 'Остальным: ' + losers.join(', ') + '.' : ''}`;
        }, 2600);
        return node;
      }));
    }
    const mine = state.assignments[state.you];
    $('lots-mine').textContent = mine != null ? `Вы рисуете страницу ${roman(mine)}.` : '';
  }

  // --- рисование ---

  function renderDrawing(changed) {
    const page = state.assignments[state.you];
    if (!paint) paint = new window.Paint($('paint'));
    if (changed && lastPhase !== 'drawing' && lastPhase !== 'collecting') {
      paint.reset();
      submittedRound = false;
    }
    const player = me();
    const spectator = page == null;
    if (!spectator) {
      const p = state.story.pages[page];
      $('draw-page-num').textContent = `Ваша страница — ${roman(page)}`;
      $('draw-text').textContent = p.text;
      $('draw-scene').textContent = p.scene;
    } else {
      $('draw-page-num').textContent = 'Вы наблюдаете';
      $('draw-text').textContent = 'В этом раунде вам не досталось страницы.';
      $('draw-scene').textContent = '—';
    }
    $('draw-story').replaceChildren(...state.story.pages.map((p, i) => el('li', { class: i === page ? 'is-mine' : '', text: p.text })));

    const submitted = spectator || player?.submitted || submittedRound;
    paint.setLocked(!!submitted);
    $('submit-btn').classList.toggle('hidden', !!submitted);
    const inRound = state.players.filter((p) => p.inRound && p.connected);
    const done = inRound.filter((p) => p.submitted).length;
    $('submit-status').textContent = submitted
      ? `Работа сдана. Сдали ${done} из ${inRound.length}.`
      : `Сдали ${done} из ${inRound.length}`;
    if (state.phase === 'collecting') autoSubmit();
  }

  async function submitDrawing() {
    if (submittedRound || !paint || state.assignments[state.you] == null) return;
    submittedRound = true;
    paint.setLocked(true);
    $('submit-btn').classList.add('hidden');
    const res = await emit('game:drawing', { image: paint.exportImage() });
    if (res.error) {
      submittedRound = false;
      toast(res.error);
      render();
    }
  }

  function autoSubmit() {
    if (!submittedRound && state && (state.phase === 'drawing' || state.phase === 'collecting')) submitDrawing();
  }

  $('submit-btn').addEventListener('click', () => {
    if (confirm('Сдать работу? После этого рисунок уже не изменить.')) submitDrawing();
  });

  // --- книга ---

  function illustration(page, cls) {
    if (page.image) return el('img', { class: cls, src: page.image, alt: `Иллюстрация к странице ${roman(page.index)} — ${page.authorName}` });
    return el('div', { class: `${cls} ${cls}--empty` }, el('span', { text: 'Иллюстрация утеряна в веках' }));
  }

  function renderReveal(changed) {
    const book = $('book');
    if (changed) {
      lastRevealIndex = null;
      book.replaceChildren();
    }
    const idx = state.revealIndex;
    $('next-page-btn').classList.toggle('hidden', !isHost());
    if (!gallery) {
      book.replaceChildren(el('div', { class: 'book__loading', text: 'Переплётчик собирает книгу…' }));
      return;
    }
    const total = gallery.pages.length;
    $('book-counter').textContent = idx < 0 ? 'Обложка' : `Страница ${roman(idx)} из ${roman(total - 1)}`;
    if (idx === lastRevealIndex && book.childElementCount) return;
    book.querySelector('.book__loading')?.remove();
    const prev = book.querySelector('.spread:not(.is-turning-out)');
    lastRevealIndex = idx;

    let spread;
    if (idx < 0) {
      spread = el('div', { class: 'spread spread--cover' },
        el('div', { class: 'cover' },
          el('div', { class: 'cover__ornament', text: '❦' }),
          el('h2', { class: 'cover__title', text: gallery.title }),
          el('div', { class: 'cover__authors', text: 'Иллюстрировали: ' + [...new Set(gallery.pages.map((p) => p.authorName).filter(Boolean))].join(', ') }),
          el('div', { class: 'cover__ornament', text: '❦' })));
    } else {
      const p = gallery.pages[idx];
      spread = el('div', { class: 'spread' },
        el('div', { class: 'leaf leaf--left' },
          el('div', { class: 'leaf__num', text: `— ${roman(idx)} —` }),
          el('p', { class: 'leaf__text illuminated', text: p.text })),
        el('div', { class: 'leaf leaf--right' },
          illustration(p, 'leaf__img'),
          el('div', { class: 'leaf__author', text: p.authorName ? `Иллюстрация: ${p.authorName}` : '' })));
    }
    spread.classList.add('is-turning-in');
    if (prev) {
      prev.classList.add('is-turning-out');
      setTimeout(() => prev.remove(), 900);
    }
    book.append(spread);
  }

  $('next-page-btn').addEventListener('click', () => emit('game:next-page'));

  // --- голосование ---

  function renderVoting(changed) {
    if (!gallery) return;
    const liked = new Set(state.myLikes || []);
    if (changed || !$('vote-gallery').childElementCount) {
      $('vote-gallery').replaceChildren(...gallery.pages.filter((p) => p.authorId).map((p) => {
        const own = p.authorId === state.you;
        return el('figure', { class: 'card', 'data-author': p.authorId },
          illustration(p, 'card__img'),
          el('figcaption', { class: 'card__caption' },
            el('span', { class: 'card__page', text: `Стр. ${roman(p.index)}` }),
            el('span', { class: 'card__author', text: p.authorName }),
            own
              ? el('span', { class: 'badge badge--muted', text: 'ваша' })
              : el('button', {
                  class: 'like',
                  type: 'button',
                  'aria-pressed': 'false',
                  title: 'Нравится',
                  onclick: () => emit('game:like', { authorId: p.authorId }),
                }, el('span', { class: 'like__heart', text: '❤' }), el('span', { class: 'like__label', text: 'Нравится' }))),
          el('p', { class: 'card__text', text: p.text }));
      }));
    }
    document.querySelectorAll('#vote-gallery .card').forEach((card) => {
      const btn = card.querySelector('.like');
      if (!btn) return;
      const on = liked.has(card.dataset.author);
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', String(on));
    });
    const inRound = state.players.filter((p) => p.inRound && p.connected);
    const done = inRound.filter((p) => p.votedDone).length;
    const iDone = me()?.votedDone;
    $('vote-done-btn').disabled = !!iDone;
    $('vote-done-btn').textContent = iDone ? 'Ждём остальных…' : 'Готово';
    $('vote-count').textContent = `Проголосовали: ${done} из ${inRound.length}`;
  }

  $('vote-done-btn').addEventListener('click', () => emit('game:vote-done'));

  // --- итоги ---

  function renderResults() {
    $('results-title').textContent = gallery?.title || state.story?.title || '';
    const byAuthor = {};
    for (const p of gallery?.pages || []) if (p.authorId) byAuthor[p.authorId] = p;
    const top = state.results[0]?.likes || 0;
    $('results-list').replaceChildren(...state.results.map((r, i) => {
      const winner = top > 0 && r.likes === top;
      const page = byAuthor[r.authorId];
      return el('li', { class: `podium__item${winner ? ' is-winner' : ''}` },
        el('div', { class: 'podium__place', text: winner ? '♛' : String(i + 1) }),
        page ? illustration(page, 'podium__img') : null,
        el('div', { class: 'podium__info' },
          el('div', { class: 'podium__name', text: r.authorName }),
          el('div', { class: 'muted', text: `Страница ${roman(r.page)}` }),
          winner ? el('div', { class: 'podium__title', text: 'Придворный живописец' }) : null),
        el('div', { class: 'podium__likes', text: `❤ ${r.likes}` }));
    }));
    const scores = state.players.slice().sort((a, b) => b.score - a.score);
    $('results-scores').replaceChildren(...scores.map((p) => playerItem(p, el('span', { class: 'player__score', text: `❤ ${p.score}` }))));
    $('again-btn').classList.toggle('hidden', !isHost());
    $('results-hint').textContent = isHost() ? '' : 'Хозяин комнаты может начать новое сказание.';
  }

  $('again-btn').addEventListener('click', async () => {
    const res = await emit('game:start');
    if (res.error) toast(res.error);
  });

  render();
})();
