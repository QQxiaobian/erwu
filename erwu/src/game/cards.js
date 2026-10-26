// 《二五》牌型与牌力核心规则。所有规则以用户提供的自定义规则为准。
export const SUITS = ['S', 'H', 'C', 'D'];
export const SUIT_NAMES = { S: '黑桃', H: '红桃', C: '梅花', D: '方块' };
export const SUIT_SYMBOLS = { S: '♠', H: '♥', C: '♣', D: '♦' };

// 普通牌面从小到大（5/2/王 单独定义为主牌）
export const RANKS = ['3', '4', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

export function makeDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) deck.push({ id: s + r, s, r });
    deck.push({ id: s + '5', s, r: '5' });
    deck.push({ id: s + '2', s, r: '2' });
  }
  deck.push({ id: 'BJ', s: 'J', r: 'BJ' });
  deck.push({ id: 'LJ', s: 'J', r: 'SJ' });
  return deck;
}

export function shuffle(deck, rng = Math.random) {
  const arr = deck.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function rankIndex(r) {
  return RANKS.indexOf(r);
}

export function cardPoints(card) {
  if (!card) return 0;
  if (card.r === '5') return 5;
  if (card.r === '10' || card.r === 'K') return 10;
  return 0;
}

export function handPoints(cards) {
  return cards.reduce((sum, c) => sum + cardPoints(c), 0);
}

// 常主判断：所有 5、所有 2、大小王 + 本局主花色普通牌
export function isTrump(card, trumpSuit) {
  if (!card || !trumpSuit) return false;
  if (card.s === 'J') return true;
  if (card.r === '5' || card.r === '2') return true;
  return card.s === trumpSuit;
}

// 单张牌力。5 > 大王 > 小王 > 2 > 本局花色普通主牌 > 副牌
// 本局主花色的 5、2 分别大于其他花色的 5、2
export function power(card, trumpSuit) {
  if (card.r === '5') return card.s === trumpSuit ? 1010 : 1000;
  if (card.r === 'BJ') return 950;
  if (card.r === 'SJ') return 940;
  if (card.r === '2') return card.s === trumpSuit ? 910 : 900;
  if (card.s === trumpSuit) return 500 + rankIndex(card.r);
  return 100 + rankIndex(card.r);
}

export function isJoker(card) {
  return card.s === 'J';
}

export function isCombo25(cards, trumpSuit) {
  if (!cards || cards.length !== 2) return false;
  const [a, b] = cards;
  if (a.s !== b.s) return false;
  const ranks = [a.r, b.r].sort();
  return ranks[0] === '2' && ranks[1] === '5';
}

export function isJokerPair(cards) {
  if (!cards || cards.length !== 2) return false;
  return cards.some((c) => c.r === 'BJ') && cards.some((c) => c.r === 'SJ');
}

// 首发牌型：single | combo25 | joker | throw，非法返回 null
export function detectLead(cards, trumpSuit) {
  if (!cards || cards.length === 0) return null;
  if (cards.length === 1) return 'single';
  if (isJokerPair(cards)) return 'joker';
  if (isCombo25(cards)) return 'combo25';
  const allSameSuit = cards.every((c) => c.s === cards[0].s);
  const anyTrump = cards.some((c) => isTrump(c, trumpSuit));
  if (cards.length >= 2 && allSameSuit && !anyTrump) return 'throw';
  return null;
}

// 副牌甩牌合法性：甩出的每一张都必须是全场该花色最大牌（含底牌、自己的剩余手牌）
export function checkThrow(cards, allHands, bottom, trumpSuit) {
  const thrown = new Set(cards.map((c) => c.id));
  const suit = cards[0].s;
  const minIdx = Math.min(...cards.map((c) => rankIndex(c.r)));
  let outsideMax = -1;
  for (const hand of allHands) {
    for (const c of hand) {
      if (thrown.has(c.id)) continue;
      if (c.s === suit && !isTrump(c, trumpSuit)) {
        outsideMax = Math.max(outsideMax, rankIndex(c.r));
      }
    }
  }
  for (const c of bottom || []) {
    if (thrown.has(c.id)) continue;
    if (c.s === suit && !isTrump(c, trumpSuit)) {
      outsideMax = Math.max(outsideMax, rankIndex(c.r));
    }
  }
  if (outsideMax >= minIdx) {
    // 违规：强制只打出甩牌里最小的一张
    let forced = cards[0];
    for (const c of cards) if (rankIndex(c.r) < rankIndex(forced.r)) forced = c;
    return { ok: false, forced };
  }
  return { ok: true };
}

/**
 * 跟牌合法性校验。
 * lead: { seat, cards, type }
 * played: 本次出的牌
 */
export function validateFollow(hand, played, lead, trumpSuit) {
  const err = (msg) => ({ ok: false, reason: msg });
  if (!lead) return err('当前没有首出牌型');
  const type = lead.type;
  const trumps = hand.filter((c) => isTrump(c, trumpSuit));

  if (type === 'single') {
    if (played.length !== 1) return err('单张首出，必须跟 1 张牌');
    const leadCard = lead.cards[0];
    if (isTrump(leadCard, trumpSuit)) {
      if (trumps.length > 0 && !isTrump(played[0], trumpSuit)) {
        return err('首出主牌，手里有主牌必须跟主牌');
      }
    } else {
      const same = hand.filter((c) => !isTrump(c, trumpSuit) && c.s === leadCard.s);
      if (same.length > 0 && !same.some((c) => c.id === played[0].id)) {
        return err(`首出${SUIT_NAMES[leadCard.s]}，必须跟同花色`);
      }
    }
    return { ok: true };
  }

  if (type === 'joker') {
    if (played.length !== 2) return err('金鸡首出，每人必须跟 2 张牌');
    if (trumps.length >= 2) {
      const need = trumps.map((c) => power(c, trumpSuit)).sort((a, b) => b - a);
      const got = played.map((c) => power(c, trumpSuit)).sort((a, b) => b - a);
      if (!played.every((c) => isTrump(c, trumpSuit)) || got[1] < need[1]) {
        return err('金鸡强制跟牌：必须打出自己手里最大的两张主牌');
      }
      return { ok: true };
    }
    if (trumps.length === 1) {
      if (!played.some((c) => isTrump(c, trumpSuit))) {
        return err('金鸡强制跟牌：必须带出仅有的一张主牌');
      }
      return { ok: true };
    }
    return { ok: true };
  }

  if (type === 'combo25') {
    if (played.length !== 2) return err('25 组合首出，每人必须跟 2 张牌');
    const combo = lead.cards;
    const cs = combo[0].s;
    const sameSuitTrumps = hand.filter((c) => isTrump(c, trumpSuit) && c.s === cs);
    if (sameSuitTrumps.length >= 2) {
      const ok = played.every((c) => isTrump(c, trumpSuit) && c.s === cs);
      if (!ok) return err(`必须跟 2 张${SUIT_NAMES[cs]}主牌`);
      return { ok: true };
    }
    if (trumps.length >= 2) {
      if (!played.every((c) => isTrump(c, trumpSuit))) {
        return err('手里有 2 张以上主牌，必须跟 2 张主牌');
      }
      return { ok: true };
    }
    if (trumps.length === 1) {
      if (!played.some((c) => isTrump(c, trumpSuit))) {
        return err('手里有 1 张主牌，必须带出这张主牌');
      }
      return { ok: true };
    }
    return { ok: true };
  }

  if (type === 'throw') {
    const N = lead.cards.length;
    if (played.length !== N) return err(`甩牌 ${N} 张，必须跟 ${N} 张牌`);
    const suit = lead.cards[0].s;
    const same = hand.filter((c) => !isTrump(c, trumpSuit) && c.s === suit);
    const playedSame = played.filter((c) => !isTrump(c, trumpSuit) && c.s === suit);
    if (same.length >= N) {
      if (playedSame.length !== N) return err(`必须跟 ${N} 张同花色副牌`);
      return { ok: true };
    }
    if (trumps.length >= N && played.every((c) => isTrump(c, trumpSuit))) {
      return { ok: true };
    }
    if (playedSame.length !== same.length) {
      return err('必须跟出手上全部该花色副牌，再垫其他牌');
    }
    return { ok: true };
  }

  return err('未知首出牌型');
}

/**
 * 判定一墩归属。
 * plays: [{ seat, cards }]，按出牌顺序，首出在第一位。
 * 返回获胜座位号。
 */
export function resolveTrick(lead, plays, trumpSuit) {
  if (!lead || !plays.length) return null;
  const type = lead.type;

  if (type === 'joker') return lead.seat;

  if (type === 'single') {
    const leadCard = lead.cards[0];
    if (isTrump(leadCard, trumpSuit)) {
      let best = plays[0];
      let bestPower = power(leadCard, trumpSuit);
      for (let i = 1; i < plays.length; i++) {
        const c = plays[i].cards[0];
        if (!isTrump(c, trumpSuit)) continue;
        const p = power(c, trumpSuit);
        if (p > bestPower) {
          bestPower = p;
          best = plays[i];
        }
      }
      return best.seat;
    }
    const killers = plays.filter((p) => p.cards.length === 1 && isTrump(p.cards[0], trumpSuit));
    if (killers.length) {
      let best = killers[0];
      let bestPower = power(best.cards[0], trumpSuit);
      for (const p of killers.slice(1)) {
        const pw = power(p.cards[0], trumpSuit);
        if (pw > bestPower) {
          bestPower = pw;
          best = p;
        }
      }
      return best.seat;
    }
    let best = plays[0];
    let bestPower = -1;
    for (const p of plays) {
      const c = p.cards[0];
      if (isTrump(c, trumpSuit) || c.s !== leadCard.s) continue;
      const pw = power(c, trumpSuit);
      if (pw > bestPower) {
        bestPower = pw;
        best = p;
      }
    }
    return best.seat;
  }

  if (type === 'combo25') {
    const joker = plays.find((p) => p.cards.length === 2 && isJokerPair(p.cards));
    if (joker) return joker.seat;
    const combos = plays.filter((p) => p.cards.length === 2 && isCombo25(p.cards, trumpSuit));
    if (combos.length) {
      let best = combos[0];
      let bestPw = Math.max(...best.cards.map((c) => power(c, trumpSuit)));
      for (const p of combos.slice(1)) {
        const pw = Math.max(...p.cards.map((c) => power(c, trumpSuit)));
        if (pw > bestPw) {
          bestPw = pw;
          best = p;
        }
      }
      return best.seat;
    }
    let best = null;
    let bestPower = -1;
    for (const p of plays) {
      const tr = p.cards.filter((c) => isTrump(c, trumpSuit));
      if (!tr.length) continue;
      const pw = Math.max(...tr.map((c) => power(c, trumpSuit)));
      if (pw > bestPower) {
        bestPower = pw;
        best = p;
      }
    }
    return best ? best.seat : lead.seat;
  }

  if (type === 'throw') {
    const N = lead.cards.length;
    const killers = plays.filter((p) => p.cards.length === N && p.cards.every((c) => isTrump(c, trumpSuit)));
    if (killers.length) {
      let best = killers[0];
      let bestPower = Math.max(...best.cards.map((c) => power(c, trumpSuit)));
      for (const p of killers.slice(1)) {
        const pw = Math.max(...p.cards.map((c) => power(c, trumpSuit)));
        if (pw > bestPower) {
          bestPower = pw;
          best = p;
        }
      }
      return best.seat;
    }
    const suit = lead.cards[0].s;
    let best = plays[0];
    let bestPower = -1;
    for (const p of plays) {
      const same = p.cards.filter((c) => !isTrump(c, trumpSuit) && c.s === suit);
      if (!same.length) continue;
      const pw = Math.max(...same.map((c) => power(c, trumpSuit)));
      if (pw > bestPower) {
        bestPower = pw;
        best = p;
      }
    }
    return best.seat;
  }

  return lead.seat;
}

// 常主判定（不依赖主花色）：5、2、大小王
export function isPermanentTrump(card) {
  if (!card) return false;
  return card.s === 'J' || card.r === '5' || card.r === '2';
}

export function sortHand(cards, trumpSuit) {
  return cards.slice().sort((a, b) => {
    // 分组：0=常主(5/2/王) 永远最左；1=主花色普通牌；2=副牌
    const group = (c) => (isPermanentTrump(c) ? 0 : c.s === trumpSuit ? 1 : 2);
    const ag = group(a);
    const bg = group(b);
    if (ag !== bg) return ag - bg;
    const ap = power(a, trumpSuit);
    const bp = power(b, trumpSuit);
    if (ap !== bp) return bp - ap;
    return a.s.localeCompare(b.s);
  });
}

export function cardName(card) {
  if (card.r === 'BJ') return '大王';
  if (card.r === 'SJ') return '小王';
  return SUIT_SYMBOLS[card.s] + (card.r === '10' ? '10' : card.r);
}

export function cardsName(cards) {
  return cards.map(cardName).join(' ');
}

// 自动托管选牌（不主动甩牌、不主动亮主）
export function autoSelect(hand, lead, trumpSuit) {
  const byId = new Map(hand.map((c) => [c.id, c]));
  const trumps = hand.filter((c) => isTrump(c, trumpSuit)).sort((a, b) => power(a, trumpSuit) - power(b, trumpSuit));
  const nonTrumps = hand.filter((c) => !isTrump(c, trumpSuit));

  if (!lead) {
    // 首出：打最小单张（避免主动甩牌/金鸡/25）
    let pick = nonTrumps.slice().sort((a, b) => power(a, trumpSuit) - power(b, trumpSuit))[0];
    if (!pick) pick = trumps[0];
    return pick ? [pick] : [];
  }

  if (lead.type === 'joker') {
    // 金鸡强制跟 2 张：有 2 张以上主牌出最大的两张，只有 1 张主牌则带出这张主牌
    if (trumps.length >= 2) return trumps.slice(-2);
    if (trumps.length === 1) return [trumps[0], nonTrumps[0] || hand[0]];
    return nonTrumps.length >= 2 ? nonTrumps.slice(0, 2) : hand.slice(0, 2);
  }

  if (lead.type === 'single') {
    const leadCard = lead.cards[0];
    if (isTrump(leadCard, trumpSuit)) {
      if (trumps.length) return [trumps[0]];
      return [nonTrumps[0] || hand[0]];
    }
    const same = nonTrumps.filter((c) => c.s === leadCard.s).sort((a, b) => power(a, trumpSuit) - power(b, trumpSuit));
    if (same.length) return [same[0]];
    return [nonTrumps[0] || trumps[0] || hand[0]];
  }

  if (lead.type === 'combo25') {
    const cs = lead.cards[0].s;
    const sameSuitTrumps = hand
      .filter((c) => isTrump(c, trumpSuit) && c.s === cs)
      .sort((a, b) => power(a, trumpSuit) - power(b, trumpSuit));
    if (sameSuitTrumps.length >= 2) return sameSuitTrumps.slice(0, 2);
    if (trumps.length >= 2) return trumps.slice(0, 2);
    if (trumps.length === 1) return [trumps[0], nonTrumps[0]];
    return nonTrumps.slice(0, 2);
  }

  if (lead.type === 'throw') {
    const N = lead.cards.length;
    const suit = lead.cards[0].s;
    const same = nonTrumps.filter((c) => c.s === suit).sort((a, b) => power(a, trumpSuit) - power(b, trumpSuit));
    const out = [];
    if (same.length >= N) return same.slice(0, N);
    out.push(...same);
    const rest = nonTrumps.filter((c) => c.s !== suit).sort((a, b) => power(a, trumpSuit) - power(b, trumpSuit));
    for (const c of rest) {
      if (out.length >= N) break;
      out.push(c);
    }
    for (const c of trumps) {
      if (out.length >= N) break;
      out.push(c);
    }
    return out.slice(0, N);
  }

  return [hand[0]];
}
