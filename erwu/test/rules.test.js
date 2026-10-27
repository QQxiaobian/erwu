import assert from 'node:assert/strict';
import {
  makeDeck,
  cardPoints,
  handPoints,
  power,
  isTrump,
  detectLead,
  checkThrow,
  validateFollow,
  resolveTrick,
  isCombo25,
  autoSelect,
  sortHand,
  sortBySuit,
} from '../src/game/cards.js';
import { Room } from '../src/room.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

const c = (id) => {
  if (id === 'BJ') return { id: 'BJ', s: 'J', r: 'BJ' };
  if (id === 'LJ') return { id: 'LJ', s: 'J', r: 'SJ' };
  return { id, s: id[0], r: id.slice(1) };
};

console.log('牌张与牌力');
test('54 张牌、总分 100', () => {
  const deck = makeDeck();
  assert.equal(deck.length, 54);
  assert.equal(handPoints(deck), 100);
  assert.equal(new Set(deck.map((x) => x.id)).size, 54);
});
test('5 > 大王 > 小王 > 2 > 主花色普通牌 > 副牌', () => {
  const t = 'S';
  const seq = ['C5', 'BJ', 'LJ', 'D2', 'SA', 'SK', 'HA'].map((id) => power(c(id), t));
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i - 1] > seq[i], `${seq[i - 1]} > ${seq[i]}`);
});
test('主花色的 5、2 大于其他花色的 5、2', () => {
  assert.ok(power(c('S5'), 'S') > power(c('H5'), 'S'));
  assert.ok(power(c('S2'), 'S') > power(c('D2'), 'S'));
  // 非主花色的同点数常主仍然相等
  assert.equal(power(c('C5'), 'S'), power(c('H5'), 'S'));
  assert.equal(power(c('C2'), 'S'), power(c('D2'), 'S'));
});
test('常主判定', () => {
  assert.ok(isTrump(c('D5'), 'S'));
  assert.ok(isTrump(c('H2'), 'S'));
  assert.ok(isTrump(c('BJ'), 'S'));
  assert.ok(isTrump(c('SA'), 'S'));
  assert.ok(!isTrump(c('HA'), 'S'));
});
test('25 组合必须是同花色 2+5', () => {
  assert.ok(isCombo25([c('C2'), c('C5')], 'S'));
  assert.ok(!isCombo25([c('C2'), c('D5')], 'S'));
});

console.log('牌型识别');
test('单张 / 金鸡 / 25 / 甩牌', () => {
  assert.equal(detectLead([c('HA')], 'S'), 'single');
  assert.equal(detectLead([c('BJ'), c('LJ')], 'S'), 'joker');
  assert.equal(detectLead([c('S2'), c('S5')], 'S'), 'combo25');
  assert.equal(detectLead([c('C2'), c('C5')], 'S'), null, '副花色 2+5 都是常主，不算 25');
  assert.equal(detectLead([c('HK'), c('HQ')], 'S'), 'throw');
  assert.equal(detectLead([c('HK'), c('SQ')], 'S'), null);
  assert.equal(detectLead([c('SA'), c('SK')], 'S'), null);
});

console.log('甩牌校验');
test('甩出最大牌合法', () => {
  const hands = [[c('HA'), c('HK')], [c('HQ')], [], []];
  assert.ok(checkThrow([c('HA'), c('HK')], hands, [], 'S').ok);
});
test('外场有更大牌则非法，并返回最小一张', () => {
  const hands = [[c('HK'), c('HQ')], [c('HA')], [], []];
  const r = checkThrow([c('HK'), c('HQ')], hands, [], 'S');
  assert.equal(r.ok, false);
  assert.equal(r.forced.id, 'HQ');
});
test('自己剩余手牌也算外场', () => {
  const hands = [[c('HK'), c('HA')], [], [], []];
  assert.equal(checkThrow([c('HK')], hands, [], 'S').ok, false);
});

