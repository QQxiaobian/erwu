import {
  SUITS,
  SUIT_NAMES,
  makeDeck,
  shuffle,
  isTrump,
  power,
  sortHand,
  sortBySuit,
  cardPoints,
  handPoints,
  isCombo25,
  detectLead,
  checkThrow,
  validateFollow,
  resolveTrick,
  cardsName,
  autoSelect,
} from './game/cards.js';
import { cardCounterEnabled } from './db.js';

export const MODE_INFO = {
  grab: { name: '抢庄模式', seats: [3, 4], desc: '亮 2 定主，25 反主，一人坐庄' },
  team: { name: '队家模式', seats: [4], desc: '固定 4 人 2V2，对家为队友' },
  ga: { name: '噶点模式', seats: [4], desc: '叫分定庄，庄家自选主花色' },
};

const TURN_MS = 30000;
const DECLARE_MS = 15000;
const BID_MS = 20000;
const BURY_MS = 60000;
const RESOLVE_MS = 1200;

const BOT_NAMES = ['阿五', '小十', '老K', '王炸', '铁蛋', '黑桃', '红梅', '方片', '顺子', '同花'];

export class Room {
  constructor({ id, name, mode, maxSeats, hostId }) {
    const info = MODE_INFO[mode];
    if (!info) throw new Error('未知玩法');
    this.id = id;
    this.name = name;
    this.mode = mode;
    this.maxSeats = maxSeats;
    this.hostId = hostId;
    this.seats = new Array(maxSeats).fill(null);
    this.state = 'waiting';
    this.roundNo = 0;
    this.version = 0;
    this.log = [];
    this.createdAt = Date.now();
    this.deadline = null;

    this.trumpSuit = null;
    this.declarerSeat = null;
    // 队家模式：庄家队（0/1）与庄家座位，跨局保留，发牌前按座位顺序轮换
    this.bankerTeam = 0;
    this.dealerSeat = 0;
    this.bidValue = null;
    this.bidding = null;
    this.declaration = null;
    this.redeals = 0;

    this.bottomPool = [];
    this.bottom = [];
    this.bottomPickup = [];
    this.bottomRevealed = false;

    this.trick = { lead: null, plays: [] };
    this.lastTrick = null;
    this.pendingResolveAt = null;
    this.turn = null;
    this.result = null;
    this.onRoundEnd = null;
    this.playedCards = [];

    this.botSeq = 0;
    this.botPassed = new Set();
    this.botKey = null;
    this.botAt = 0;
  }

  _touch() {
    this.version++;
  }

  _delayFor(seatIdx, base) {
    const s = this.seats[seatIdx];
    if (!s || !s.connected) return Math.min(base, 6000);
    return base;
  }

  _buryDelay() {
    const s = this.seats[this.declarerSeat];
    return s && s.connected ? BURY_MS : 12000;
  }

  _log(text, kind = 'info') {
    this.log.push({ at: Date.now(), text, kind });
    if (this.log.length > 80) this.log.splice(0, this.log.length - 80);
    this._touch();
  }

  _autoTag(seat, isAuto) {
    if (!isAuto) return '';
    return seat && seat.isBot ? '（人机）' : '（托管）';
  }

  get full() {
    return this.seats.every(Boolean);
  }

  seatOf(userId) {
    return this.seats.findIndex((s) => s && s.userId === userId);
  }

  // 房间成员：牌局中主动离开的座位仍留在桌上托管，但不再算作房间成员
  hasMember(userId) {
    const idx = this.seatOf(userId);
    return idx >= 0 && !this.seats[idx].detached;
  }

  addPlayer(user) {
    const existing = this.seatOf(user.id);
    if (existing >= 0) {
      const seat = this.seats[existing];
      if (seat.detached && this.state !== 'waiting' && this.state !== 'finished') {
        seat.detached = false;
        seat.connected = true;
        this._log(`${seat.name} 重新回到牌桌`, 'join');
        this._touch();
        return { ok: true, seat: existing };
      }
      return { ok: true };
    }
    if (this.state !== 'waiting' && this.state !== 'finished') {
      return { ok: false, error: '牌局已开始，无法加入' };
    }
    const idx = this.seats.indexOf(null);
    if (idx < 0) return { ok: false, error: '房间已满' };
    const name = user.nickname || user.username;
    this.seats[idx] = {
      userId: user.id,
      username: user.username,
      name,
      connected: true,
      ready: false,
      hand: [],
      captured: 0,
    };
    this._log(`${name} 加入房间（${idx + 1} 号位）`, 'join');
    return { ok: true, seat: idx };
  }

  addBot(userId) {
    if (userId !== this.hostId) return { ok: false, error: '只有房主可以添加人机' };
    if (this.state !== 'waiting' && this.state !== 'finished') {
      return { ok: false, error: '牌局进行中无法添加人机' };
    }
    const idx = this.seats.indexOf(null);
    if (idx < 0) return { ok: false, error: '房间已满' };
    this.botSeq++;
    const base = BOT_NAMES[(this.botSeq - 1) % BOT_NAMES.length];
    const name = this.botSeq > BOT_NAMES.length ? `${base}${Math.ceil(this.botSeq / BOT_NAMES.length)}` : base;
    this.seats[idx] = {
      userId: `bot:${this.id}:${this.botSeq}`,
      username: `bot${this.botSeq}`,
      name: `机器人·${name}`,
      isBot: true,
      connected: true,
      ready: true,
      hand: [],
      captured: 0,
    };
    this._log(`人机 ${this.seats[idx].name} 加入房间（${idx + 1} 号位）`, 'join');
    this._touch();
    return { ok: true, seat: idx };
  }

