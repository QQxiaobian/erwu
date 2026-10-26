import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { MODE_INFO, Room } from './room.js';
import { verifyToken, parseCookies } from './auth.js';
import { findById, recordMatch, publicUser } from './db.js';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function roomId() {
  return Array.from({ length: 4 }, () => ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)]).join('');
}

export class Hub {
  constructor() {
    this.rooms = new Map();
    this.sockets = new Map(); // userId -> Set<ws>
    this.wss = null;
    this.timer = null;
  }

  attach(server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.timer = setInterval(() => this.tick(), 500);
    this.timer.unref?.();
  }

  tick() {
    for (const room of this.rooms.values()) {
      const before = room.state;
      if (room.tick()) {
        this.broadcastRoom(room);
        if (room.state !== before) this.broadcastRoomList();
      }
    }
  }

  onConnection(ws, req) {
    const cookies = parseCookies(req);
    const user = verifyToken(cookies.erwu_token);
    if (!user) {
      try {
        ws.send(JSON.stringify({ t: 'unauthorized' }));
      } catch {}
      ws.close(4001, 'unauthorized');
      return;
    }
    const full = findById(user.id);
    if (!full || full.disabled) {
      ws.close(4002, 'disabled');
      return;
    }
    ws.userId = user.id;
    ws.isAlive = true;

    if (!this.sockets.has(user.id)) this.sockets.set(user.id, new Set());
    this.sockets.get(user.id).add(ws);

    const inRoom = this.roomOfUser(user.id);
    if (inRoom) inRoom.setConnected(user.id, true);

    this.send(ws, {
      t: 'hello',
      user: publicUser(full),
      rooms: this.roomList(),
      onlineCount: this.onlineCount(),
      onlineUsers: this.onlineUsers(),
      room: inRoom ? inRoom.viewFor(user.id) : null,
    });

    ws.on('message', (raw) => this.onMessage(ws, raw));
    ws.on('close', () => this.onClose(ws));
    ws.on('error', () => {});
    this.broadcastRoomList();
  }