console.log('跟牌校验');
test('单张副牌必须跟同花色', () => {
  const hand = [c('H3'), c('SA')];
  const lead = { seat: 0, cards: [c('HQ')], type: 'single' };
  assert.ok(!validateFollow(hand, [c('SA')], lead, 'S').ok);
  assert.ok(validateFollow(hand, [c('H3')], lead, 'S').ok);
});
test('单张主牌必须跟主', () => {
  const hand = [c('H3'), c('S3')];
  const lead = { seat: 0, cards: [c('C5')], type: 'single' };
  assert.ok(!validateFollow(hand, [c('H3')], lead, 'S').ok);
  assert.ok(validateFollow(hand, [c('S3')], lead, 'S').ok);
});
test('金鸡强制跟最大的两张主牌', () => {
  const hand = [c('S3'), c('S4'), c('BJ'), c('HA')];
  const lead = { seat: 0, cards: [c('BJ'), c('LJ')], type: 'joker' };
  assert.ok(!validateFollow(hand, [c('BJ')], lead, 'S').ok);
  assert.ok(!validateFollow(hand, [c('HA'), c('S3')], lead, 'S').ok);
  assert.ok(!validateFollow(hand, [c('S3'), c('S4')], lead, 'S').ok);
  assert.ok(validateFollow(hand, [c('BJ'), c('S4')], lead, 'S').ok);
  assert.ok(validateFollow(hand, [c('S4'), c('BJ')], lead, 'S').ok);
});
test('金鸡时只有 1 张主牌则带出该主牌', () => {
  const hand = [c('S3'), c('HA'), c('D4')];
  const lead = { seat: 0, cards: [c('BJ'), c('LJ')], type: 'joker' };
  assert.ok(!validateFollow(hand, [c('HA'), c('D4')], lead, 'S').ok);
  assert.ok(validateFollow(hand, [c('S3'), c('HA')], lead, 'S').ok);
});
test('无主牌时金鸡可垫任意两张牌', () => {
  const hand = [c('H3'), c('D4')];
  const lead = { seat: 0, cards: [c('BJ'), c('LJ')], type: 'joker' };
  assert.ok(validateFollow(hand, [c('H3'), c('D4')], lead, 'S').ok);
  assert.ok(!validateFollow(hand, [c('H3')], lead, 'S').ok);
});
test('托管金鸡跟牌选最大两张主牌', () => {
  const hand = [c('S3'), c('S4'), c('BJ'), c('HA')];
  const lead = { seat: 0, cards: [c('BJ'), c('LJ')], type: 'joker' };
  const picked = autoSelect(hand, lead, 'S');
  assert.equal(picked.length, 2);
  assert.deepEqual(new Set(picked.map((x) => x.id)), new Set(['BJ', 'S4']));
  assert.ok(validateFollow(hand, picked, lead, 'S').ok);
});
test('25 组合跟 2 张主牌', () => {
  const hand = [c('H5'), c('S3'), c('H3')];
  const lead = { seat: 0, cards: [c('S2'), c('S5')], type: 'combo25' };
  assert.ok(!validateFollow(hand, [c('H5'), c('H3')], lead, 'S').ok);
  assert.ok(validateFollow(hand, [c('H5'), c('S3')], lead, 'S').ok);
});
test('跟主 25：有 2 张同花色必须跟同花色，不能拿常主顶替', () => {
  const hand = [c('H3'), c('H4'), c('BJ')];
  const lead = { seat: 0, cards: [c('H2'), c('H5')], type: 'combo25' };
  assert.ok(!validateFollow(hand, [c('BJ'), c('H3')], lead, 'H').ok);
  assert.ok(validateFollow(hand, [c('H3'), c('H4')], lead, 'H').ok);
});
test('跟主 25：只有 1 张同花色必须带出，另一张自由选择', () => {
  const hand = [c('H3'), c('BJ'), c('D4')];
  const lead = { seat: 0, cards: [c('H2'), c('H5')], type: 'combo25' };
  assert.ok(!validateFollow(hand, [c('BJ'), c('D4')], lead, 'H').ok);
  assert.ok(validateFollow(hand, [c('H3'), c('BJ')], lead, 'H').ok);
  assert.ok(validateFollow(hand, [c('H3'), c('D4')], lead, 'H').ok);
});
test('跟主 25：没有同花色时自由出 2 张', () => {
  const hand = [c('C3'), c('D4'), c('BJ')];
  const lead = { seat: 0, cards: [c('H2'), c('H5')], type: 'combo25' };
  assert.ok(validateFollow(hand, [c('C3'), c('D4')], lead, 'H').ok);
  assert.ok(validateFollow(hand, [c('BJ'), c('C3')], lead, 'H').ok);
});
test('甩牌足额跟同花色', () => {
  const hand = [c('H3'), c('H4'), c('D5'), c('SA')];
  const lead = { seat: 0, cards: [c('HK'), c('HQ')], type: 'throw' };
  assert.ok(!validateFollow(hand, [c('H3'), c('D5')], lead, 'S').ok);
  assert.ok(validateFollow(hand, [c('H3'), c('H4')], lead, 'S').ok);
});
test('甩牌不足时可垫牌或全主杀', () => {
  const hand = [c('H3'), c('D4'), c('S3'), c('S4')];
  const lead = { seat: 0, cards: [c('HK'), c('HQ'), c('HJ')], type: 'throw' };
  assert.ok(validateFollow(hand, [c('H3'), c('D4'), c('S3')], lead, 'S').ok);
  assert.ok(validateFollow(hand, [c('S3'), c('S4'), c('D4')], lead, 'S').ok === false);
});