  removeBot(userId) {
    if (userId !== this.hostId) return { ok: false, error: '只有房主可以移除人机' };
    if (this.state !== 'waiting' && this.state !== 'finished') {
      return { ok: false, error: '牌局进行中无法移除人机' };
    }
    const idx = this.seats.map((s, i) => (s && s.isBot ? i : -1)).filter((i) => i >= 0).pop();
    if (idx === undefined) return { ok: false, error: '房间里没有人机' };
    this._log(`人机 ${this.seats[idx].name} 被移出房间`, 'leave');
    this.seats[idx] = null;
    this._touch();
    return { ok: true };
  }

  leave(userId) {
    const idx = this.seatOf(userId);
    if (idx < 0) return { ok: false, error: '你不在该房间' };
    const seat = this.seats[idx];
    if (this.state === 'waiting' || this.state === 'finished') {
      this.seats[idx] = null;
      this._log(`${seat.name} 离开了房间`, 'leave');
      if (this.hostId === userId) {
        const next = this.seats.find((s) => s && !s.isBot);
        if (next) this.hostId = next.userId;
      }
      if (!this.seats.some((s) => s && !s.isBot)) this.seats.fill(null);
      this._touch();
    } else {
      seat.connected = false;
      seat.detached = true;
      if (this.hostId === userId) {
        const next = this.seats.find((s) => s && s.connected && !s.isBot && !s.detached);
        if (next) this.hostId = next.userId;
      }
      this._log(`${seat.name} 离开牌局，进入托管`, 'warn');
    }
    return { ok: true };
  }

  setConnected(userId, connected) {
    const idx = this.seatOf(userId);
    if (idx < 0) return;
    const seat = this.seats[idx];
    if (seat.detached) return;
    if (seat.connected === connected) return;
    seat.connected = connected;
    if (this.state !== 'finished') {
      this._log(`${seat.name}${connected ? '重新连接' : '断线，进入托管'}`, connected ? 'join' : 'warn');
    }
    this._touch();
  }

  setReady(userId, ready) {
    const idx = this.seatOf(userId);
    if (idx < 0) return { ok: false, error: '你不在该房间' };
    if (this.state !== 'waiting') return { ok: false, error: '牌局已开始' };
    this.seats[idx].ready = !!ready;
    this._touch();
    return { ok: true };
  }

  // 换座：与目标座位交换；目标为空则直接移过去
  takeSeat(userId, targetIdx) {
    if (this.state !== 'waiting' && this.state !== 'finished') {
      return { ok: false, error: '牌局进行中不能换座' };
    }
    const cur = this.seatOf(userId);
    if (cur < 0) return { ok: false, error: '你不在该房间' };
    if (targetIdx === cur) return { ok: true };
    if (!Number.isInteger(targetIdx) || targetIdx < 0 || targetIdx >= this.maxSeats) {
      return { ok: false, error: '座位号无效' };
    }
    [this.seats[cur], this.seats[targetIdx]] = [this.seats[targetIdx], this.seats[cur]];
    const moved = this.seats[targetIdx];
    const other = this.seats[cur];
    if (other) {
      this._log(`${moved.name} 与 ${other.name} 交换座位`, 'info');
    } else {
      this._log(`${moved.name} 坐到 ${targetIdx + 1} 号位`, 'info');
    }
    // 换座后重置准备状态
    moved.ready = false;
    if (other) other.ready = false;
    this._touch();
    return { ok: true };
  }

  _deal() {
    const deck = shuffle(makeDeck());
    const per = Math.floor(48 / this.maxSeats);
    let cursor = 0;
    for (const seat of this.seats) {
      seat.hand = deck.slice(cursor, cursor + per);
      // 噶点模式发牌后立即按花色整理（尚未定主花色）
      if (this.mode === 'ga') seat.hand = sortBySuit(seat.hand);
      cursor += per;
      seat.captured = 0;
    }
    this.bottomPool = deck.slice(cursor);
    this.bottom = [];
    this.bottomPickup = [];
    this.bottomRevealed = false;
    this.trumpSuit = null;
    // 队家模式庄家已在发牌前确定，亮主只决定主花色
    this.declarerSeat = this.mode === 'team' ? this.dealerSeat : null;
    this.bidValue = null;
    this.trick = { lead: null, plays: [] };
    this.lastTrick = null;
    this.pendingResolveAt = null;
    this.turn = null;
    this.result = null;
    this.playedCards = [];
    this.deadline = null;
  }

  startRound(userId) {
    if (userId !== this.hostId) {
      const hostSeat = this.seatOf(this.hostId);
      const hostGone = hostSeat < 0 || !this.seats[hostSeat] || !this.seats[hostSeat].connected;
      if (!hostGone) return { ok: false, error: '只有房主可以开始牌局' };
    }
    if (this.state !== 'waiting' && this.state !== 'finished') return { ok: false, error: '当前不能开始新一局' };
    // 上一局中途离开的玩家不再占用座位
    if (this.seats.some((s) => s && s.detached)) {
      this.seats = this.seats.map((s) => (s && s.detached ? null : s));
      if (this.hostId && this.seatOf(this.hostId) < 0) {
        const next = this.seats.find((s) => s && !s.isBot);
        this.hostId = next ? next.userId : null;
      }
    }
    if (!this.full) return { ok: false, error: '座位还没有坐满' };

    this.roundNo++;
    this.redeals = 0;
    // 队家模式：发牌之前先按顺序确定本局庄家
    if (this.mode === 'team') this._rotateBanker();
    this._deal();
    this.declaration = null;
    this.bidding = null;

    if (this.mode === 'ga') {
      this._initBidding();
      this._log(`第 ${this.roundNo} 局开始，发牌完成，进入叫分`, 'round');
    } else {
      this._initDeclaration();
      if (this.mode === 'team') {
        this._log(
          `第 ${this.roundNo} 局开始，发牌完成。本局庄家：${this.seats[this.dealerSeat].name}（${this.bankerTeam === 0 ? '一队' : '二队'}），请亮主`,
          'round',
        );
      } else {
        this._log(`第 ${this.roundNo} 局开始，发牌完成，请亮主`, 'round');
      }
    }
    this._touch();
    return { ok: true };
  }

