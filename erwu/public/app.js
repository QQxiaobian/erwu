/* 《二五》前端逻辑：登录、大厅、实时牌桌、管理员面板 */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const SUITS = ['S', 'H', 'C', 'D'];
const SUIT_SYM = { S: '♠', H: '♥', C: '♣', D: '♦', J: '' };
const SUIT_NAME = { S: '黑桃', H: '红桃', C: '梅花', D: '方块' };
const MODE_NAME = { grab: '抢庄模式', team: '队家模式', ga: '噶点模式' };
const MODE_DESC = {
  grab: '发牌阶段亮 2 定主，25 可反主；常家 ≥ 45 分获胜。',
  team: '固定 4 人 2V2，对家为队友；常家 ≥ 45 分上庄。',
  ga: '先发牌、再叫分；叫分最高者坐庄并自选主花色，无亮主反主。',
};
const STATE_NAME = {
  waiting: '等待入座',
  declaring: '亮主阶段',
  bidding: '叫分阶段',
  burying: '扣底阶段',
  playing: '出牌中',
  finished: '本局结束',
};
const LEAD_NAME = { single: '单张', combo25: '25 组合', joker: '金鸡', throw: '副牌甩牌' };

// 前端牌堆：与后端 cards.js 保持一致（54 张）
const CC_RANKS = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '4', '3'];
function makeDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of CC_RANKS) deck.push({ id: s + r, s, r });
    deck.push({ id: s + '5', s, r: '5' });
    deck.push({ id: s + '2', s, r: '2' });
  }
  deck.push({ id: 'BJ', s: 'J', r: 'BJ' });
  deck.push({ id: 'LJ', s: 'J', r: 'SJ' });
  return deck;
}
const FULL_DECK = makeDeck();

const state = {
  user: null,
  ws: null,
  connected: false,
  rooms: [],
  onlineCount: 0,
  onlineUsers: [],
  room: null,
  selected: new Set(),
  burySuit: null,
  allowRegister: true,
  authTab: 'login',
  resultOpen: false,
  resultKey: null,
  busy: false,
  adminUsers: null,
  adminStats: null,
  adminHistory: null,
  adminSettings: null,
  adminTab: 'users',
  allowRegister: true,
  cardCounter: false,
  biddingChoice: null,
  wsRetry: null,
};

/* ---------------- 基础工具 ---------------- */
function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toast(text, type = '') {
  const wrap = $('#toast-wrap');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = text;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 300);
  }, 2600);
}

function showScreen(name) {
  for (const id of ['auth', 'lobby', 'table']) {
    const el = $(`#screen-${id}`);
    if (el) el.classList.toggle('active', id === name);
  }
}

function fmtRemain(deadline) {
  if (!deadline) return '';
  const s = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  return `${s}s`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function isTrumpC(card, trumpSuit) {
  if (!card || !trumpSuit) return false;
  if (card.s === 'J') return true;
  if (card.r === '5' || card.r === '2') return true;
  return card.s === trumpSuit;
}

function cardPoints(card) {
  if (!card) return 0;
  if (card.r === '5') return 5;
  if (card.r === '10' || card.r === 'K') return 10;
  return 0;
}

function rankOrder(r) {
  return ['3', '4', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].indexOf(r);
}

function cardHTML(card, opts = {}) {
  const isJoker = card.s === 'J';
  const isRed = card.s === 'H' || card.s === 'D' || card.r === 'BJ';
  const trump = opts.trumpSuit ? isTrumpC(card, opts.trumpSuit) : false;
  const deal = opts.dealDelay != null;
  const classes = [
    'card',
    opts.mini ? 'mini' : '',
    isJoker ? 'joker' : '',
    isRed ? 'red' : '',
    isJoker && !isRed ? 'black' : '',
    trump && !opts.mini ? 'trump' : '',
    opts.selected ? 'selected' : '',
    opts.back ? 'back' : '',
    deal ? 'deal-in' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const style = deal ? `style="animation-delay:${opts.dealDelay}ms"` : '';
  if (opts.back) return `<div class="card mini back"></div>`;
  if (isJoker) {
    // 左上角同样显示「大 / 王」标识，避免牌叠放时看不清
    return `<div class="${classes}" data-id="${card.id}" ${style}>
      <span class="rank">${card.r === 'BJ' ? '大' : '小'}</span>
      <span class="suit">王</span>
      <span class="joker-text">${card.r === 'BJ' ? '大王' : '小王'}</span>
    </div>`;
  }
  const sym = SUIT_SYM[card.s];
  const pts = cardPoints(card);
  return `<div class="${classes}" data-id="${card.id}" ${style}>
    <span class="rank">${esc(card.r)}</span>
    <span class="suit">${sym}</span>
    <span class="big-suit">${sym}</span>
    ${pts ? `<span class="points">${pts}</span>` : ''}
  </div>`;
}

function seatName(seatIdx) {
  const s = state.room && state.room.seats[seatIdx];
  return s && !s.empty ? s.name : '—';
}

function describeSelection(cards, trumpSuit, lead) {
  if (!cards.length) return '未选择';
  if (cards.length === 1) return '单张';
  const jokers = cards.filter((c) => c.s === 'J').length;
  if (jokers === 2 && cards.length === 2) return '金鸡';
  if (cards.length === 2 && cards[0].s === cards[1].s) {
    const ranks = cards.map((c) => c.r).sort();
    if (ranks[0] === '2' && ranks[1] === '5') return '25 组合';
  }
  const allTrump = cards.every((c) => isTrumpC(c, trumpSuit));
  if (lead) {
    // 跟牌阶段：主牌可以毙甩牌，副牌按张数跟
    if (lead.type === 'throw' && allTrump) return `主牌毙牌 ${cards.length} 张`;
    if (allTrump) return `主牌 ${cards.length} 张`;
    return `跟牌 ${cards.length} 张`;
  }
  const sameSuit = cards.every((c) => c.s === cards[0].s && c.s !== 'J');
  if (sameSuit && !allTrump) return `副牌甩牌 ${cards.length} 张`;
  if (allTrump) return `主牌 ${cards.length} 张（主牌不能甩牌）`;
  return '组合不合法';
}

function selectedCards() {
  if (!state.room) return [];
  const map = new Map(state.room.hand.map((c) => [c.id, c]));
  return [...state.selected].map((id) => map.get(id)).filter(Boolean);
}

/* ---------------- 网络 ---------------- */
function send(obj) {
  if (state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify(obj));
    return true;
  }
  toast('连接已断开，正在重连…', 'error');
  return false;
}

function connect() {
  if (!state.user) return;
  if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    state.connected = true;
    updateWsDot();
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleMessage(msg);
  };
  ws.onclose = () => {
    state.connected = false;
    updateWsDot();
    if (state.user) {
      clearTimeout(state.wsRetry);
      state.wsRetry = setTimeout(() => connect(), 2200);
    }
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
  };
}