console.log('墩归属');
test('单张：主牌杀牌获胜', () => {
  const lead = { seat: 0, cards: [c('HA')], type: 'single' };
  const plays = [
    { seat: 0, cards: [c('HA')] },
    { seat: 1, cards: [c('HK')] },
    { seat: 2, cards: [c('S3')] },
    { seat: 3, cards: [c('H3')] },
  ];
  assert.equal(resolveTrick(lead, plays, 'S'), 2);
});
test('单张：同花色最大者获胜', () => {
  const lead = { seat: 0, cards: [c('H8')], type: 'single' };
  const plays = [
    { seat: 0, cards: [c('H8')] },
    { seat: 1, cards: [c('HA')] },
    { seat: 2, cards: [c('HK')] },
    { seat: 3, cards: [c('D3')] },
  ];
  assert.equal(resolveTrick(lead, plays, 'S'), 1);
});
test('金鸡直接赢墩', () => {
  const lead = { seat: 0, cards: [c('BJ'), c('LJ')], type: 'joker' };
  const plays = [
    { seat: 0, cards: [c('BJ'), c('LJ')] },
    { seat: 1, cards: [c('C5')] },
    { seat: 2, cards: [c('S3')] },
    { seat: 3, cards: [c('H3')] },
  ];
  assert.equal(resolveTrick(lead, plays, 'S'), 0);
});
test('25 组合之间同点数相等，25 压普通主牌，金鸡压 25', () => {
  const lead = { seat: 0, cards: [c('S2'), c('S5')], type: 'combo25' };
  const plays = [
    { seat: 0, cards: [c('S2'), c('S5')] },
    { seat: 1, cards: [c('H5'), c('S3')] },
    { seat: 2, cards: [c('D2'), c('D5')] },
    { seat: 3, cards: [c('BJ'), c('LJ')] },
  ];
  assert.equal(resolveTrick(lead, plays, 'S'), 3);
  const plays2 = plays.slice(0, 3).concat([{ seat: 3, cards: [c('H3'), c('H4')] }]);
  assert.equal(resolveTrick(lead, plays2, 'S'), 0);
});
test('只有主花色 2+5 能作为 25 领出', () => {
  assert.equal(detectLead([c('H2'), c('H5')], 'H'), 'combo25');
  assert.equal(detectLead([c('C2'), c('C5')], 'H'), null);
  assert.equal(detectLead([c('S2'), c('S5')], 'H'), null);
});
test('甩牌：主牌杀牌后比最大主', () => {
  const lead = { seat: 0, cards: [c('HA'), c('HK')], type: 'throw' };
  const plays = [
    { seat: 0, cards: [c('HA'), c('HK')] },
    { seat: 1, cards: [c('H3'), c('D4')] },
    { seat: 2, cards: [c('C5'), c('S3')] },
    { seat: 3, cards: [c('D2'), c('S4')] },
  ];
  assert.equal(resolveTrick(lead, plays, 'S'), 2);
});