  // 队家模式庄家轮换：上一局庄家队守庄成功则庄家队不变，常家上庄则庄家队换成常家队；
  // 然后从上一局庄家的下家开始按座位顺序，取第一个属于庄家队的玩家坐庄。
  _rotateBanker() {
    const res = this.result;
    if (res && res.mode === 'team' && res.sides) {
      const prevDealer = Number.isInteger(res.declarerSeat) ? res.declarerSeat : this.dealerSeat;
      const prevTeam = prevDealer % 2;
      this.bankerTeam = res.winnerSide === 'defenders' ? 1 - prevTeam : prevTeam;
      const from = (prevDealer + 1) % this.maxSeats;
      for (let k = 0; k < this.maxSeats; k++) {
        const i = (from + k) % this.maxSeats;
        if (i % 2 === this.bankerTeam) {
          this.dealerSeat = i;
          break;
        }
      }
    } else {
      // 第一局：一队先坐庄，座位 0 拿底牌
      this.bankerTeam = 0;
      this.dealerSeat = 0;
    }
  }

  _initDeclaration(redeal = false) {
    this.state = 'declaring';
    this.declaration = { list: [], passed: new Set(), last: null };
    this.botPassed = new Set();
    this.trumpSuit = null;
    // 队家模式庄家已在发牌前定好，这里保留
    this.declarerSeat = this.mode === 'team' ? this.dealerSeat : null;
    this.deadline = Date.now() + (redeal ? 12000 : DECLARE_MS);
    this._touch();
  }

  declare(userId, cardIds) {
    if (this.state !== 'declaring') return { ok: false, error: '当前不是亮主阶段' };
    const idx = this.seatOf(userId);
    if (idx < 0) return { ok: false, error: '你不在该房间' };
    const seat = this.seats[idx];
    const ids = [...new Set(cardIds || [])];
    if (ids.length !== (cardIds || []).length) return { ok: false, error: '牌重复' };
    const cards = ids.map((id) => seat.hand.find((c) => c.id === id)).filter(Boolean);
    if (cards.length !== ids.length) return { ok: false, error: '你没有这些牌' };

    let kind;
    let suit;
    if (cards.length === 1 && cards[0].r === '2') {
      kind = 'single2';
      if (this.trumpSuit) return { ok: false, error: '已有亮主，只能用同花色 25 组合反主' };
      suit = cards[0].s;
    } else if (cards.length === 2 && isCombo25(cards, this.trumpSuit || SUITS[0])) {
      if (!this.trumpSuit) return { ok: false, error: '请先用单张 2 亮主' };
      suit = cards[0].s;
      if (suit === this.trumpSuit) return { ok: false, error: '反主必须更换主花色' };
      kind = 'combo25';
    } else {
      return { ok: false, error: '亮主只能用单张 2，反主只能用同花色 25 组合' };
    }

    this.trumpSuit = suit;
    // 队家模式庄家固定，亮主/反主只换主花色
    this.declarerSeat = this.mode === 'team' ? this.dealerSeat : idx;
    this.declaration.passed.delete(idx);
    this.declaration.last = { seat: idx, name: seat.name, suit, kind, cards: cards.map((c) => c.id), at: Date.now() };
    this.declaration.list.push(this.declaration.last);
    this._log(
      `${seat.name} ${kind === 'single2' ? '亮主' : '反主'}：${cardsName(cards)}，${SUIT_NAMES[suit]}成为主花色`,
      'declare',
    );
    this._touch();
    return { ok: true };
  }

  passDeclaration(userId) {
    if (this.state !== 'declaring') return { ok: false, error: '当前不是亮主阶段' };
    const idx = this.seatOf(userId);
    if (idx < 0) return { ok: false, error: '你不在该房间' };
    this.declaration.passed.add(idx);
    this._touch();
    if (this.declaration.passed.size >= this.maxSeats) {
      this._finalizeDeclaration();
    }
    return { ok: true };
  }

  _finalizeDeclaration() {
    if (this.state !== 'declaring') return;
    const last = this.declaration && this.declaration.last;
    if (last) {
      this.trumpSuit = last.suit;
      // 队家模式庄家发牌前已定，亮主只决定主花色
      this.declarerSeat = this.mode === 'team' ? this.dealerSeat : last.seat;
      this._log(
        `定主：${SUIT_NAMES[last.suit]}，${this.seats[this.declarerSeat].name} 坐庄扣底`,
        'round',
      );
    } else if (this.mode === 'team') {
      // 队家模式：第一轮无人亮主重新发牌；再次无人亮主则开底牌定主
      if (this.redeals < 1) {
        this.redeals++;
        this._deal();
        this._initDeclaration(true);
        this._log('无人亮主，重新发牌', 'warn');
        return;
      }
      this._openBottomTrump();
    } else if (this.redeals < 2) {
      this.redeals++;
      this._deal();
      this._initDeclaration(true);
      this._log('无人亮主，重新发牌', 'warn');
      return;
    } else {
      const suit = SUITS[Math.floor(Math.random() * SUITS.length)];
      this.trumpSuit = suit;
      this.declarerSeat = 0;
      this._log(`无人亮主，系统随机定主：${SUIT_NAMES[suit]}，${this.seats[0].name} 坐庄`, 'warn');
    }
    this.declaration = null;
    this._pickupBottom();
    this.state = 'burying';
    this.deadline = Date.now() + this._buryDelay();
    this._touch();
  }