function updateWsDot() {
  const dot = $('#ws-dot');
  if (dot) dot.classList.toggle('off', !state.connected);
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

/* ---------------- 消息处理 ---------------- */
function handleMessage(msg) {
  switch (msg.t) {
    case 'hello':
      state.user = msg.user;
      state.rooms = msg.rooms || [];
      state.onlineCount = msg.onlineCount || 0;
      state.onlineUsers = msg.onlineUsers || [];
      if (typeof msg.allowRegister === 'boolean') state.allowRegister = msg.allowRegister;
      if (typeof msg.cardCounter === 'boolean') state.cardCounter = msg.cardCounter;
      applyUser();
      if (msg.room) {
        onRoom(msg.room);
      } else {
        state.room = null;
        state.selected.clear();
        render();
      }
      break;
    case 'rooms':
      state.rooms = msg.rooms || [];
      state.onlineCount = msg.onlineCount ?? state.onlineCount;
      state.onlineUsers = msg.onlineUsers ?? state.onlineUsers;
      if (!state.room) renderLobby();
      break;
    case 'room':
      onRoom(msg.room);
      break;
    case 'joined':
      toast('已进入房间', 'good');
      break;
    case 'left':
      state.room = null;
      state.selected.clear();
      state.resultOpen = false;
      state.burySuit = null;
      render();
      break;
    case 'error':
      state.busy = false;
      toast(msg.error, 'error');
      break;
    case 'toast':
      toast(msg.text, 'good');
      break;
    case 'unauthorized':
      location.reload();
      break;
    default:
      break;
  }
}

function onRoom(room) {
  if (!room) {
    state.room = null;
    state.selected.clear();
    state.dealing = false;
    state.trickAnimKey = null;
    render();
    return;
  }
  const prev = state.room;
  const prevHandCount = prev ? (prev.hand || []).length : 0;
  state.room = room;
  const handIds = new Set((room.hand || []).map((c) => c.id));
  for (const id of [...state.selected]) {
    if (!handIds.has(id)) state.selected.delete(id);
  }
  const roundChanged = !prev || prev.id !== room.id || prev.roundNo !== room.roundNo;
  if (roundChanged) {
    state.selected.clear();
    state.resultKey = null;
    state.resultOpen = false;
    state.burySuit = null;
    state.trickAnimKey = null;
    state.biddingChoice = null;
  }
  // 离开叫分阶段（或轮到的玩家变了）时重置选择
  if (!room.bidding || !prev || !prev.bidding || prev.bidding.turn !== room.bidding.turn) {
    state.biddingChoice = null;
  }
  // 新一局发牌：手牌从 0 变为非空时触发发牌动画（约 1 秒完成）
  if (prevHandCount === 0 && (room.hand || []).length > 0) {
    state.dealing = true;
    clearTimeout(state._dealTimer);
    state._dealTimer = setTimeout(() => {
      state.dealing = false;
      if (state.room) renderHand();
    }, 1100);
  }
  if (room.state !== 'burying') state.burySuit = null;
  if (room.state === 'burying' && room.mySeat >= 0 && room.mySeat === room.declarerSeat && !state.burySuit) {
    state.burySuit = room.mode === 'ga' ? bestSuit(room.hand || []) : room.trumpSuit;
  }
  if (room.state === 'finished' && room.result) {
    const key = `${room.id}:${room.roundNo}:${room.result.finishedAt}`;
    if (state.resultKey !== key) {
      state.resultKey = key;
      state.resultOpen = true;
    }
  }
  if (room.state !== 'finished') state.resultOpen = false;
  render();
}

function bestSuit(hand) {
  const counts = { S: 0, H: 0, C: 0, D: 0 };
  for (const c of hand) if (c.s !== 'J') counts[c.s]++;
  return SUITS.slice().sort((a, b) => counts[b] - counts[a])[0] || 'S';
}

/* ---------------- 渲染入口 ---------------- */
function render() {
  if (!state.user) {
    showScreen('auth');
    return;
  }
  if (state.room) {
    showScreen('table');
    renderTable();
  } else {
    showScreen('lobby');
    renderLobby();
  }
}

function applyUser() {
  if (!state.user) return;
  $('#lobby-username').textContent = state.user.nickname || state.user.username;
  $('#lobby-admin-tag').classList.toggle('hidden', !state.user.isAdmin);
  $('#open-admin-btn').classList.toggle('hidden', !state.user.isAdmin);
}

function renderLobby() {
  const online = $('#online-list');
  if (online) {
    const me = state.user && state.user.id;
    const names = (state.onlineUsers || [])
      .map((u) => {
        const nm = u.nickname || u.username || u.name || '?';
        return u.id === me ? `${nm}（我）` : nm;
      })
      .join('、');
    online.innerHTML = `<span class="online-count">在线 ${state.onlineCount || 0} 人</span>` +
      (names ? `<span class="online-names">${esc(names)}</span>` : '');
  }
  const list = $('#room-list');
  const rooms = state.rooms || [];
  if (!rooms.length) {
    list.innerHTML = `<div class="room-empty">还没有牌桌<br><span class="muted">在右侧创建房间，把房间号发给好友即可开局</span></div>`;
    return;
  }
  list.innerHTML = rooms
    .map((r) => {
      const waiting = r.state === 'waiting';
      const full = r.count >= r.maxSeats;
      const stateText =
        r.state === 'waiting'
          ? `等待中 ${r.count}/${r.maxSeats}`
          : r.state === 'finished'
            ? '本局结束'
            : STATE_NAME[r.state] || r.state;
      const pills = [];
      for (let i = 0; i < r.maxSeats; i++) {
        const name = r.players[i];
        pills.push(
          name
            ? `<span class="player-pill">${esc(name)}</span>`
            : `<span class="player-pill empty">虚位以待</span>`,
        );
      }
      let action = '';
      if (r.state === 'finished') {
        action = full
          ? `<span class="room-state">已满</span>`
          : `<button class="btn primary small" data-action="join" data-room="${r.id}">加入</button>`;
      } else if (waiting && !full) {
        action = `<button class="btn primary small" data-action="join" data-room="${r.id}">加入</button>`;
      } else if (waiting && full) {
        action = `<span class="room-state">已满</span>`;
      } else {
        action = `<span class="room-state live">进行中</span>`;
      }
      return `<article class="room-card">
        <div class="room-card-head">
          <span class="room-card-name">${esc(r.name)}</span>
          <span class="mode-chip">${esc(r.modeName)}</span>
        </div>
        <div class="room-card-meta">
          <span>房主：${esc(r.hostName)}</span>
          <span>${r.roundNo ? `第 ${r.roundNo} 局` : '新房间'}</span>
          <span class="room-code">${r.id}</span>
        </div>
        <div class="room-card-players">${pills.join('')}</div>
        <div class="room-card-foot">
          <span class="room-state ${waiting ? '' : 'live'}">${stateText}</span>
          ${action}
        </div>
      </article>`;
    })
    .join('');
}

/* ---------------- 牌桌渲染 ---------------- */
function posFor(seatIdx) {
  const n = state.room.maxSeats;
  const my = state.room.mySeat;
  const rel = my >= 0 ? (seatIdx - my + n) % n : seatIdx;
  if (n === 3) return ['bottom', 'left', 'right'][rel] || 'top';
  return ['bottom', 'left', 'top', 'right'][rel] || 'top';
}

function roleLabel(seat) {
  const r = state.room;
  if (seat.isDeclarer) return r.mode === 'team' ? '庄家队' : '专家';
  if (r.mode === 'team') return seat.team === 0 ? 'A队' : 'B队';
  if (r.mode === 'ga') return '抓分方';
  return '常家';
}

function renderTable() {
  const r = state.room;
  if (!r) return;
  $('#room-name').textContent = r.name;
  $('#room-code').textContent = r.id;

  const meta = [];
  meta.push(`<span class="chip">${esc(r.modeName)}</span>`);
  if (r.roundNo) meta.push(`<span class="chip">第 ${r.roundNo} 局</span>`);
  if (r.trumpSuit) meta.push(`<span class="chip gold">主 ${SUIT_SYM[r.trumpSuit]} ${SUIT_NAME[r.trumpSuit]}</span>`);
  else meta.push(`<span class="chip">主未定</span>`);
  if (r.declarerSeat !== null && r.declarerSeat !== undefined) meta.push(`<span class="chip">庄 ${esc(seatName(r.declarerSeat))}</span>`);
  if (r.mode === 'ga' && r.bidValue) meta.push(`<span class="chip red">叫 ${r.bidValue} 分</span>`);
  $('#room-meta').innerHTML = meta.join('');

  const timer = $('#turn-timer');
  if (r.deadline && r.state !== 'finished' && r.state !== 'waiting') {
    timer.dataset.deadline = r.deadline;
  } else {
    timer.textContent = '';
    delete timer.dataset.deadline;
  }

  renderFelt();
  renderBottomBar();
  renderScoreboard();
  renderLog();
  renderPhase();
  renderHand();
  renderResultOverlay();
  renderCardCounter();

  // 记牌器按钮：仅当管理员开放且牌局进行中显示
  const ccBtn = $('#card-counter-btn');
  if (ccBtn) ccBtn.classList.toggle('hidden', !r.cardCounter || r.state === 'waiting');

  const waiting = r.state === 'waiting';
  $('#hand-area').classList.toggle('hidden', waiting);
}

/* ---------------- 记牌器 ---------------- */
function renderCardCounter() {
  const r = state.room;
  const overlay = $('#card-counter-overlay');
  if (!r || !r.cardCounter || r.state === 'waiting') {
    if (!overlay.classList.contains('hidden')) overlay.classList.add('hidden');
    return;
  }
  const played = new Set(r.playedCards || []);
  const trump = r.trumpSuit;
  const groups = [];
  // 常主区：所有 5、所有 2、大小王
  const permRows = [
    { label: '5', cards: FULL_DECK.filter((c) => c.r === '5') },
    { label: '2', cards: FULL_DECK.filter((c) => c.r === '2') },
  ];
  const jokers = FULL_DECK.filter((c) => c.s === 'J');
  let permTiles = '';
  for (const row of permRows) {
    permTiles += row.cards.map((c) => ccTile(c, played, trump)).join('');
  }
  permTiles += jokers.map((c) => ccTile(c, played, trump)).join('');
  const permRemain = [...FULL_DECK.filter((c) => c.r === '5' || c.r === '2' || c.s === 'J')].filter((c) => !played.has(c.id)).length;
  groups.push(`<div class="cc-row"><div class="cc-row-label">常主</div><div class="cc-tiles">${permTiles}</div><div class="cc-remain">剩 ${permRemain}</div></div>`);

  // 各花色副牌区（按花色分组）
  for (const s of SUITS) {
    const cards = FULL_DECK.filter((c) => c.s === s && c.r !== '5' && c.r !== '2');
    const tiles = cards.map((c) => ccTile(c, played, trump)).join('');
    const remain = cards.filter((c) => !played.has(c.id)).length;
    const isTrump = s === trump;
    groups.push(`<div class="cc-row ${isTrump ? 'trump-suit' : ''}"><div class="cc-row-label ${s === 'H' || s === 'D' ? 'red' : ''}">${SUIT_SYM[s]}</div><div class="cc-tiles">${tiles}</div><div class="cc-remain">剩 ${remain}</div></div>`);
  }

  const totalRemain = FULL_DECK.filter((c) => !played.has(c.id)).length;
  $('#cc-sub').textContent = `已出 ${played.size} / 54 · 剩余 ${totalRemain} 张`;
  $('#cc-body').innerHTML = groups.join('');
}

function ccTile(card, played, trump) {
  const isJoker = card.s === 'J';
  const isRed = card.s === 'H' || card.s === 'D' || card.r === 'BJ';
  const isTrump = trump ? isTrumpC(card, trump) : false;
  const isOut = played.has(card.id);
  const cls = ['cc-tile', isRed ? 'red' : 'black', isJoker ? 'joker' : '', isTrump ? 'trump' : '', isOut ? 'out' : ''].filter(Boolean).join(' ');
  const label = isJoker ? (card.r === 'BJ' ? '大王' : '小王') : card.r;
  const sym = isJoker ? '' : SUIT_SYM[card.s];
  return `<div class="${cls}" title="${isJoker ? label : SUIT_SYM[card.s] + card.r}${isOut ? '（已出）' : ''}"><span class="cc-rank">${label}</span><span class="cc-sym">${sym}</span></div>`;
}

function renderFelt() {
  const r = state.room;
  const seats = r.seats
    .map((s) => {
      const pos = posFor(s.seat);
      if (s.empty) {
        return `<div class="seat pos-${pos} empty"><div class="avatar">?</div><div class="seat-name">虚位以待</div></div>`;
      }
      const badges = [];
      if (s.isDeclarer) badges.push(`<span class="badge declarer">庄</span>`);
      if (s.isBot) badges.push(`<span class="badge bot">人机</span>`);
      if (r.state === 'waiting' && s.ready) badges.push(`<span class="badge ready">已准备</span>`);
      if (r.mode === 'team') badges.push(`<span class="badge ${s.team === 0 ? 'team-a' : 'team-b'}">${s.team === 0 ? 'A队' : 'B队'}</span>`);
      if (r.state !== 'waiting') badges.push(`<span class="badge">${s.cardCount} 张</span>`);
      const classes = ['seat', `pos-${pos}`, s.isTurn ? 'turn' : '', s.connected ? '' : 'offline'].filter(Boolean).join(' ');
      const canSwap = r.state === 'waiting' || r.state === 'finished';
      let swapBtn = '';
      if (canSwap) {
        if (s.seat === r.mySeat) {
          swapBtn = `<div class="seat-swap mine">我的座位</div>`;
        } else if (s.empty) {
          swapBtn = `<button class="seat-swap" data-action="seat" data-seat="${s.seat}">入座</button>`;
        } else {
          swapBtn = `<button class="seat-swap" data-action="seat" data-seat="${s.seat}">换座</button>`;
        }
      }
      return `<div class="${classes}">
        <div class="avatar">${esc((s.name || '?').slice(0, 1))}</div>
        <div class="seat-name">${esc(s.name)}${s.seat === r.mySeat ? '（我）' : ''}</div>
        <div class="seat-badges">${badges.join('')}</div>
        <div class="seat-points ${s.captured ? '' : 'zero'}">${s.captured} 分</div>
        ${swapBtn}
      </div>`;
    })
    .join('');

  const felt = $('#felt');
  felt.innerHTML = `${seats}<div class="table-center">${centerHTML()}</div>`;
}

function centerHTML() {
  const r = state.room;
  if (r.state === 'waiting') {
    const count = r.seats.filter((s) => !s.empty).length;
    const bots = r.seats.filter((s) => !s.empty && s.isBot).length;
    const full = count >= r.maxSeats;
    const me = r.seats[r.mySeat];
    const ready = me && !me.empty ? me.ready : false;
    return `<div class="waiting-box">
      <div class="muted" style="font-size:11px;letter-spacing:.24em">房间号</div>
      <div class="waiting-code">${r.id}</div>
      <div class="waiting-desc">
        已入座 ${count} / ${r.maxSeats} 人 · ${esc(r.modeName)}<br>
        把房间号发给好友，坐满即可开始
      </div>
      <div class="waiting-actions">
        ${r.isHost
          ? `<button class="btn primary" data-action="start" ${r.canStart ? '' : 'disabled'}>开始牌局</button>`
          : `<button class="btn ${ready ? 'ghost' : 'primary'}" data-action="ready">${ready ? '取消准备' : '准备'}</button>`}
        ${r.isHost ? `<button class="btn ghost" data-action="addbot" ${full ? 'disabled' : ''}>添加人机</button>` : ''}
        ${r.isHost && bots > 0 ? `<button class="btn ghost" data-action="removebot">移除人机</button>` : ''}
        <button class="btn ghost" data-action="copy">复制房间号</button>
        <button class="btn ghost" data-action="leave">离开</button>
      </div>
      ${r.isHost && !full ? '<div class="wait-note">等待玩家坐满后即可开始，也可添加人机补位</div>' : ''}
    </div>`;
  }

  let status = '';
  if (r.state === 'declaring') {
    if (r.trumpSuit) {
      status = `已亮主：<strong>${SUIT_SYM[r.trumpSuit]} ${SUIT_NAME[r.trumpSuit]}</strong> · ${esc(seatName(r.declarerSeat))} 坐庄`;
    } else {
      status = `等待玩家亮主…<br><span class="wait-note">用单张 2 点亮主花色</span>`;
    }
  } else if (r.state === 'bidding' && r.bidding) {
    const hb = r.bidding.highestBidder;
    status = `叫分中：当前 <strong>${r.bidding.currentBid} 分</strong>${hb !== null ? ` · ${esc(seatName(hb))}` : ' · 尚无人叫'}`;
  } else if (r.state === 'burying') {
    status = `${esc(seatName(r.declarerSeat))} 正在扣底…`;
  } else if (r.state === 'playing') {
    const turnName = seatName(r.turn);
    if (r.turn === r.mySeat) status = `<strong>轮到你出牌</strong>`;
    else status = `等待 <strong>${esc(turnName)}</strong> 出牌`;
  } else if (r.state === 'finished') {
    status = r.result ? `<strong>${esc(r.result.title)}</strong>` : '本局结束';
  }

  const current = r.trick && r.trick.plays && r.trick.plays.length ? r.trick.plays : null;
  const last = !current && r.lastTrick ? r.lastTrick : null;
  const plays = current || (last ? last.plays : []);

  // 出牌动画：只对本墩中新出现的出牌组做飞入动画
  if (!state.animatedPlays) state.animatedPlays = new Set();
  const leadSig = current && r.trick.lead
    ? `${r.roundNo}:${r.trick.lead.seat}:${(r.trick.lead.cards || []).map((c) => c.id).join(',')}`
    : null;
  if (state._trickLeadSig !== leadSig) {
    state._trickLeadSig = leadSig;
    state.animatedPlays.clear();
  }
  let groups = '';
  if (plays.length) {
    groups = plays
      .map((p) => {
        const win = last && last.winner === p.seat;
        const cards = p.cards.map((c) => cardHTML(c, { mini: true, trumpSuit: r.trumpSuit })).join('');
        const leadMark = r.trick && r.trick.lead && r.trick.lead.seat === p.seat && current ? ' · 首出' : '';
        const pkey = `${p.seat}:${p.cards.map((c) => c.id).join(',')}`;
        const isNew = current && !state.animatedPlays.has(pkey);
        if (isNew) state.animatedPlays.add(pkey);
        const pos = posFor(p.seat);
        const animCls = isNew ? `fly from-${pos}` : '';
        return `<div class="play-group ${animCls}">
          <div class="play-cards">${cards}</div>
          <div class="play-name ${win ? 'winner' : ''}">${esc(seatName(p.seat))}${win ? ' ✓' : leadMark}</div>
        </div>`;
      })
      .join('');
  } else {
    groups = `<div class="phase-desc" style="opacity:.55">等待出牌…</div>`;
  }

  // 主花色醒目展示
  let trumpBadge = '';
  if (r.trumpSuit) {
    const red = r.trumpSuit === 'H' || r.trumpSuit === 'D';
    trumpBadge = `<div class="trump-indicator ${red ? 'red' : ''}" title="本局主花色">
      <span class="ti-sym">${SUIT_SYM[r.trumpSuit]}</span>
      <span>主 · ${SUIT_NAME[r.trumpSuit]}</span>
    </div>`;
  } else if (r.state === 'declaring') {
    trumpBadge = `<div class="trump-indicator" style="opacity:.55"><span class="ti-sym">?</span><span>主花色未定</span></div>`;
  }

  let foot = '';
  if (r.state === 'playing') {
    const pts = (r.trick.plays || []).reduce((n, p) => n + p.cards.reduce((m, c) => m + cardPoints(c), 0), 0);
    foot = `本墩 ${pts} 分 · 底牌 6 张`;
  } else if (last) {
    foot = `上一墩：${esc(last.winnerName)} +${last.points} 分`;
  } else if (r.state === 'bidding') {
    foot = '底分 55 · 每次至少 +5';
  } else if (r.state === 'declaring') {
    foot = `亮主剩余 ${fmtRemain(r.deadline)}`;
  } else if (r.state === 'finished' && r.result) {
    foot = `${r.result.detail}`;
  }

  return `${trumpBadge}
    <div class="center-status">${status}</div>
    <div class="trick-zone">${groups}</div>
    <div class="center-foot">${foot}</div>`;
}

// 抓底牌后公开的 6 张底牌（所有玩家可见），显示在牌桌下方
function renderBottomBar() {
  const r = state.room;
  const bar = $('#bottom-bar');
  const visible = r && r.bottomRevealed && r.state !== 'finished' && r.state !== 'waiting' && Array.isArray(r.bottom) && r.bottom.length;
  if (!visible) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  const cards = r.bottom.map((c) => cardHTML(c, { mini: true, trumpSuit: r.trumpSuit })).join('');
  bar.innerHTML = `<span class="bb-label">底牌公开</span>
    <div class="play-cards bb-cards">${cards}</div>
    <span class="bb-note">庄家抓起的 6 张底牌，所有人可见</span>`;
  bar.classList.remove('hidden');
}

function renderScoreboard() {
  const r = state.room;
  const rows = r.seats
    .filter((s) => !s.empty)
    .map((s) => {
      const isMe = s.seat === r.mySeat;
      return `<div class="score-row ${s.isDeclarer ? 'declarer' : ''} ${isMe ? 'me' : ''}">
        <span class="s-name">${esc(s.name)}${isMe ? '（我）' : ''}</span>
        <span class="s-role">${roleLabel(s)}</span>
        <span class="s-pts">${s.captured}</span>
      </div>`;
    })
    .join('');
  $('#scoreboard').innerHTML = rows;
}

function renderLog() {
  const r = state.room;
  const el = $('#game-log');
  el.innerHTML = (r.log || [])
    .map(
      (l) =>
        `<div class="log-item ${esc(l.kind)}"><span class="t">${fmtClock(l.at)}</span>${esc(l.text)}</div>`,
    )
    .join('');
  el.scrollTop = el.scrollHeight;
}

/* ---------------- 阶段面板 ---------------- */
function renderPhase() {
  const r = state.room;
  const panel = $('#phase-panel');
  if (!r || r.state === 'waiting') {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }
  let html = '';
  if (r.state === 'declaring') {
    html = phaseDeclaring(r);
  } else if (r.state === 'bidding') {
    html = phaseBidding(r);
  } else if (r.state === 'burying') {
    html = phaseBurying(r);
  } else if (r.state === 'playing') {
    html = phasePlaying(r);
  } else if (r.state === 'finished') {
    html = phaseFinished(r);
  }
  if (!html) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }
  panel.classList.remove('hidden');
  panel.innerHTML = html;
}