console.log('完整对局');
function seatUsers(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `u${i}`, username: `p${i}`, nickname: `玩家${i}` }));
}

function newRoom(mode, n) {
  const users = seatUsers(n);
  const room = new Room({ id: 'T1', name: 'test', mode, maxSeats: n, hostId: 'u0' });
  for (const u of users) room.addPlayer(u);
  return room;
}

function buryIds(room, seat) {
  // 底牌不能扣分牌，优先挑不带分的牌
  const hand = room.seats[seat].hand;
  const plain = hand.filter((x) => cardPoints(x) === 0);
  const rest = hand.filter((x) => cardPoints(x) > 0);
  return [...plain, ...rest].slice(0, 6).map((x) => x.id);
}

function autoPlayOut(room) {
  let guard = 0;
  while (room.state === 'playing') {
    if (++guard > 2000) throw new Error('对局没有结束');
    if (room.pendingResolveAt) {
      room._resolveTrick(Date.now());
      continue;
    }
    if (room.turn === null || room.turn === undefined) throw new Error('无出牌者');
    const res = room._autoPlay(room.turn);
    if (!res.ok) throw new Error(`自动出牌失败: ${res.error}`);
  }
}

function declareFirst(room) {
  for (let i = 0; i < room.maxSeats; i++) {
    const two = room.seats[i].hand.find((x) => x.r === '2');
    if (two) {
      const r = room.declare(`u${i}`, [two.id]);
      assert.ok(r.ok, r.error);
      return;
    }
  }
  throw new Error('无人有 2');
}

for (const mode of ['grab', 'team']) {
  for (const n of mode === 'grab' ? [3, 4] : [4]) {
    test(`${mode} ${n} 人完整自动对局`, () => {
      const room = newRoom(mode, n);
      const r = room.startRound('u0');
      assert.ok(r.ok, r.error);
      assert.ok(room.full);
      declareFirst(room);
      room._finalizeDeclaration();
      assert.equal(room.state, 'burying');
      room._autoBury();
      assert.equal(room.state, 'playing');
      autoPlayOut(room);
      assert.equal(room.state, 'finished');
      const res = room.result;
      assert.ok(res);
      const expected = 100 + res.bottomPoints * (res.bottomDoubled ? 2 : 1);
      assert.equal(res.declarerPoints + res.defenderPoints, expected);
      assert.ok(room.seats.every((s) => s.hand.length === 0));
    });
  }
}

test('甩牌时有同花色副牌不能毙牌', () => {
  const lead = { seat: 0, cards: [c('CA'), c('CK')], type: 'throw' };
  // 手里还有梅花副牌 C3，虽然够 2 张主牌也不能毙
  const hand1 = [c('C3'), c('H3'), c('H6'), c('BJ')];
  assert.ok(!validateFollow(hand1, [c('H3'), c('H6')], lead, 'H').ok);
  assert.ok(validateFollow(hand1, [c('C3'), c('H3')], lead, 'H').ok);
  // 完全没有梅花副牌时才可以毙
  const hand2 = [c('D3'), c('H3'), c('H6'), c('BJ')];
  assert.ok(validateFollow(hand2, [c('H3'), c('H6')], lead, 'H').ok);
});