  // 队家模式无人亮主：按顺序开底牌定主。
  // 底牌中有 2 则第一张 2 的花色为主，否则底牌中最大一张牌的花色为主。
  _openBottomTrump() {
    const pool = this.bottomPool.slice();
    if (!pool.length) return;
    const firstTwo = pool.find((c) => c.r === '2');
    let trigger;
    if (firstTwo) {
      trigger = firstTwo;
    } else {
      trigger = pool.reduce((best, c) => (power(c, null) > power(best, null) ? c : best), pool[0]);
    }
    this.trumpSuit = trigger.s;
    this.declarerSeat = this.dealerSeat;
    this.bottomPickup = pool.slice();
    this.bottomRevealed = true;
    this._log(
      `无人亮主，开底牌定主：${cardsName(pool)}，${SUIT_NAMES[trigger.s]} 成为主花色，${this.seats[this.dealerSeat].name} 坐庄`,
      'round',
    );
  }

  _pickupBottom() {
    if (!this.bottomPool.length) return;
    const seat = this.seats[this.declarerSeat];
    // 抓底牌后公开这 6 张，所有玩家可见
    this.bottomPickup = this.bottomPool.slice();
    this.bottomRevealed = true;
    seat.hand.push(...this.bottomPool);
    this.bottomPool = [];
    // 拿底牌后重新整理：噶点未定主用 sortBySuit，其他模式用 sortHand
    if (this.mode === 'ga' && !this.trumpSuit) {
      seat.hand = sortBySuit(seat.hand);
    } else {
      seat.hand = sortHand(seat.hand, this.trumpSuit);
    }
    this._log(`${seat.name} 拿起 6 张底牌，正在扣底`, 'info');
  }

  _initBidding() {
    this.state = 'bidding';
    const candidate = (this.roundNo - 1) % this.maxSeats;
    this.bidding = {
      candidate,
      currentBid: 55,
      highestBidder: null,
      turn: candidate,
      passed: new Set(),
      history: [],
    };
    this.deadline = Date.now() + this._delayFor(candidate, BID_MS);
    this._log(`叫分开始，底分 55，由 ${this.seats[candidate].name} 先叫`, 'round');
    this._touch();
  }

  _bidSeat(seatIdx, value, isAuto = false) {
    if (this.state !== 'bidding') return { ok: false, error: '当前不是叫分阶段' };
    if (!this.bidding || this.bidding.turn !== seatIdx) return { ok: false, error: '还没轮到你叫分' };
    const seat = this.seats[seatIdx];
    const b = this.bidding;

    if (value === 'pass') {
      b.passed.add(seatIdx);
      b.history.push({ seat: seatIdx, value: 'pass' });
      this._log(`${seat.name}${this._autoTag(seat, isAuto)} 选择过`, 'bid');
      if (b.highestBidder === null && b.passed.size >= this.maxSeats) {
        return this._finishBidding();
      }
      if (b.highestBidder !== null && this._othersPassed(b.highestBidder)) {
        return this._finishBidding();
      }
      this._advanceBidTurn(seatIdx);
      return { ok: true };
    }

    const val = Number(value);
    if (!Number.isInteger(val) || val % 5 !== 0) return { ok: false, error: '叫分必须是 5 的倍数' };
    if (val > 95) return { ok: false, error: '叫分不能超过 95 分' };
    if (b.highestBidder === null) {
      if (val < 55) return { ok: false, error: '起叫分不能低于 55' };
    } else if (val <= b.currentBid) {
      return { ok: false, error: `必须高于当前 ${b.currentBid} 分` };
    }
    b.currentBid = val;
    b.highestBidder = seatIdx;
    b.passed.delete(seatIdx);
    b.history.push({ seat: seatIdx, value: val });
    this._log(`${seat.name}${this._autoTag(seat, isAuto)} 叫 ${val} 分`, 'bid');
    if (this._othersPassed(seatIdx)) return this._finishBidding();
    this._advanceBidTurn(seatIdx);
    return { ok: true };
  }

  _othersPassed(seatIdx) {
    const others = this.seats.map((_, i) => i).filter((i) => i !== seatIdx);
    return others.every((i) => this.bidding.passed.has(i));
  }

  _advanceBidTurn(from) {
    for (let i = 1; i <= this.maxSeats; i++) {
      const s = (from + i) % this.maxSeats;
      if (!this.bidding.passed.has(s)) {
        this.bidding.turn = s;
        this.deadline = Date.now() + this._delayFor(s, BID_MS);
        this._touch();
        return;
      }
    }
    // 全部过牌
    this._finishBidding();
  }

  bid(userId, value) {
    if (this.state !== 'bidding') return { ok: false, error: '当前不是叫分阶段' };
    const idx = this.seatOf(userId);
    if (idx < 0) return { ok: false, error: '你不在该房间' };
    return this._bidSeat(idx, value);
  }