function phaseDeclaring(r) {
  const passed = r.declaration && r.declaration.passed.includes(r.mySeat);
  const btns = [];
  if (r.mySeat >= 0) {
    if (!r.trumpSuit) {
      for (const c of (r.hand || []).filter((x) => x.r === '2')) {
        btns.push(
          `<button class="btn small primary" data-action="declare" data-cards="${c.id}">亮 ${SUIT_SYM[c.s]}2 · ${SUIT_NAME[c.s]}</button>`,
        );
      }
    } else {
      for (const s of SUITS) {
        if (s === r.trumpSuit) continue;
        const two = (r.hand || []).find((c) => c.s === s && c.r === '2');
        const five = (r.hand || []).find((c) => c.s === s && c.r === '5');
        if (two && five) {
          btns.push(
            `<button class="btn small primary" data-action="declare" data-cards="${two.id},${five.id}">反主 ${SUIT_SYM[s]}2+${SUIT_SYM[s]}5 → ${SUIT_NAME[s]}</button>`,
          );
        }
      }
    }
    btns.push(
      `<button class="btn small ghost" data-action="pass-declare" ${passed ? 'disabled' : ''}>${passed ? '已过' : '过'}</button>`,
    );
  }
  const desc = r.trumpSuit
    ? `当前主花色 ${SUIT_SYM[r.trumpSuit]} ${SUIT_NAME[r.trumpSuit]}，${esc(seatName(r.declarerSeat))} 临时坐庄；可用同花色 2+5 反主。`
    : '用任意单张 2 亮主；亮主者成为临时庄家。';
  return `<div>
      <div class="phase-title">亮主 / 反主</div>
      <div class="phase-desc">${desc}</div>
    </div>
    <div class="phase-actions">${btns.join('')}<span class="phase-countdown" data-deadline="${r.deadline || ''}"></span></div>`;
}