test('金鸡首出：人机自动跟，真人主牌不足 2 张时停下等手动选牌', () => {
  const room = newRoom('grab', 4);
  room.startRound('u0');
  room.state = 'playing';
  room.trumpSuit = 'H';
  room.turn = 0;
  room.trick = { lead: null, plays: [] };
  room.seats[0].hand = [c('BJ'), c('LJ'), c('C3'), c('D4')];
  // 1、2 号位是人机，主牌各 2 张，由系统自动跟
  room.seats[1].hand = [c('HA'), c('H2'), c('SK'), c('C9')];
  room.seats[2].hand = [c('HA'), c('H2'), c('SK'), c('C9')];
  room.seats[1].isBot = true;
  room.seats[2].isBot = true;
  // 3 号位是真人且一张主牌都没有，必须自己选 2 张
  room.seats[3].hand = [c('SA'), c('SK'), c('C9'), c('D7')];
  const res = room.play('u0', ['BJ', 'LJ']);
  assert.ok(res.ok, res.error);
  assert.equal(room.trick.lead.type, 'joker');
  assert.equal(room.trick.plays.length, 3, '人机自动跟牌后，主牌不足的真人应停下');
  for (const i of [1, 2]) {
    assert.equal(room.trick.plays[i].cards.length, 2, '人机自动跟 2 张主牌');
    assert.ok(room.trick.plays[i].cards.every((x) => isTrump(x, 'H')));
  }
  assert.equal(room.turn, 3, '轮到主牌不足的真人手动选牌');
  // 无主牌时可自由选 2 张，出牌后本墩凑满 4 家
  const manual = room.play('u3', ['SA', 'SK']);
  assert.ok(manual.ok, manual.error);
  assert.equal(room.trick.plays.length, 4);
  assert.equal(room.trick.plays[3].cards.length, 2);
});

test('金鸡首出：真人只有 1 张主牌必须手动带出该主牌', () => {
  const room = newRoom('grab', 4);
  room.startRound('u0');
  room.state = 'playing';
  room.trumpSuit = 'H';
  room.turn = 0;
  room.trick = { lead: null, plays: [] };
  room.seats[0].hand = [c('BJ'), c('LJ'), c('C3'), c('D4')];
  room.seats[1].hand = [c('HA'), c('SK'), c('C9'), c('D7')];
  room.seats[2].hand = [c('H3'), c('H4'), c('SK'), c('C9')];
  room.seats[3].hand = [c('H6'), c('H7'), c('SK'), c('C9')];
  room.seats[2].isBot = true;
  room.seats[3].isBot = true;
  assert.ok(room.play('u0', ['BJ', 'LJ']).ok);
  assert.equal(room.turn, 1, '只有 1 张主牌的真人应停下');
  assert.equal(room.trick.plays.length, 1);
  // 不带出仅有的一张主牌会被拒绝
  assert.ok(!room.play('u1', ['SK', 'C9']).ok);
  const r = room.play('u1', ['HA', 'SK']);
  assert.ok(r.ok, r.error);
  assert.equal(room.trick.plays.length, 4, '真人出牌后其余人机继续自动跟牌');
});

test('噶点模式：全员过牌一直重发，不保底', () => {
  const room = newRoom('ga', 4);
  room.startRound('u0');
  assert.equal(room.state, 'bidding');
  // 连续 3 次全员过牌都应重发，不会保底坐庄
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 4; i++) {
      const r = room.bid(`u${room.bidding.turn}`, 'pass');
      assert.ok(r.ok, r.error);
    }
    assert.equal(room.state, 'bidding', `第 ${round + 1} 次全员过应继续重发`);
    assert.equal(room.redeals, round + 1);
  }
  // 有人加分后正常进入扣底
  const seat = room.bidding.turn;
  assert.ok(room.bid(`u${seat}`, 60).ok);
  for (let i = 0; i < 3; i++) {
    assert.ok(room.bid(`u${room.bidding.turn}`, 'pass').ok);
  }
  assert.equal(room.bidValue, 60);
  assert.equal(room.declarerSeat, seat);
  room.bury(`u${seat}`, 'H', buryIds(room, seat));
  assert.equal(room.state, 'playing');
  autoPlayOut(room);
  assert.equal(room.state, 'finished');
});

test('手牌排序：大王→小王→所有5→所有2→主花色→副牌按花色', () => {
  const cards = [c('HA'), c('SK'), c('D2'), c('BJ'), c('LJ'), c('C5'), c('S2'), c('S9'), c('DQ'), c('CK')];
  const got = sortHand(cards, 'S').map((x) => x.id);
  assert.deepEqual(got, ['BJ', 'LJ', 'C5', 'S2', 'D2', 'SK', 'S9', 'HA', 'CK', 'DQ']);
});

test('未定主花色也把常主提前：大王→小王→5→2→各花色分组', () => {
  const cards = [c('HA'), c('C5'), c('BJ'), c('D2'), c('LJ'), c('S9'), c('CQ')];
  const got = sortBySuit(cards).map((x) => x.id);
  assert.deepEqual(got, ['BJ', 'LJ', 'C5', 'D2', 'S9', 'HA', 'CQ']);
});

