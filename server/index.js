'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Lobby } = require('./game');

const PORT = Number(process.env.PORT || 3000);

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
// Рисунки передаются как data URL, поэтому лимит сообщения увеличен.
const io = new Server(server, { maxHttpBufferSize: 4 * 1024 * 1024 });
const lobby = new Lobby(io);

io.on('connection', (socket) => {
  let room = null;
  let playerId = null;

  const attach = (r, player) => {
    room = r;
    playerId = player.id;
    socket.join(r.code);
    socket.emit('joined', { code: r.code, playerId: player.id, token: player.token });
    r.broadcast();
    r.sendGalleryTo(player.id);
  };

  const guard = (fn) => (...args) => {
    const ack = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
    try {
      const result = fn(...args);
      if (result && typeof result.then === 'function') {
        result.then((r) => ack(r || {}), (err) => {
          console.error(err);
          ack({ error: 'Что-то пошло не так.' });
        });
      } else {
        ack(result || {});
      }
    } catch (err) {
      console.error(err);
      ack({ error: 'Что-то пошло не так.' });
    }
  };

  socket.on('room:create', guard(({ name } = {}) => {
    if (room) return { error: 'Вы уже в комнате.' };
    const r = lobby.createRoom();
    const res = r.addPlayer(socket, name);
    if (res.error) return res;
    attach(r, res.player);
    return { code: r.code };
  }));

  socket.on('room:join', guard(({ code, name, token } = {}) => {
    if (room) return { error: 'Вы уже в комнате.' };
    const r = lobby.get(code);
    if (!r) return { error: 'Комната с таким кодом не найдена.' };
    if (token) {
      const player = r.reconnect(socket, token);
      if (player) {
        attach(r, player);
        return { code: r.code, reconnected: true };
      }
    }
    const res = r.addPlayer(socket, name);
    if (res.error) return res;
    attach(r, res.player);
    return { code: r.code };
  }));

  socket.on('room:leave', guard(() => {
    if (!room) return {};
    socket.leave(room.code);
    const r = room;
    room = null;
    r.disconnect(playerId);
    // Добровольный выход — игрока можно убрать окончательно.
    if (r.phase !== 'lobby') {
      const p = r.players.get(playerId);
      if (p) p.token = null;
    }
    playerId = null;
    return {};
  }));

  socket.on('game:start', guard(() => room?.start(playerId)));
  socket.on('game:choose', guard(({ page } = {}) => room?.choose(playerId, page)));
  socket.on('game:ready', guard(({ ready } = {}) => room?.setReady(playerId, !!ready)));
  socket.on('game:drawing', guard(({ image } = {}) => room?.submitDrawing(playerId, image)));
  socket.on('game:next-page', guard(() => room?.nextPage(playerId)));
  socket.on('game:like', guard(({ authorId } = {}) => room?.toggleLike(playerId, authorId)));
  socket.on('game:vote-done', guard(() => room?.voteDone(playerId)));
  socket.on('game:lobby', guard(() => room?.backToLobby(playerId)));

  socket.on('disconnect', () => {
    if (room && playerId) room.disconnect(playerId);
  });
});

server.listen(PORT, () => {
  console.log(`Drawoff слушает http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY && process.env.STORY_AI !== 'off') {
    console.log('ANTHROPIC_API_KEY не задан — истории будут собираться офлайн-генератором.');
  }
});