function phaseBidding(r) {
  const b = r.bidding;
  if (!b) return '';
  const passedNames = b.passed.map((i) => seatName(i)).filter(Boolean);
  let actions = '';
  if (r.mySeat >= 0 && b.turn === r.mySeat) {
    const base = b.highestBidder === null ? 55 : b.currentBid + 5;
    // 可用加分：从 base 起 5 分一档到 95
    const options = [];
    for (let v = base; v <= 95; v += 5) options.push(v);
    // 状态：state.biddingChoice 可能是 null（未选）、'add'（选了加分）
    const choice = state.biddingChoice === 'add' && options.length > 0 ? 'add' : null;
    if (choice === 'add') {
      actions =
        `<div class="bid-option-group">
          <span class="phase-desc">选择加分数值：</span>
          <div class="bid-grid">
            ${options.map((v) => `<button class="btn small primary" data-action="bid" data-value="${v}">+${v - (b.highestBidder === null ? 55 : b.currentBid)} · ${v} 分</button>`).join('')}
          </div>
          <div class="bid-foot-row">
            <button class="btn small ghost" data-action="bid-choice" data-choice="none">← 返回</button>
            <button class="btn small ghost danger" data-action="bid" data-value="pass">不加（过）</button>
          </div>
        </div>`;
    } else {
      actions =
        `<button class="btn small ghost danger" data-action="bid" data-value="pass">不加（过）</button>` +
        (options.length > 0
          ? `<button class="btn small primary" data-action="bid-choice" data-choice="add">加分</button>`
          : `<button class="btn small ghost" disabled>已到最高分</button>`);
    }
  } else {
    actions = `<span class="phase-countdown" data-deadline="${r.deadline || ''}"></span>`;
  }
  const desc =
    r.mySeat === b.turn
      ? `轮到你叫分：当前${b.highestBidder === null ? '底' : ''}分 ${b.currentBid}，可选加分或不加。`
      : `当前最高 ${b.currentBid} 分${b.highestBidder !== null ? `（${esc(seatName(b.highestBidder))}）` : ''} · 等待 ${esc(seatName(b.turn))} 叫分。`;
  return `<div>
      <div class="phase-title">叫分竞标</div>
      <div class="phase-desc">${desc}${passedNames.length ? ` · 已过：${esc(passedNames.join('、'))}` : ''}</div>
    </div>
    <div class="phase-actions bid-actions">${actions}</div>`;
}