test('抓底牌后底牌对所有玩家公开', () => {
  const room = newRoom('grab', 3);
  room.startRound('u0');
  declareFirst(room);
  room._finalizeDeclaration();
  assert.equal(room.state, 'burying');
  assert.equal(room.bottomRevealed, true);
  assert.equal(room.bottomPickup.length, 6);
  for (const uid of ['u0', 'u1', 'u2']) {
    const v = room.viewFor(uid);
    assert.equal(v.bottomRevealed, true);
    assert.equal(v.bottom.length, 6, `${uid} 应能看到公开的底牌`);
  }
});

test('底牌不能扣分牌（5、10、K）', () => {
  const room = newRoom('grab', 4);
  room.startRound('u0');
  declareFirst(room);
  room._finalizeDeclaration();
  assert.equal(room.state, 'burying');
  const hand = room.seats[room.declarerSeat].hand;
  const point = hand.find((x) => cardPoints(x) > 0);
  assert.ok(point, '手里应有分牌');
  const plainIds = hand.filter((x) => cardPoints(x) === 0).slice(0, 5).map((x) => x.id);
  const bad = room.bury(`u${room.declarerSeat}`, 'H', [...plainIds, point.id]);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /不能扣分牌/);
  const good = room.bury(`u${room.declarerSeat}`, 'H', buryIds(room, room.declarerSeat));
  assert.ok(good.ok, good.error);
  assert.equal(room.state, 'playing');
});

test('队家模式：发牌前按顺序轮换庄家', () => {
  const room = newRoom('team', 4);
  room.startRound('u0');
  assert.equal(room.bankerTeam, 0);
  assert.equal(room.dealerSeat, 0, '第一局由一队座位 0 坐庄');
  assert.equal(room.declarerSeat, 0, '庄家在发牌时即确定');

  // 庄家队守庄成功 → 换成同队队友
  room.state = 'finished';
  room.result = { mode: 'team', declarerSeat: 0, winnerSide: 'declarer', sides: [] };
  room.startRound('u0');
  assert.equal(room.bankerTeam, 0);
  assert.equal(room.dealerSeat, 2, '守庄成功则庄家换成队友');

  // 常家上庄 → 庄家队换成常家，从原庄家下家开始取常家队员
  room.state = 'finished';
  room.result = { mode: 'team', declarerSeat: 2, winnerSide: 'defenders', sides: [] };
  room.startRound('u0');
  assert.equal(room.bankerTeam, 1);
  assert.equal(room.dealerSeat, 3, '常家上庄后由原庄家下家坐庄');

  // 常家连续上庄 → 继续在场内按座位顺序轮换
  room.state = 'finished';
  room.result = { mode: 'team', declarerSeat: 3, winnerSide: 'defenders', sides: [] };
  room.startRound('u0');
  assert.equal(room.bankerTeam, 0);
  assert.equal(room.dealerSeat, 0);
});

test('队家模式：庄家的搭档赢下最后一墩同样算庄家方拿底', () => {
  const room = newRoom('team', 4);
  room.startRound('u0');
  room.declarerSeat = 0;
  room.bankerTeam = 0;
  room.trumpSuit = 'S';
  room.bottom = [c('H10')]; // 底牌 10 分
  room.seats.forEach((s) => (s.captured = 0));
  room.seats[0].captured = 20;
  room.seats[2].captured = 20; // 庄家队 40 分
  room.seats[1].captured = 20;
  room.seats[3].captured = 10; // 常家队 30 分
  room._finishRound(2); // 2 号位是庄家的搭档
  const res = room.result;
  assert.equal(res.bottomDoubled, false, '搭档拿底不算抠底');
  assert.equal(res.declarerPoints, 50);
  assert.equal(res.defenderPoints, 30);
  assert.equal(res.winnerSide, 'declarer');
});

