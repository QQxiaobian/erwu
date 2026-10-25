import assert from 'node:assert/strict';
import { Room } from '../src/room.js';

function playOut(room) {
  let guard = 0;
  while (room.state === 'playing') {
    if (++guard > 5000) throw new Error('对局没有结束');
    if (room.pendingResolveAt) {
      room._resolveTrick(Date.now());
      continue;
    }
    if (room.turn === null || room.turn === undefined) throw new Error('无出牌者');
    const res = room._autoPlay(room.turn);
    if (!res.ok) throw new Error(`自动出牌失败: ${res.error} | lead=${JSON.stringify(room.trick.lead)}`);
  }
}

const modes = [
  ['grab', 3],
  ['grab', 4],
  ['team', 4],
  ['ga', 4],
];

for (const [mode, n] of modes) {
  for (let round = 0; round < 120; round++) {
    const room = new Room({ id: 'T', name: 't', mode, maxSeats: n, hostId: 'u0' });
    for (let i = 0; i < n; i++) {
      room.addPlayer({ id: `u${i}`, username: `p${i}`, nickname: `p${i}` });
    }
    room.startRound('u0');

    if (mode === 'ga') {
      // 随机叫分/过牌，直到结束
      let guard = 0;
      while (room.state === 'bidding' && guard++ < 100) {
        const seat = room.bidding.turn;
        const options = [room.bidding.currentBid + 5, room.bidding.currentBid + 10, 'pass'];
        const pick = options[Math.floor(Math.random() * options.length)];
        const value =
          room.bidding.highestBidder === null && pick !== 'pass' && pick === room.bidding.currentBid + 5
            ? 55
            : pick;
        const r = room.bid(`u${seat}`, value);
        if (!r.ok) room.bid(`u${seat}`, 'pass');
      }
      assert.equal(room.state, 'burying');
      room._autoBury();
    } else {
      // 随机亮主/反主，或不亮
      let declared = false;
      for (let i = 0; i < n; i++) {
        const hand = room.seats[i].hand;
        const twos = hand.filter((x) => x.r === '2');
        if (twos.length && Math.random() < 0.7) {
          room.declare(`u${i}`, [twos[0].id]);
          declared = true;
          break;
        }
      }
      if (declared) {
        // 可能反主
        for (let i = 0; i < n; i++) {
          const hand = room.seats[i].hand;
          for (const s of ['S', 'H', 'C', 'D']) {
            if (s === room.trumpSuit) continue;
            const two = hand.find((x) => x.s === s && x.r === '2');
            const five = hand.find((x) => x.s === s && x.r === '5');
            if (two && five && Math.random() < 0.3) {
              const r = room.declare(`u${i}`, [two.id, five.id]);
              assert.ok(r.ok, r.error);
            }
          }
        }
      }
      room._finalizeDeclaration();
      if (room.state === 'declaring') {
        // 触发换牌后可能重发，再试一次
        let guard = 0;
        while (room.state === 'declaring' && guard++ < 5) {
          room._finalizeDeclaration();
        }
      }
      if (room.state !== 'burying') {
        // 连续无人亮主后的兜底重发
        let guard = 0;
        while (room.state === 'declaring' && guard++ < 5) room._finalizeDeclaration();
      }
      assert.equal(room.state, 'burying');
      room._autoBury();
    }

    assert.equal(room.state, 'playing');
    playOut(room);
    assert.equal(room.state, 'finished');
    const res = room.result;
    const expected = 100 + res.bottomPoints * (res.bottomDoubled ? 2 : 1);
    assert.equal(res.declarerPoints + res.defenderPoints, expected);
  }
  console.log(`  ✓ ${mode} ${n} 人 x120 局自动对局`);
}
console.log('压力测试通过');