  onClose(ws) {
    const set = this.sockets.get(ws.userId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        this.sockets.delete(ws.userId);
        const room = this.roomOfUser(ws.userId);
        if (room) {
          room.setConnected(ws.userId, false);
          this.broadcastRoom(room);
        }
        this.broadcastRoomList();
      }
    }
  }

  send(ws, obj) {
    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(obj));
      } catch {}
    }
  }

  sendToUser(userId, obj) {
    const set = this.sockets.get(userId);
    if (!set) return;
    for (const ws of set) this.send(ws, obj);
  }

  roomOfUser(userId) {
    for (const room of this.rooms.values()) {
      if (room.hasMember(userId)) return room;
    }
    return null;
  }

  onlineCount() {
    return this.sockets.size;
  }

  onlineUsers() {
    return [...this.sockets.keys()]
      .map((id) => findById(id))
      .filter(Boolean)
      .map((u) => publicUser(u));
  }

  roomList() {
    return [...this.rooms.values()]
      .filter((r) => r.state !== 'finished' || r.seats.some(Boolean))
      .map((r) => ({
        id: r.id,
        name: r.name,
        mode: r.mode,
        modeName: MODE_INFO[r.mode].name,
        maxSeats: r.maxSeats,
        count: r.seats.filter((s) => s && !s.detached).length,
        state: r.state,
        hostName: (r.seats.find((s) => s && s.userId === r.hostId) || {}).name || '-',
        players: r.seats.filter((s) => s && !s.detached).map((s) => s.name),
        roundNo: r.roundNo,
      }));
  }

  broadcastRoomList() {
    const rooms = this.roomList();
    const onlineCount = this.onlineCount();
    const onlineUsers = this.onlineUsers();
    for (const set of this.sockets.values()) {
      for (const ws of set) this.send(ws, { t: 'rooms', rooms, onlineCount, onlineUsers });
    }
  }

  broadcastRoom(room) {
    for (const seat of room.seats) {
      if (!seat || seat.detached) continue;
      this.sendToUser(seat.userId, { t: 'room', room: room.viewFor(seat.userId) });
    }
  }

  onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return this.send(ws, { t: 'error', error: '消息格式错误' });
    }
    if (!msg || typeof msg.t !== 'string') return;
    const user = findById(ws.userId);
    if (!user || user.disabled) return;

    try {
      this.handle(ws, user, msg);
    } catch (e) {
      console.error('handle message error', e);
      this.send(ws, { t: 'error', error: '服务器处理出错' });
    }
  }

  handle(ws, user, msg) {
    const t = msg.t;
    if (t === 'ping') return this.send(ws, { t: 'pong' });

    if (t === 'rooms.list') return this.send(ws, { t: 'rooms', rooms: this.roomList() });

    if (t === 'room.create') {
      if (this.roomOfUser(user.id)) return this.send(ws, { t: 'error', error: '你已在房间中，请先离开' });
      const mode = msg.mode;
      if (!MODE_INFO[mode]) return this.send(ws, { t: 'error', error: '玩法不存在' });
      const maxSeats = Number(msg.seats);
      if (!MODE_INFO[mode].seats.includes(maxSeats)) {
        return this.send(ws, { t: 'error', error: '该玩法不支持此人数' });
      }
      let id = roomId();
      while (this.rooms.has(id)) id = roomId();
      const name = String(msg.name || '').trim().slice(0, 20) || `${MODE_INFO[mode].name}房间`;
      const room = new Room({ id, name, mode, maxSeats, hostId: user.id });
      room.onRoundEnd = (r, result) => this.onRoundEnd(r, result);
      room.addPlayer(user);
      this.rooms.set(id, room);
      this.send(ws, { t: 'joined', roomId: id });
      this.broadcastRoom(room);
      this.broadcastRoomList();
      return;
    }

    if (t === 'room.join') {
      const room = this.rooms.get(String(msg.roomId || '').toUpperCase());
      if (!room) return this.send(ws, { t: 'error', error: '房间不存在' });
      const current = this.roomOfUser(user.id);
      if (current && current !== room) return this.send(ws, { t: 'error', error: '你已在其他房间中' });
      const res = room.addPlayer(user);
      if (!res.ok) return this.send(ws, { t: 'error', error: res.error });
      this.send(ws, { t: 'joined', roomId: room.id });
      this.broadcastRoom(room);
      this.broadcastRoomList();
      return;
    }

    if (t === 'room.leave') {
      const room = this.roomOfUser(user.id);
      if (!room) return this.send(ws, { t: 'left' });
      room.leave(user.id);
      this.send(ws, { t: 'left' });
      // 没有真人成员时回收房间，避免托管中的僵尸房间
      const hasHuman = room.seats.some((s) => s && !s.isBot && !s.detached);
      if (!hasHuman) {
        this.rooms.delete(room.id);
      } else {
        this.broadcastRoom(room);
      }
      this.broadcastRoomList();
      return;
    }

    if (t === 'room.view') {
      const room = this.roomOfUser(user.id);
      if (room) this.send(ws, { t: 'room', room: room.viewFor(user.id) });
      return;
    }

    const room = this.roomOfUser(user.id);
    if (!room) return this.send(ws, { t: 'error', error: '你不在房间中' });

    let res = { ok: true };
    switch (t) {
      case 'room.ready':
        res = room.setReady(user.id, msg.ready);
        break;
      case 'seat.take':
        res = room.takeSeat(user.id, Number(msg.seat));
        break;
      case 'room.addbot':
        res = room.addBot(user.id);
        break;
      case 'room.removebot':
        res = room.removeBot(user.id);
        break;
      case 'room.start':
        res = room.startRound(user.id);
        break;
      case 'declare':
        res = room.declare(user.id, msg.cards);
        break;
      case 'declare.pass':
        res = room.passDeclaration(user.id);
        break;
      case 'bid':
        res = room.bid(user.id, msg.value);
        break;
      case 'bury':
        res = room.bury(user.id, msg.suit, msg.cards);
        break;
      case 'play':
        res = room.play(user.id, msg.cards);
        break;
      default:
        return this.send(ws, { t: 'error', error: '未知操作' });
    }

    if (!res.ok) return this.send(ws, { t: 'error', error: res.error });
    if (res.note) this.send(ws, { t: 'toast', text: res.note });
    this.broadcastRoom(room);
    this.broadcastRoomList();
  }

  onRoundEnd(room, result) {
    const players = room.seats.filter(Boolean).map((seat, i) => {
      const idx = room.seatOf(seat.userId);
      const side = result.sides.find((s) => s.seats.includes(idx));
      return {
        userId: seat.userId,
        name: seat.name,
        seat: idx,
        points: side ? side.points : 0,
        won: side ? !!side.won : false,
      };
    });
    try {
      recordMatch({ mode: room.mode, roomName: room.name, players, result });
    } catch (e) {
      console.error('record match error', e);
    }
    this.broadcastRoomList();
  }
}