test('队家模式：常家赢下最后一墩则底牌翻倍', () => {
  const room = newRoom('team', 4);
  room.startRound('u0');
  room.declarerSeat = 0;
  room.bankerTeam = 0;
  room.trumpSuit = 'S';
  room.bottom = [c('H10')];
  room.seats.forEach((s) => (s.captured = 0));
  room.seats[0].captured = 20;
  room.seats[2].captured = 20;
  room.seats[1].captured = 20;
  room.seats[3].captured = 10;
  room._finishRound(1); // 1 号位是常家
  const res = room.result;
  assert.equal(res.bottomDoubled, true);
  assert.equal(res.declarerPoints, 40);
  assert.equal(res.defenderPoints, 50); // 30 + 10×2
});

test('队家模式：亮主只决定主花色，不改变庄家', () => {
  const room = newRoom('team', 4);
  room.startRound('u0');
  assert.equal(room.dealerSeat, 0);
  // 优先让非庄家的座位亮主
  const idx = [1, 2, 3].find((i) => room.seats[i].hand.some((x) => x.r === '2'));
  if (idx !== undefined) {
    const two = room.seats[idx].hand.find((x) => x.r === '2');
    assert.ok(room.declare(`u${idx}`, [two.id]).ok);
    assert.equal(room.trumpSuit, two.s);
    assert.equal(room.declarerSeat, 0, '亮主者不坐庄，庄家仍为 0 号位');
  } else {
    declareFirst(room);
  }
  room._finalizeDeclaration();
  assert.equal(room.state, 'burying');
  assert.equal(room.declarerSeat, 0);
});

test('队家模式：首轮无人亮主重发，再次无人亮主开底牌定主', () => {
  const room = newRoom('team', 4);
  room.startRound('u0');
  assert.equal(room.state, 'declaring');
  // 第一轮全员不亮 → 重发
  for (let i = 0; i < 4; i++) room.passDeclaration(`u${i}`);
  assert.equal(room.state, 'declaring', '首轮无人亮主应重发');
  assert.equal(room.redeals, 1);
  // 第二轮全员不亮 → 开底牌定主
  for (let i = 0; i < 4; i++) room.passDeclaration(`u${i}`);
  assert.equal(room.state, 'burying', '再次无人亮主应开底牌定主');
  assert.equal(room.declarerSeat, 0);
  assert.equal(room.bottomPickup.length, 6);
  assert.equal(room.bottomRevealed, true);
  const firstTwo = room.bottomPickup.find((x) => x.r === '2');
  if (firstTwo) {
    assert.equal(room.trumpSuit, firstTwo.s, '底牌有 2 时第一张 2 的花色定主');
  } else {
    const best = room.bottomPickup.reduce((a, b) => (power(a, null) >= power(b, null) ? a : b));
    assert.equal(room.trumpSuit, best.s, '无 2 时底牌最大一张的花色定主');
  }
  room.bury('u0', room.trumpSuit, buryIds(room, 0));
  assert.equal(room.state, 'playing');
  autoPlayOut(room);
  assert.equal(room.state, 'finished');
  assert.ok(room.result);
});

test('噶点叫分必须 5 的倍数且递增', () => {
  const room = newRoom('ga', 4);
  room.startRound('u0');
  const first = room.bidding.turn;
  assert.ok(!room.bid(`u${first}`, 57).ok);
  assert.ok(room.bid(`u${first}`, 60).ok);
  const next = room.bidding.turn;
  assert.ok(!room.bid(`u${next}`, 60).ok);
  assert.ok(room.bid(`u${next}`, 65).ok);
});

console.log('人机');
function newBotRoom(mode, n) {
  const room = new Room({ id: 'B1', name: 'bot', mode, maxSeats: n, hostId: 'u0' });
  room.addPlayer({ id: 'u0', username: 'p0', nickname: '玩家0' });
  while (!room.full) assert.ok(room.addBot('u0').ok);
  return room;
}

function runBotGame(room) {
  let now = Date.now();
  let guard = 0;
  while (room.state !== 'finished') {
    if (++guard > 6000) throw new Error('人机对局没有结束');
    now += 1000;
    room.tick(now);
  }
}