  _finishBidding() {
    const b = this.bidding;
    if (!b) return { ok: false, error: '叫分状态异常' };
    // 全部过牌无人叫分：一直重新发牌重新叫
    if (b.highestBidder === null) {
      this.redeals++;
      this._deal();
      this._initBidding();
      this._log('叫分全部过牌，重新发牌', 'warn');
      return { ok: true };
    }
    this.declarerSeat = b.highestBidder;
    this.bidValue = b.currentBid;
    this.bidding = null;
    this._log(`叫分结束：${this.seats[this.declarerSeat].name} 以 ${this.bidValue} 分成为专家`, 'round');
    this._pickupBottom();
    this.state = 'burying';
    this.deadline = Date.now() + this._buryDelay();
    this._touch();
    return { ok: true };
  }

  bury(userId, suit, cardIds) {
    const idx = this.seatOf(userId);
    if (idx < 0) return { ok: false, error: '你不在该房间' };
    if (this.state !== 'burying') return { ok: false, error: '当前不是扣底阶段' };
    if (idx !== this.declarerSeat) return { ok: false, error: '只有庄家可以扣底' };
    const finalSuit = this.mode === 'ga' ? suit : this.trumpSuit;
    if (!SUITS.includes(finalSuit)) return { ok: false, error: '请选择主花色' };
    return this._burySeat(idx, finalSuit, cardIds, false);
  }

  _burySeat(idx, suit, cardIds, isAuto) {
    const seat = this.seats[idx];
    const ids = [...new Set(cardIds || [])];
    if (ids.length !== 6) return { ok: false, error: '必须扣 6 张底牌' };
    const cards = ids.map((id) => seat.hand.find((c) => c.id === id)).filter(Boolean);
    if (cards.length !== 6) return { ok: false, error: '扣底牌不在手中' };
    // 底牌不许扣分牌（5、10、K），所有模式统一限制
    const pointCards = cards.filter((c) => cardPoints(c) > 0);
    if (pointCards.length) {
      return { ok: false, error: `底牌不能扣分牌（5、10、K），请换掉 ${cardsName(pointCards)}` };
    }
    const idSet = new Set(ids);
    seat.hand = seat.hand.filter((c) => !idSet.has(c.id));
    this.trumpSuit = suit;
    this.bottom = sortHand(cards, suit);
    this.bottomPool = [];
    this.state = 'playing';
    this.turn = this.declarerSeat;
    this.deadline = Date.now() + this._delayFor(this.turn, TURN_MS);
    this.trick = { lead: null, plays: [] };
    this.lastTrick = null;
    this.pendingResolveAt = null;
    this._log(`${seat.name}${this._autoTag(seat, isAuto)} 已扣底，主花色 ${SUIT_NAMES[suit]}，开始出牌`, 'round');
    this._touch();
    return { ok: true };
  }

  _autoBury() {
    const idx = this.declarerSeat;
    if (idx === null || idx === undefined) return;
    const seat = this.seats[idx];
    let suit = this.trumpSuit;
    if (this.mode === 'ga') {
      const counts = {};
      for (const s of SUITS) counts[s] = 0;
      for (const c of seat.hand) if (c.s !== 'J') counts[c.s] = (counts[c.s] || 0) + 1;
      suit = SUITS.slice().sort((a, b) => counts[b] - counts[a])[0];
    }
    if (!suit) suit = 'S';
    const sorted = seat.hand.slice().sort((a, b) => {
      const pa = cardPoints(a) > 0 ? 1 : 0;
      const pb = cardPoints(b) > 0 ? 1 : 0;
      if (pa !== pb) return pa - pb;
      return power(a, suit) - power(b, suit);
    });
    const ids = sorted.slice(0, 6).map((c) => c.id);
    this._burySeat(idx, suit, ids, true);
  }

  play(userId, cardIds) {
    const idx = this.seatOf(userId);
    if (idx < 0) return { ok: false, error: '你不在该房间' };
    return this._playSeat(idx, cardIds, false);
  }

  _playSeat(seatIdx, cardIds, isAuto) {
    if (this.state !== 'playing') return { ok: false, error: '当前不是出牌阶段' };
    if (this.turn !== seatIdx) return { ok: false, error: '还没轮到你出牌' };
    if (this.pendingResolveAt) return { ok: false, error: '正在结算本墩' };
    const seat = this.seats[seatIdx];
    const ids = [...new Set(cardIds || [])];
    if (ids.length !== (cardIds || []).length || ids.length === 0) return { ok: false, error: '选牌无效' };
    let cards = ids.map((id) => seat.hand.find((c) => c.id === id)).filter(Boolean);
    if (cards.length !== ids.length) return { ok: false, error: '你没有这些牌' };

    const hasLead = !!this.trick.lead;
    let note = '';

    if (!hasLead) {
      let type = detectLead(cards, this.trumpSuit);
      if (!type) {
        return { ok: false, error: '非法牌型：只能出单张、同花色 25 组合、金鸡或副牌甩牌' };
      }
      if (type === 'throw') {
        const allHands = this.seats.map((s) => s.hand);
        const check = checkThrow(cards, allHands, this.bottom, this.trumpSuit);
        if (!check.ok) {
          cards = [check.forced];
          type = 'single';
          note = `甩牌不成立，${check.forced.id} 不是该花色最大牌，自动只打出最小一张`;
          this._log(`${seat.name} 甩牌违规，系统强制只打出 ${cardsName(cards)}`, 'warn');
        }
      }
      const idSet = new Set(cards.map((c) => c.id));
      seat.hand = seat.hand.filter((c) => !idSet.has(c.id));
      this.lastTrick = null;
      this.trick = { lead: { seat: seatIdx, cards, type }, plays: [{ seat: seatIdx, cards }] };
      this._log(`${seat.name}${this._autoTag(seat, isAuto)} 首出 ${cardsName(cards)}${type === 'throw' ? '（甩牌）' : ''}`, 'play');
    } else {
      const check = validateFollow(seat.hand, cards, this.trick.lead, this.trumpSuit);
      if (!check.ok) return { ok: false, error: check.reason };
      const idSet = new Set(cards.map((c) => c.id));
      seat.hand = seat.hand.filter((c) => !idSet.has(c.id));
      this.trick.plays.push({ seat: seatIdx, cards });
      this._log(`${seat.name}${this._autoTag(seat, isAuto)} 跟出 ${cardsName(cards)}`, 'play');
    }

    if (this.trick.plays.length >= this.maxSeats) {
      this.turn = null;
      this.deadline = Date.now() + RESOLVE_MS;
      this.pendingResolveAt = Date.now() + RESOLVE_MS;
    } else {
      this.turn = (seatIdx + 1) % this.maxSeats;
      this.deadline = Date.now() + this._delayFor(this.turn, TURN_MS);
    }

    // 金鸡（大小王）首出：其余玩家由系统自动跟牌，玩家无需操作
    if (!hasLead && this.trick.lead.type === 'joker') {
      this._log('金鸡首出，系统自动为其余玩家跟牌', 'info');
      for (let i = 1; i < this.maxSeats; i++) {
        if (this.trick.plays.length >= this.maxSeats) break;
        const next = (seatIdx + i) % this.maxSeats;
        if (!this._autoPlay(next).ok) break;
      }
    }
    this._touch();
    return { ok: true, note };
  }