function phaseBurying(r) {
  if (r.mySeat !== r.declarerSeat) {
    return `<div>
      <div class="phase-title">扣底阶段</div>
      <div class="phase-desc">${esc(seatName(r.declarerSeat))} 正在扣底，请稍候…</div>
    </div>
    <div class="phase-actions"><span class="phase-countdown" data-deadline="${r.deadline || ''}"></span></div>`;
  }
  const fixed = r.mode !== 'ga';
  const suitBtns = fixed
    ? `<span class="chip gold">主 ${SUIT_SYM[r.trumpSuit]} ${SUIT_NAME[r.trumpSuit]}</span>`
    : SUITS.map(
        (s) =>
          `<button class="btn small ${state.burySuit === s ? 'primary' : 'ghost'}" data-action="suit" data-suit="${s}">${SUIT_SYM[s]} ${SUIT_NAME[s]}</button>`,
      ).join('');
  const count = state.selected.size;
  const canBury = count === 6 && !!state.burySuit;
  return `<div>
      <div class="phase-title">扣底</div>
      <div class="phase-desc">${fixed ? '主花色已确定。' : '选择本局主花色，'}在手牌中选中 6 张扣入底牌（已选 ${count}/6）。</div>
    </div>
    <div class="phase-actions">${suitBtns}
      <button class="btn small ghost" data-action="clear">清空</button>
      <button class="btn small primary" data-action="bury" ${canBury ? '' : 'disabled'}>确认扣底</button>
      <span class="phase-countdown" data-deadline="${r.deadline || ''}"></span>
    </div>`;
}

function phasePlaying(r) {
  const myTurn = r.turn === r.mySeat;
  const lead = r.trick && r.trick.lead;
  const n = state.selected.size;
  const desc = myTurn
    ? `轮到你${lead ? '跟牌' : '首出'}${lead ? `（首出：${LEAD_NAME[lead.type] || ''}）` : ''}，已选 ${n} 张。`
    : `等待 ${esc(seatName(r.turn))} 出牌…`;
  const actions = myTurn
    ? `<span class="chip gold">${describeSelection(selectedCards(), r.trumpSuit, lead)}</span>
      <button class="btn small ghost" data-action="clear">清空</button>
      <button class="btn small primary" data-action="play">出牌${n ? ` (${n})` : ''}</button>`
    : `<span class="phase-countdown" data-deadline="${r.deadline || ''}"></span>`;
  return `<div>
      <div class="phase-title">出牌</div>
      <div class="phase-desc">${desc}</div>
    </div>
    <div class="phase-actions">${actions}</div>`;
}