test('人机补位：房主可添加/移除，非房主不可', () => {
  const room = new Room({ id: 'B2', name: 'bot', mode: 'grab', maxSeats: 3, hostId: 'u0' });
  room.addPlayer({ id: 'u0', username: 'p0', nickname: '玩家0' });
  assert.ok(room.addBot('u0').ok);
  assert.ok(room.seats.filter((s) => s && s.isBot).length === 1);
  assert.ok(!room.addBot('u1').ok);
  assert.ok(room.removeBot('u0').ok);
  assert.equal(room.seats.filter((s) => s && s.isBot).length, 0);
  assert.ok(!room.removeBot('u0').ok);
});

for (const mode of ['grab', 'team', 'ga']) {
  test(`${mode} 模式：1 名真人 + 人机自动完成对局`, () => {
    const room = newBotRoom(mode, mode === 'grab' ? 3 : 4);
    const r = room.startRound('u0');
    assert.ok(r.ok, r.error);
    runBotGame(room);
    assert.equal(room.state, 'finished');
    const res = room.result;
    assert.ok(res);
    const expected = 100 + res.bottomPoints * (res.bottomDoubled ? 2 : 1);
    assert.equal(res.declarerPoints + res.defenderPoints, expected);
    assert.ok(room.seats.filter(Boolean).every((s) => s.hand.length === 0));
  });
}

test('房主离开时房主身份不会转给人机', () => {
  const room = new Room({ id: 'B3', name: 'bot', mode: 'grab', maxSeats: 4, hostId: 'u0' });
  for (const u of seatUsers(3)) room.addPlayer(u);
  addBotOk(room);
  room.leave('u0');
  assert.equal(room.hostId, 'u1');
  // 真人全部离开后清空座位，房间可被回收
  room.leave('u1');
  room.leave('u2');
  room.leave('u3');
  assert.ok(room.seats.every((s) => !s));
});

test('牌局中离开会退出房间并由系统托管', () => {
  const room = newRoom('grab', 3);
  assert.ok(room.startRound('u0').ok);
  declareFirst(room);
  room._finalizeDeclaration();
  room._autoBury();
  assert.equal(room.state, 'playing');
  assert.ok(room.leave('u1').ok);
  // 离开后不再是房间成员，应能回到大厅
  assert.equal(room.hasMember('u1'), false);
  // 座位仍在桌上，牌局继续且自动托管
  assert.ok(room.seats[1]);
  assert.ok(room.seats[1].detached);
  autoPlayOut(room);
  assert.equal(room.state, 'finished');
  // 中途离开的座位占位会在下一局开始时清理
  assert.equal(room.startRound('u0').ok, false);
  assert.equal(room.seats[1], null);
});

test('牌局中离开后可以重新回到原座位', () => {
  const room = newRoom('grab', 3);
  assert.ok(room.startRound('u0').ok);
  declareFirst(room);
  room._finalizeDeclaration();
  room._autoBury();
  room.leave('u1');
  assert.equal(room.hasMember('u1'), false);
  const res = room.addPlayer(seatUsers(3)[1]);
  assert.ok(res.ok, res.error);
  assert.equal(res.seat, 1);
  assert.equal(room.hasMember('u1'), true);
  assert.equal(room.seats[1].detached, false);
  assert.ok(room.seats[1].connected);
});

test('等待阶段可以换座或入座', () => {
  const room = newRoom('grab', 3);
  // u0 在 0 号位，换到 1 号位（与 u1 交换）
  assert.ok(room.takeSeat('u0', 1).ok);
  assert.equal(room.seatOf('u0'), 1);
  assert.equal(room.seatOf('u1'), 0);
  // 换到空位
  room.leave('u2');
  assert.ok(room.takeSeat('u0', 2).ok);
  assert.equal(room.seatOf('u0'), 2);
  assert.equal(room.seats[1], null);
  // 补满座位后开局，验证牌局中不能换座
  assert.ok(room.addBot('u0').ok);
  assert.ok(room.startRound('u0').ok);
  assert.equal(room.takeSeat('u0', 0).ok, false);
});

function addBotOk(room) {
  assert.ok(room.addBot('u0').ok);
}

console.log(`\n通过 ${passed} 项测试`);
if (process.exitCode) process.exit(process.exitCode);