  _autoPlay(seatIdx) {
    const seat = this.seats[seatIdx];
    const picked = autoSelect(seat.hand, this.trick.lead, this.trumpSuit);
    const res = this._playSeat(
      seatIdx,
      picked.map((c) => c.id),
      true,
    );
    if (res.ok) return res;
    // 极端兜底：尽量找一手合法牌
    if (!this.trick.lead && seat.hand.length) {
      const fallback = [seat.hand[0].id];
      return this._playSeat(seatIdx, fallback, true);
    }
    this._log(`${seat.name} 托管自动出牌失败：${res.error}，等待玩家操作`, 'warn');
    this.deadline = Date.now() + 8000;
    this._touch();
    return res;
  }

  _resolveTrick(now) {
    if (!this.trick.lead) return;
    const winner = resolveTrick(this.trick.lead, this.trick.plays, this.trumpSuit);
    const allCards = this.trick.plays.flatMap((p) => p.cards);
    const points = handPoints(allCards);
    this.seats[winner].captured += points;
    this.lastTrick = {
      lead: this.trick.lead,
      plays: this.trick.plays,
      winner,
      winnerName: this.seats[winner].name,
      points,
      at: now,
    };
    this._log(`${this.seats[winner].name} 赢得本墩${points ? `，获得 ${points} 分` : ''}`, 'trick');
    for (const p of this.trick.plays) {
      for (const c of p.cards) this.playedCards.push(c.id);
    }
    this.trick = { lead: null, plays: [] };
    this.pendingResolveAt = null;
    this.turn = winner;
    this.deadline = now + this._delayFor(winner, TURN_MS);

    const done = this.seats.every((s) => s.hand.length === 0);
    this._touch();
    if (done) {
      this._finishRound(winner);
    } else {
      const nextWinner = winner;
      this.turn = nextWinner;
    }
  }