function phaseFinished(r) {
  const count = r.seats.filter((s) => !s.empty).length;
  const bots = r.seats.filter((s) => !s.empty && s.isBot).length;
  return `<div>
      <div class="phase-title">${esc(r.result ? r.result.title : '本局结束')}</div>
      <div class="phase-desc">${esc(r.result ? r.result.detail : '')}</div>
    </div>
    <div class="phase-actions">
      <button class="btn small ghost" data-action="show-result">查看结果</button>
      ${r.isHost ? `<button class="btn small ghost" data-action="addbot" ${count >= r.maxSeats ? 'disabled' : ''}>添加人机</button>` : ''}
      ${r.isHost && bots > 0 ? '<button class="btn small ghost" data-action="removebot">移除人机</button>' : ''}
      ${r.canStart ? `<button class="btn small primary" data-action="start">再来一局</button>` : ''}
      <button class="btn small ghost" data-action="leave">返回大厅</button>
    </div>`;
}

/* ---------------- 手牌 ---------------- */
function canSelectCards() {
  const r = state.room;
  if (!r) return false;
  if (r.state === 'playing' && r.turn === r.mySeat) return true;
  if (r.state === 'burying' && r.mySeat === r.declarerSeat) return true;
  return false;
}

function handTotalPoints(hand) {
  return (hand || []).reduce((n, c) => n + cardPoints(c), 0);
}

function renderHand() {
  const r = state.room;
  if (!r) return;
  const hand = r.hand || [];
  const me = r.mySeat >= 0 ? r.seats[r.mySeat] : null;
  const metaBits = [];
  if (me) {
    metaBits.push(`<span class="chip">我 · ${hand.length} 张</span>`);
    metaBits.push(`<span class="chip gold">已得 ${me.captured} 分</span>`);
    metaBits.push(`<span class="chip">手牌 ${handTotalPoints(hand)} 分</span>`);
    metaBits.push(`<span class="chip">${roleLabel(me)}</span>`);
    if (!me.connected) metaBits.push(`<span class="chip red">托管中</span>`);
  }
  // 扣底阶段：说明选中的底牌分数不会丢失，结算时计入（庄家赢最后一墩则归庄家，否则翻倍归抓分方）
  if (r.state === 'burying' && r.mySeat === r.declarerSeat) {
    const sel = selectedCards();
    const bottomPts = handTotalPoints(sel);
    metaBits.push(
      `<span class="chip gold">底牌 ${bottomPts} 分（不扣分，结算计入）</span>`,
    );
  }
  if (r.state === 'playing') {
    metaBits.push(`<span class="chip">${r.turn === r.mySeat ? '轮到你' : `等待 ${esc(seatName(r.turn))}`}</span>`);
  }
  $('#hand-meta').innerHTML = metaBits.join('');

  const dealing = !!state.dealing;
  const handHTML = hand
    .map((c, i) => {
      const opts = { trumpSuit: r.trumpSuit, selected: state.selected.has(c.id) };
      if (dealing) opts.dealDelay = i * 60; // 每张间隔 60ms，16 张约 1 秒
      return cardHTML(c, opts);
    })
    .join('');
  $('#hand').innerHTML = handHTML || `<span class="muted" style="font-size:12px">暂无手牌</span>`;

  const actions = [];
  if (r.state === 'playing' && r.turn === r.mySeat) {
    actions.push(
      `<button class="btn small ghost" data-action="clear">清空</button>`,
      `<button class="btn primary small" data-action="play" ${state.selected.size ? '' : 'disabled'}>出牌${state.selected.size ? ` (${state.selected.size})` : ''}</button>`,
    );
  } else if (r.state === 'burying' && r.mySeat === r.declarerSeat) {
    actions.push(
      `<button class="btn small ghost" data-action="clear">清空</button>`,
      `<button class="btn primary small" data-action="bury" ${state.selected.size === 6 && state.burySuit ? '' : 'disabled'}>扣底 ${state.selected.size}/6</button>`,
    );
  }
  $('#hand-actions').innerHTML = actions.join('');
}

/* ---------------- 结果弹层 ---------------- */
function renderResultOverlay() {
  const r = state.room;
  const overlay = $('#result-overlay');
  const modal = $('#result-modal');
  if (!r || r.state !== 'finished' || !r.result || !state.resultOpen) {
    overlay.classList.add('hidden');
    return;
  }
  const res = r.result;
  const sides = res.sides
    .map(
      (s) => `<div class="result-side ${s.won ? 'won' : ''}">
        <div class="rs-name">${esc(s.name)}</div>
        <div class="rs-points">${s.points}</div>
        <div class="rs-tag">${s.won ? '本局获胜' : '本局落败'}${res.bidValue ? ` · 叫分 ${res.bidValue}` : ''}</div>
      </div>`,
    )
    .join('');
  const bottomCards = (r.bottom || []).map((c) => cardHTML(c, { mini: true, trumpSuit: r.trumpSuit })).join('');
  modal.innerHTML = `<div class="result-kicker">第 ${r.roundNo} 局 · ${esc(r.modeName)} · 主 ${SUIT_SYM[r.trumpSuit] || ''}</div>
    <div class="result-title">${esc(res.title)}</div>
    <div class="result-detail">${esc(res.detail)}${res.bottomDoubled ? ' · 抓分方抠底，底牌翻倍' : ''}</div>
    <div class="result-sides">${sides}</div>
    <div class="result-bottom">
      <span class="label">底牌 ${res.bottomPoints} 分${res.bottomDoubled ? ' ×2' : ''}</span>
      ${bottomCards}
    </div>
    <div class="result-actions">
      <button class="btn primary" data-action="start" ${r.canStart ? '' : 'disabled'}>${r.canStart ? '再来一局' : '等待房主开始'}</button>
      <button class="btn ghost" data-action="leave">返回大厅</button>
      <button class="btn ghost" data-action="close-result">关闭</button>
    </div>`;
  overlay.classList.remove('hidden');
}

/* ---------------- 交互 ---------------- */
function toggleCard(id) {
  if (!canSelectCards()) return;
  const r = state.room;
  if (state.selected.has(id)) {
    state.selected.delete(id);
  } else {
    if (r.state === 'burying' && state.selected.size >= 6) {
      toast('底牌只能扣 6 张', 'error');
      return;
    }
    state.selected.add(id);
  }
  renderHand();
  renderPhase();
}

async function handleAction(action, el) {
  const r = state.room;
  switch (action) {
    case 'join':
      send({ t: 'room.join', roomId: el.dataset.room });
      break;
    case 'copy':
      try {
        await navigator.clipboard.writeText(r ? r.id : '');
        toast('房间号已复制', 'good');
      } catch {
        toast(r ? `房间号：${r.id}` : '复制失败', 'error');
      }
      break;
    case 'start':
      send({ t: 'room.start' });
      break;
    case 'ready': {
      const me = r && r.seats[r.mySeat];
      send({ t: 'room.ready', ready: !(me && me.ready) });
      break;
    }
    case 'addbot':
      send({ t: 'room.addbot' });
      break;
    case 'removebot':
      send({ t: 'room.removebot' });
      break;
    case 'leave':
      if (r && r.state !== 'waiting' && r.state !== 'finished') {
        if (!confirm('牌局进行中，离开后将自动托管。确定离开吗？')) return;
      }
      send({ t: 'room.leave' });
      break;
    case 'seat':
      send({ t: 'seat.take', seat: Number(el.dataset.seat) });
      break;
    case 'play':
      if (!r || r.state !== 'playing' || r.turn !== r.mySeat) return;
      if (!state.selected.size) return toast('请先选择手牌', 'error');
      if (state.busy) return;
      state.busy = true;
      setTimeout(() => (state.busy = false), 800);
      send({ t: 'play', cards: [...state.selected] });
      break;
    case 'clear':
      state.selected.clear();
      renderHand();
      renderPhase();
      break;
    case 'bury':
      if (!r || r.state !== 'burying' || r.mySeat !== r.declarerSeat) return;
      if (state.selected.size !== 6) return toast('请选择 6 张底牌', 'error');
      if (!state.burySuit) return toast('请选择主花色', 'error');
      send({ t: 'bury', suit: state.burySuit, cards: [...state.selected] });
      break;
    case 'suit':
      state.burySuit = el.dataset.suit;
      renderPhase();
      break;
    case 'declare': {
      const cards = (el.dataset.cards || '').split(',').filter(Boolean);
      send({ t: 'declare', cards });
      break;
    }
    case 'pass-declare':
      send({ t: 'declare.pass' });
      break;
    case 'bid': {
      const value = el.dataset.value === 'pass' ? 'pass' : Number(el.dataset.value);
      state.biddingChoice = null;
      send({ t: 'bid', value });
      break;
    }
    case 'bid-choice': {
      state.biddingChoice = el.dataset.choice === 'add' ? 'add' : null;
      renderPhase();
      break;
    }
    case 'close-result':
      state.resultOpen = false;
      renderResultOverlay();
      break;
    case 'show-result':
      state.resultOpen = true;
      renderResultOverlay();
      break;
    default:
      break;
  }
}

/* ---------------- 管理员 ---------------- */
async function openAdmin() {
  $('#admin-overlay').classList.remove('hidden');
  $('#admin-body').innerHTML = '<div class="phase-desc">加载中…</div>';
  try {
    await refreshAdmin();
  } catch (e) {
    $('#admin-body').innerHTML = `<div class="phase-desc" style="color:#ffb1aa">${esc(e.message)}</div>`;
  }
}

async function refreshAdmin() {
  const [u, s, h, st] = await Promise.all([
    api('/api/admin/users'),
    api('/api/admin/stats'),
    api('/api/admin/history'),
    api('/api/admin/settings'),
  ]);
  state.adminUsers = u.users;
  state.adminStats = s;
  state.adminHistory = h.history;
  state.adminSettings = st.settings;
  renderAdmin();
}

function renderAdmin() {
  const body = $('#admin-body');
  const stats = state.adminStats || {};
  const tabs = `<div class="admin-tabs">
    <button class="admin-tab ${state.adminTab === 'users' ? 'active' : ''}" data-admin-tab="users">账号管理</button>
    <button class="admin-tab ${state.adminTab === 'settings' ? 'active' : ''}" data-admin-tab="settings">功能设置</button>
    <button class="admin-tab ${state.adminTab === 'history' ? 'active' : ''}" data-admin-tab="history">对局记录</button>
  </div>`;
  const statHTML = `<div class="admin-stats">
    <div class="stat-box"><div class="k">账号总数</div><div class="v">${stats.users ?? 0}</div></div>
    <div class="stat-box"><div class="k">累计对局</div><div class="v">${stats.games ?? 0}</div></div>
    <div class="stat-box"><div class="k">当前在线</div><div class="v">${stats.online ?? 0}</div></div>
  </div>`;

  if (state.adminTab === 'history') {
    const list = (state.adminHistory || [])
      .map(
        (h) => `<div class="history-item">
          <div class="h-title">${esc(h.result.title)} · ${esc(h.roomName)}</div>
          <div class="h-meta">${fmtDate(h.at)} · ${MODE_NAME[h.mode] || h.mode} · ${esc(h.result.detail)}</div>
        </div>`,
      )
      .join('');
    body.innerHTML = `${statHTML}${tabs}<div class="history-list">${list || '<div class="phase-desc">暂无对局记录</div>'}</div>`;
    return;
  }

  if (state.adminTab === 'settings') {
    const st = state.adminSettings || {};
    body.innerHTML = `${statHTML}${tabs}
      <div class="settings-list">
        <label class="setting-row">
          <div>
            <div class="setting-title">开放用户注册</div>
            <div class="setting-desc">关闭后，新玩家只能由管理员在「账号管理」中创建账号。</div>
          </div>
          <label class="switch">
            <input type="checkbox" data-admin-action="setting" data-key="allowRegister" ${st.allowRegister ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
        </label>
        <label class="setting-row">
          <div>
            <div class="setting-title">开放记牌器</div>
            <div class="setting-desc">开启后，牌桌内显示记牌器，可查看每种牌已出/剩余数量。</div>
          </div>
          <label class="switch">
            <input type="checkbox" data-admin-action="setting" data-key="cardCounter" ${st.cardCounter ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
        </label>
      </div>`;
    return;
  }

  const rows = (state.adminUsers || [])
    .map((u) => {
      const isSelf = state.user && u.id === state.user.id;
      const actions = [];
      actions.push(`<button class="btn ghost small" data-admin-action="reset" data-id="${u.id}">重置密码</button>`);
      if (!isSelf) {
        actions.push(
          `<button class="btn ghost small" data-admin-action="admin" data-id="${u.id}">${u.isAdmin ? '取消管理' : '设为管理'}</button>`,
          `<button class="btn ${u.disabled ? 'ghost' : 'danger'} small" data-admin-action="disable" data-id="${u.id}">${u.disabled ? '启用' : '禁用'}</button>`,
          `<button class="btn danger small" data-admin-action="delete" data-id="${u.id}">删除</button>`,
        );
      }
      return `<tr>
        <td><div class="user-cell"><div class="user-dot">${esc((u.nickname || u.username).slice(0, 1))}</div>
          <div><div class="u-main">${esc(u.nickname || u.username)}</div><div class="u-sub">@${esc(u.username)}</div></div>
        </div></td>
        <td>${u.isAdmin ? '<span class="tag admin">管理员</span>' : '<span class="tag">玩家</span>'}</td>
        <td>${u.disabled ? '<span class="tag banned">已禁用</span>' : '<span class="tag">正常</span>'}</td>
        <td>${u.games || 0} 局 / 胜 ${u.wins || 0}</td>
        <td class="muted">${u.lastLoginAt ? fmtDate(u.lastLoginAt) : '从未登录'}</td>
        <td><div class="row-actions">${actions.join('')}</div></td>
      </tr>`;
    })
    .join('');

  body.innerHTML = `${statHTML}${tabs}
    <form class="admin-form" id="admin-create-form">
      <label class="field"><span>账号</span><input name="username" required placeholder="2-20 位"></label>
      <label class="field"><span>昵称</span><input name="nickname" placeholder="可选"></label>
      <label class="field"><span>初始密码</span><input name="password" required placeholder="至少 4 位"></label>
      <label class="admin-check"><input type="checkbox" name="isAdmin"> 管理员</label>
      <button class="btn primary small" type="submit">添加账号</button>
    </form>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr><th>账号</th><th>角色</th><th>状态</th><th>战绩</th><th>最近登录</th><th>操作</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="muted">暂无账号</td></tr>'}</tbody>
      </table>
    </div>`;
}