  _finishRound(lastWinner) {
    if (this.state === 'finished') return;
    this.bottomRevealed = true;
    const bottomPoints = handPoints(this.bottom);
    const decl = this.declarerSeat;
    const captured = this.seats.map((s) => s.captured);
    const isDefenderLast = lastWinner !== decl;
    const bottomToDeclarer = !isDefenderLast ? bottomPoints : 0;
    const bottomToDefenders = isDefenderLast ? bottomPoints * 2 : 0;

    let declarerPoints;
    let defenderPoints;
    let sides;
    let winnerSide;
    let title;
    let detail;
    let threshold = null;

    if (this.mode === 'team') {
      const declTeam = decl % 2;
      const declSeats = [declTeam, declTeam + 2];
      const defSeats = [1 - declTeam, 3 - declTeam];
      declarerPoints = declSeats.reduce((n, i) => n + captured[i], 0) + bottomToDeclarer;
      defenderPoints = defSeats.reduce((n, i) => n + captured[i], 0) + bottomToDefenders;
      threshold = 45;
      winnerSide = defenderPoints >= 45 ? 'defenders' : 'declarer';
      sides = [
        {
          key: 'declarer',
          name: '庄家队',
          seats: declSeats,
          points: declarerPoints,
          won: winnerSide === 'declarer',
        },
        {
          key: 'defenders',
          name: '常家队',
          seats: defSeats,
          points: defenderPoints,
          won: winnerSide === 'defenders',
        },
      ];
      title = winnerSide === 'defenders' ? '常家队上庄！' : '庄家队守庄成功！';
      detail = `常家队 ${defenderPoints} 分，${defenderPoints >= 45 ? '达到' : '未达到'} 45 分门槛`;
    } else if (this.mode === 'ga') {
      declarerPoints = captured[decl] + bottomToDeclarer;
      defenderPoints = captured.reduce((n, v, i) => (i === decl ? n : n + v), 0) + bottomToDefenders;
      winnerSide = declarerPoints >= this.bidValue ? 'declarer' : 'defenders';
      sides = [
        {
          key: 'declarer',
          name: `${this.seats[decl].name}（专家）`,
          seats: [decl],
          points: declarerPoints,
          won: winnerSide === 'declarer',
        },
        { key: 'defenders', name: '抓分方', seats: [0, 1, 2, 3].filter((i) => i !== decl), points: defenderPoints, won: winnerSide === 'defenders' },
      ];
      title = winnerSide === 'declarer' ? '专家达标，守庄成功！' : '抓分方胜利！';
      detail = `专家叫 ${this.bidValue} 分，实得 ${declarerPoints} 分`;
    } else {
      declarerPoints = captured[decl] + bottomToDeclarer;
      defenderPoints = captured.reduce((n, v, i) => (i === decl ? n : n + v), 0) + bottomToDefenders;
      threshold = 45;
      winnerSide = defenderPoints >= 45 ? 'defenders' : 'declarer';
      sides = [
        {
          key: 'declarer',
          name: `${this.seats[decl].name}（专家）`,
          seats: [decl],
          points: declarerPoints,
          won: winnerSide === 'declarer',
        },
        { key: 'defenders', name: '常家', seats: [0, 1, 2, 3].filter((i) => i < this.maxSeats && i !== decl), points: defenderPoints, won: winnerSide === 'defenders' },
      ];
      title = winnerSide === 'defenders' ? '常家胜利，重新抢庄！' : '专家守庄成功！';
      detail = `常家 ${defenderPoints} 分，${defenderPoints >= 45 ? '达到' : '未达到'} 45 分门槛`;
    }

    this.result = {
      mode: this.mode,
      roundNo: this.roundNo,
      declarerSeat: decl,
      declarerName: this.seats[decl].name,
      trumpSuit: this.trumpSuit,
      bidValue: this.bidValue,
      threshold,
      bottomPoints,
      bottomDoubled: isDefenderLast,
      lastWinner,
      lastWinnerName: this.seats[lastWinner].name,
      captured,
      declarerPoints,
      defenderPoints,
      winnerSide,
      title,
      detail,
      sides,
      bottom: sortHand(this.bottom, this.trumpSuit),
      finishedAt: Date.now(),
    };
    this.state = 'finished';
    this.deadline = null;
    this.turn = null;
    this.pendingResolveAt = null;
    this._log(`本局结束：${title}（${detail}）`, 'result');
    if (typeof this.onRoundEnd === 'function') {
      try {
        this.onRoundEnd(this, this.result);
      } catch (e) {
        console.error('onRoundEnd error', e);
      }
    }
    this._touch();
  }

  _botKey() {
    if (this.state === 'declaring') {
      const bots = this.seats.map((s, i) => ({ s, i })).filter((x) => x.s && x.s.isBot);
      if (!bots.length) return null;
      const pending = bots.filter((x) => !this.botPassed.has(x.i));
      if (!pending.length) return null;
      return `declare:${this.roundNo}:${this.redeals}:${this.declaration && this.declaration.last ? 'pass' : 'open'}:${this.botPassed.size}`;
    }
    if (this.state === 'bidding') {
      const t = this.bidding && this.bidding.turn;
      const s = t === null || t === undefined ? null : this.seats[t];
      return s && s.isBot ? `bid:${this.roundNo}:${t}:${this.bidding.history.length}` : null;
    }
    if (this.state === 'burying') {
      const s = this.seats[this.declarerSeat];
      return s && s.isBot ? `bury:${this.roundNo}` : null;
    }
    if (this.state === 'playing' && !this.pendingResolveAt) {
      const s = this.turn === null || this.turn === undefined ? null : this.seats[this.turn];
      return s && s.isBot
        ? `play:${this.roundNo}:${this.turn}:${this.trick.plays.length}:${s.hand.length}`
        : null;
    }
    return null;
  }

  // 人机叫分意愿：按手牌强度评估，重发次数越多越愿意叫
  _botBidTarget(seatIdx) {
    const seat = this.seats[seatIdx];
    if (!seat) return null;
    let perm = 0;
    const suitScore = { S: 0, H: 0, C: 0, D: 0 };
    for (const card of seat.hand) {
      if (card.s === 'J' || card.r === '5' || card.r === '2') {
        perm += 1;
        continue;
      }
      const w = card.r === 'A' ? 3 : card.r === 'K' ? 2.5 : card.r === 'Q' ? 1.5 : card.r === '10' ? 1 : 0.5;
      suitScore[card.s] += w;
    }
    const best = Math.max(...SUITS.map((s) => suitScore[s]));
    const score = perm * 2 + best;
    const need = this.redeals >= 2 ? 0 : this.redeals === 1 ? 6 : 8;
    if (score < need) return null;
    // 叫分必须是 5 的倍数
    const raw = 55 + (score - need) * 3;
    return Math.min(95, Math.max(55, Math.round(raw / 5) * 5));
  }

  _actBot() {
    if (this.state === 'declaring') {
      const bots = this.seats.map((s, i) => ({ s, i })).filter((x) => x.s && x.s.isBot);
      if (this.declaration && this.declaration.last) {
        const next = bots.find((x) => !this.botPassed.has(x.i));
        if (next) {
          this.botPassed.add(next.i);
          this.passDeclaration(next.s.userId);
        }
        return;
      }
      const holder = bots.find((x) => !this.botPassed.has(x.i) && x.s.hand.some((c) => c.r === '2'));
      if (holder) {
        const two = holder.s.hand.find((c) => c.r === '2');
        this.botPassed.add(holder.i);
        this.declare(holder.s.userId, [two.id]);
        return;
      }
      const next = bots.find((x) => !this.botPassed.has(x.i));
      if (next) {
        this.botPassed.add(next.i);
        this.passDeclaration(next.s.userId);
      }
      return;
    }
    if (this.state === 'bidding') {
      const t = this.bidding.turn;
      const target = this._botBidTarget(t);
      const minNext = this.bidding.highestBidder === null ? 55 : this.bidding.currentBid + 5;
      if (target !== null && target >= minNext && minNext <= 95) {
        this._bidSeat(t, Math.min(target, 95), true);
      } else {
        this._bidSeat(t, 'pass', true);
      }
      return;
    }
    if (this.state === 'burying') {
      this._autoBury();
      return;
    }
    if (this.state === 'playing') {
      this._autoPlay(this.turn);
    }
  }

  tick(now = Date.now()) {
    if (!this.deadline) return false;
    let changed = false;

    const botKey = this._botKey();
    if (botKey) {
      if (botKey !== this.botKey) {
        this.botKey = botKey;
        const openDeclare = this.state === 'declaring' && !(this.declaration && this.declaration.last);
        this.botAt = now + (openDeclare ? 5000 : 900);
      } else if (now >= this.botAt) {
        this.botKey = null;
        this._actBot();
        return true;
      }
    } else {
      this.botKey = null;
    }

    if (this.state === 'declaring' && now >= this.deadline) {
      this._finalizeDeclaration();
      changed = true;
    } else if (this.state === 'bidding' && now >= this.deadline) {
      const t = this.bidding && this.bidding.turn;
      const isBotTurn = t !== null && t !== undefined && this.seats[t] && this.seats[t].isBot;
      // 人机的回合交给 _actBot 处理（它可能加分），超时托管只对真人生效
      if (!isBotTurn) {
        if (t !== null && t !== undefined) this._bidSeat(t, 'pass', true);
        changed = true;
      }
    } else if (this.state === 'burying' && now >= this.deadline) {
      this._autoBury();
      changed = true;
    } else if (this.state === 'playing') {
      if (this.pendingResolveAt && now >= this.pendingResolveAt) {
        this._resolveTrick(now);
        changed = true;
      } else if (this.turn !== null && this.turn !== undefined && now >= this.deadline) {
        this._autoPlay(this.turn);
        changed = true;
      }
    }
    return changed;
  }

  viewFor(userId) {
    const mySeat = this.seatOf(userId);
    const hostSeat = this.seatOf(this.hostId);
    const hostGone = hostSeat < 0 || !this.seats[hostSeat] || !this.seats[hostSeat].connected;
    const showHand = mySeat >= 0 && this.state !== 'waiting';
    const hand = showHand ? sortHand(this.seats[mySeat].hand, this.trumpSuit) : [];

    const teamOf = (i) => (this.mode === 'team' ? i % 2 : null);

    const seats = this.seats.map((s, i) => {
      if (!s) return { seat: i, empty: true };
      return {
        seat: i,
        userId: s.userId,
        name: s.name,
        connected: s.connected,
        ready: s.ready,
        cardCount: s.hand.length,
        captured: s.captured,
        isDeclarer: i === this.declarerSeat,
        isTurn:
          (this.state === 'playing' && this.turn === i) ||
          (this.state === 'bidding' && this.bidding && this.bidding.turn === i) ||
          (this.state === 'burying' && this.declarerSeat === i),
        team: teamOf(i),
        me: i === mySeat,
        isBot: !!s.isBot,
      };
    });

    return {
      v: this.version,
      id: this.id,
      name: this.name,
      mode: this.mode,
      modeName: MODE_INFO[this.mode].name,
      maxSeats: this.maxSeats,
      state: this.state,
      hostId: this.hostId,
      isHost: this.hostId === userId,
      roundNo: this.roundNo,
      seats,
      mySeat,
      hand,
      handCount: hand.length,
      trumpSuit: this.trumpSuit,
      declarerSeat: this.declarerSeat,
      bankerTeam: this.mode === 'team' ? this.bankerTeam : null,
      dealerSeat: this.mode === 'team' ? this.dealerSeat : null,
      bidValue: this.bidValue,
      turn: this.turn,
      deadline: this.deadline,
      pendingResolve: !!this.pendingResolveAt,
      trick: {
        lead: this.trick.lead,
        plays: this.trick.plays,
      },
      lastTrick: this.lastTrick,
      declaration: this.state === 'declaring' && this.declaration
        ? {
            last: this.declaration.last,
            passed: [...this.declaration.passed],
            redeals: this.redeals,
            deadline: this.deadline,
          }
        : null,
      bidding: this.state === 'bidding' && this.bidding
        ? {
            candidate: this.bidding.candidate,
            currentBid: this.bidding.currentBid,
            highestBidder: this.bidding.highestBidder,
            turn: this.bidding.turn,
            passed: [...this.bidding.passed],
            history: this.bidding.history,
            deadline: this.deadline,
          }
        : null,
      bottomCount: 6,
      bottomRevealed: this.bottomRevealed,
      // 牌局结束显示扣回的底牌，其余阶段显示庄家抓起的 6 张（全员可见）
      bottom: this.bottomRevealed
        ? sortHand(this.state === 'finished' ? this.bottom : this.bottomPickup, this.trumpSuit)
        : null,
      result: this.state === 'finished' ? this.result : null,
      canStart:
        (this.hostId === userId || hostGone) &&
        (this.state === 'waiting' || this.state === 'finished') &&
        this.full,
      playedCards: this.playedCards,
      cardCounter: cardCounterEnabled(),
      log: this.log.slice(-40),
    };
  }
}