async function handleAdminAction(action, el) {
  try {
    if (action === 'setting') {
      const key = el.dataset.key;
      const value = el.checked;
      await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ [key]: value }) });
      toast(`${value ? '已开启' : '已关闭'}`, 'good');
      await refreshAdmin();
      return;
    }
    const id = el.dataset.id;
    const user = (state.adminUsers || []).find((u) => u.id === id);
    if (!user) return;
    if (action === 'reset') {
      const pwd = prompt(`为「${user.nickname || user.username}」设置新密码（至少 4 位）`);
      if (!pwd) return;
      await api(`/api/admin/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password: pwd }) });
      toast('密码已重置', 'good');
    } else if (action === 'admin') {
      await api(`/api/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isAdmin: !user.isAdmin }),
      });
      toast(user.isAdmin ? '已取消管理员' : '已设为管理员', 'good');
    } else if (action === 'disable') {
      await api(`/api/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ disabled: !user.disabled }),
      });
      toast(user.disabled ? '账号已启用' : '账号已禁用', 'good');
    } else if (action === 'delete') {
      if (!confirm(`确定删除账号「${user.nickname || user.username}」？该操作不可恢复。`)) return;
      await api(`/api/admin/users/${id}`, { method: 'DELETE' });
      toast('账号已删除', 'good');
    }
    await refreshAdmin();
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ---------------- 登录 / 注册 ---------------- */
async function doLogin(e) {
  e.preventDefault();
  const username = $('#login-username').value.trim();
  const password = $('#login-password').value;
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    state.user = data.user;
    applyUser();
    state.room = null;
    connect();
    render();
    toast('登录成功，欢迎回来', 'good');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function doRegister(e) {
  e.preventDefault();
  const username = $('#reg-username').value.trim();
  const nickname = $('#reg-nickname').value.trim();
  const password = $('#reg-password').value;
  try {
    const data = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({ username, nickname, password }),
    });
    state.user = data.user;
    applyUser();
    state.room = null;
    connect();
    render();
    toast('账号创建成功', 'good');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function setAuthTab(tab) {
  state.authTab = tab;
  $$('.auth-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#login-form').classList.toggle('hidden', tab !== 'login');
  $('#register-form').classList.toggle('hidden', tab !== 'register');
}

async function logout() {
  try {
    await api('/api/logout', { method: 'POST', body: '{}' });
  } catch {}
  state.user = null;
  state.room = null;
  state.rooms = [];
  state.selected.clear();
  state.resultOpen = false;
  clearTimeout(state.wsRetry);
  if (state.ws) {
    try {
      state.ws.close();
    } catch {}
  }
  state.ws = null;
  showScreen('auth');
  setAuthTab('login');
  $('#login-form').reset();
  $('#felt').innerHTML = '';
  $('#hand').innerHTML = '';
  $('#phase-panel').classList.add('hidden');
  $('#hand-meta').textContent = '';
}

/* ---------------- 定时刷新 ---------------- */
function tickTimers() {
  $$('[data-deadline]').forEach((el) => {
    const dl = Number(el.dataset.deadline);
    if (!dl || Number.isNaN(dl)) {
      el.textContent = '';
      return;
    }
    const text = fmtRemain(dl);
    el.textContent = text;
    el.classList.toggle('urgent', dl - Date.now() < 8000);
  });
  const timer = $('#turn-timer');
  if (timer && timer.dataset.deadline) {
    const dl = Number(timer.dataset.deadline);
    timer.textContent = fmtRemain(dl);
    timer.classList.toggle('urgent', dl - Date.now() < 8000);
  }
}

/* ---------------- 绑定 ---------------- */
function bind() {
  $$('.auth-tab').forEach((btn) => btn.addEventListener('click', () => setAuthTab(btn.dataset.tab)));
  $('#login-form').addEventListener('submit', doLogin);
  $('#register-form').addEventListener('submit', doRegister);
  $('#logout-btn').addEventListener('click', logout);
  $('#refresh-rooms').addEventListener('click', () => send({ t: 'rooms.list' }));
  $('#open-rules-btn').addEventListener('click', () => $('#rules-overlay').classList.remove('hidden'));
  $('#table-rules-btn').addEventListener('click', () => $('#rules-overlay').classList.remove('hidden'));
  $('#card-counter-btn').addEventListener('click', () => {
    renderCardCounter();
    $('#card-counter-overlay').classList.remove('hidden');
  });
  $('#open-admin-btn').addEventListener('click', openAdmin);
  $('#table-leave').addEventListener('click', () => handleAction('leave'));

  $('#create-mode').addEventListener('change', () => {
    const mode = $('#create-mode').value;
    const seats = $('#create-seats');
    if (mode === 'grab') {
      seats.innerHTML = '<option value="3">3 人</option><option value="4">4 人</option>';
      seats.disabled = false;
    } else {
      seats.innerHTML = '<option value="4">4 人</option>';
      seats.disabled = true;
    }
    $('#mode-tip').textContent = MODE_DESC[mode];
  });

  $('#create-room').addEventListener('click', () => {
    const mode = $('#create-mode').value;
    const seats = Number($('#create-seats').value);
    const name = $('#create-name').value.trim();
    if (!send({ t: 'room.create', mode, seats, name })) return;
    $('#create-name').value = '';
  });

  $('#room-code').addEventListener('click', () => {
    if (!state.room) return;
    navigator.clipboard
      .writeText(state.room.id)
      .then(() => toast(`房间号 ${state.room.id} 已复制`, 'good'))
      .catch(() => toast(`房间号：${state.room.id}`, 'error'));
  });

  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('[data-close]');
    if (closeBtn) {
      $('#' + closeBtn.dataset.close).classList.add('hidden');
      return;
    }
    const actionEl = e.target.closest('[data-action]');
    if (actionEl) {
      e.preventDefault();
      handleAction(actionEl.dataset.action, actionEl);
      return;
    }
    const adminAction = e.target.closest('[data-admin-action]');
    if (adminAction) {
      e.preventDefault();
      handleAdminAction(adminAction.dataset.adminAction, adminAction);
      return;
    }
    const adminTab = e.target.closest('[data-admin-tab]');
    if (adminTab) {
      state.adminTab = adminTab.dataset.adminTab;
      renderAdmin();
    }
  });

  $('#hand').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card || !card.dataset.id) return;
    toggleCard(card.dataset.id);
  });

  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'admin-create-form') return;
    e.preventDefault();
    const form = e.target;
    const data = {
      username: form.username.value.trim(),
      nickname: form.nickname.value.trim(),
      password: form.password.value,
      isAdmin: form.isAdmin.checked,
    };
    try {
      await api('/api/admin/users', { method: 'POST', body: JSON.stringify(data) });
      toast('账号已创建', 'good');
      form.reset();
      await refreshAdmin();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ---------------- 启动 ---------------- */
async function init() {
  bind();
  setInterval(tickTimers, 400);
  try {
    const data = await api('/api/me');
    state.allowRegister = data.allowRegister !== false;
    if (!state.allowRegister) {
      $$('.auth-tab[data-tab="register"]').forEach((b) => b.classList.add('hidden'));
      $('#auth-hint').textContent = '管理员已关闭自助注册，请联系管理员开号';
      setAuthTab('login');
    }
    if (data.user) {
      state.user = data.user;
      applyUser();
      connect();
      render();
    } else {
      showScreen('auth');
    }
  } catch {
    showScreen('auth');
  }
}

init();
