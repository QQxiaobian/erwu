// 《二五》人机 AI。
//
// 设计思路：
//   1) 跟牌：枚举所有合法候选（validateFollow 过滤），对每一手做「本墩模拟」，
//      算出这一手会由谁赢墩、本墩有多少分，再结合出牌代价打分，取最高分。
//      这样自然产生了「抢分 / 垫分给队友 / 不为 0 分墩浪费主牌」等行为。
//   2) 首出：优先金鸡（必胜且强制对手交两张最大主牌）、25 组合、安全甩牌、
//      清主、以及「确认是最小剩余最大牌」的安全单张。
//   3) 甩牌安全性用公开信息推断：只要该花色所有比甩牌最小牌更大的牌都在自己手上
//      或已经打出，就判定安全，绝不依赖别人的手牌（不会「开天眼」被降级）。
//   4) 队友识别：队家模式按座位奇偶分队，其他模式按庄家 / 常家分边。
import {
  SUITS,
  RANKS,
  rankIndex,
  power,
  isTrump,
  cardPoints,
  resolveTrick,
  validateFollow,
  makeDeck,
} from './cards.js';

// 全牌堆缓存（仅用于统计「还有哪些牌没露面」）
const DECK = makeDeck();

// 单张牌的「出牌代价」：越强的牌越珍贵，量级与分数（0~20）可比
const NORMAL_COST = { A: 3.0, K: 2.6, Q: 2.0, J: 1.6, '10': 1.3, 9: 1.0, 8: 0.8, 7: 0.6, 6: 0.45, 4: 0.3, 3: 0.2 };

export function cardCost(card, trumpSuit) {
  if (card.r === 'BJ') return 6.5;
  if (card.r === 'SJ') return 6.0;
  if (card.r === '5') return card.s === trumpSuit ? 8.5 : 7.5;
  if (card.r === '2') return card.s === trumpSuit ? 5.5 : 4.8;
  const base = NORMAL_COST[card.r] ?? 0.5;
  return card.s === trumpSuit ? base * 1.25 : base;
}

/** 阵营：队家按座位奇偶；其余模式按庄家 / 常家 */
function sideKey(seat, ctx) {
  if (ctx.mode === 'team') return `t${seat % 2}`;
  const d = ctx.declarerSeat;
  if (d === null || d === undefined) return 'def';
  return seat === d ? 'decl' : 'def';
}

/** 已打出的牌 id 集合（含本墩已出的牌） */
function playedIdSet(ctx) {
  const ids = new Set(ctx.played || []);
  for (const p of ctx.plays || []) for (const c of p.cards) ids.add(c.id);
  return ids;
}

/** 该花色当前还剩多少张没露面（不在自己手里、也没打出） */
function unseenSuitRanks(suit, handIds, playedIds) {
  const ranks = [];
  for (const r of RANKS) {
    const id = suit + r;
    if (handIds.has(id) || playedIds.has(id)) continue;
    ranks.push(r);
  }
  return ranks;
}

/** 这张副牌是不是该花色「剩余最大」——比它大的牌要么在自己手里，要么已经打出 */
function isSuitTopHonest(card, handIds, playedIds) {
  const ri = rankIndex(card.r);
  for (const r of RANKS) {
    if (rankIndex(r) <= ri) continue;
    const id = card.s + r;
    if (handIds.has(id)) continue; // 自己拿着，不构成威胁
    if (playedIds.has(id)) continue; // 已经打出，不再构成威胁
    return false;
  }
  return true;
}

/**
 * 甩牌安全性：甩出的牌必须是该花色剩余的最大牌组。
 * 只要「比甩牌最小一张更大的牌」还有任何一张可能在别人手里或底牌里，就不安全。
 */
function throwSafe(prefix, suit, handIds, playedIds) {
  const minIdx = Math.min(...prefix.map((c) => rankIndex(c.r)));
  const inPrefix = new Set(prefix.map((c) => c.id));
  for (const r of RANKS) {
    if (rankIndex(r) < minIdx) continue;
    const id = suit + r;
    if (inPrefix.has(id)) continue;
    if (playedIds.has(id)) continue; // 已打出，不构成威胁
    // 自己手里没甩掉的同花色牌也算「外面的牌」，checkThrow 会一并比较
    return false;
  }
  return true;
}

/** 还有多少张比自己这组牌更大的主牌没露面（用于评估 25 领出风险） */
function countUnseenTrumpsAbove(minPower, handIds, playedIds, trumpSuit) {
  let n = 0;
  for (const card of DECK) {
    if (!isTrump(card, trumpSuit)) continue;
    if (handIds.has(card.id) || playedIds.has(card.id)) continue;
    if (power(card, trumpSuit) > minPower) n += 1;
  }
  return n;
}

// ────────────────────────── 候选枚举 ──────────────────────────

function powerAsc(arr, trumpSuit) {
  return arr.slice().sort((a, b) => power(a, trumpSuit) - power(b, trumpSuit));
}

/** 尽量把分牌垫出去（队友赢墩时用） */
function dumpPoints(arr, k, trumpSuit) {
  return arr
    .slice()
    .sort((a, b) => cardPoints(b) - cardPoints(a) || power(a, trumpSuit) - power(b, trumpSuit))
    .slice(0, k);
}

function allPairs(arr, trumpSuit) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) out.push([arr[i], arr[j]]);
  }
  // 牌多时只保留「最便宜的若干组合 + 最贵的若干组合」，避免组合爆炸
  if (out.length <= 60) return out;
  const sorted = out.slice().sort((a, b) => {
    const ca = cardCost(a[0], trumpSuit) + cardCost(a[1], trumpSuit);
    const cb = cardCost(b[0], trumpSuit) + cardCost(b[1], trumpSuit);
    return ca - cb;
  });
  return sorted.slice(0, 24).concat(sorted.slice(-12));
}

function enumerateFollow(hand, lead, trumpSuit, ctx) {
  const trumps = hand.filter((c) => isTrump(c, trumpSuit));
  const out = [];
  const type = lead.type;

  if (type === 'joker') {
    // 金鸡强制跟牌：有 2 张以上主牌必须打最大两张，没有选择余地
    if (trumps.length >= 2) {
      out.push(powerAsc(trumps, trumpSuit).slice(-2));
    } else if (trumps.length === 1) {
      const t = trumps[0];
      for (const c of hand) if (c.id !== t.id) out.push([t, c]);
    } else {
      out.push(...allPairs(hand, trumpSuit));
    }
  } else if (type === 'single') {
    const leadCard = lead.cards[0];
    let pool;
    if (isTrump(leadCard, trumpSuit)) {
      pool = trumps.length ? trumps : hand;
    } else {
      const same = hand.filter((c) => !isTrump(c, trumpSuit) && c.s === leadCard.s);
      pool = same.length ? same : hand;
    }
    for (const c of pool) out.push([c]);
  } else if (type === 'combo25') {
    const cs = lead.cards[0].s;
    const same = hand.filter((c) => c.s === cs);
    if (same.length >= 2) {
      // 跟主 25：有 2 张以上主花色牌时必须跟同花色
      out.push(...allPairs(same, trumpSuit));
    } else if (same.length === 1) {
      // 只有 1 张：必须带出这张，另一张自由选择
      for (const c of hand) if (c.id !== same[0].id) out.push([same[0], c]);
    } else {
      out.push(...allPairs(hand, trumpSuit));
    }
  } else if (type === 'throw') {
    const N = lead.cards.length;
    const suit = lead.cards[0].s;
    const same = hand.filter((c) => !isTrump(c, trumpSuit) && c.s === suit);
    if (same.length >= N) {
      // 该花色的甩牌已经是全场最大，跟同花色必输，尽量便宜或送分给队友
      out.push(powerAsc(same, trumpSuit).slice(0, N));
      out.push(dumpPoints(same, N, trumpSuit));
    } else {
      const need = N - same.length;
      const sameIds = new Set(same.map((c) => c.id));
      const rest = hand.filter((c) => !sameIds.has(c.id));
      const restTrumps = rest.filter((c) => isTrump(c, trumpSuit));
      if (same.length === 0 && restTrumps.length >= N) {
        // 可以全主杀牌
        const asc = powerAsc(restTrumps, trumpSuit);
        out.push(asc.slice(0, N));
        out.push(asc.slice(-N));
      }
      // 必须先出完手上的同花色副牌，再补牌（不能毙牌）
      out.push([...same, ...powerAsc(rest, trumpSuit).slice(0, need)]);
      out.push([...same, ...dumpPoints(rest, need, trumpSuit)]);
    }
  }

  // 去重 + 合法性过滤
  const seen = new Set();
  const valid = [];
  for (const cand of out) {
    if (!cand || !cand.length) continue;
    const key = cand
      .map((c) => c.id)
      .sort()
      .join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    if (validateFollow(hand, cand, lead, trumpSuit).ok) valid.push(cand);
  }
  return valid;
}

// ────────────────────────── 跟牌评分 ──────────────────────────

function evaluateFollow(cand, hand, lead, trumpSuit, ctx) {
  const mySeat = ctx.seat;
  const plays = ctx.plays || [];
  const maxSeats = ctx.maxSeats || 4;
  const remaining = Math.max(0, maxSeats - plays.length - 1);
  const playsAfter = plays.concat([{ seat: mySeat, cards: cand }]);

  // 本墩会由谁赢（只按已出牌 + 自己这手推演，后续玩家视为不确定）
  let winner = lead.type === 'joker' ? lead.seat : resolveTrick(lead, playsAfter, trumpSuit);
  if (winner === null || winner === undefined) winner = lead.seat;

  let total = 0;
  for (const p of playsAfter) for (const c of p.cards) total += cardPoints(c);
  let mine = 0;
  for (const c of cand) mine += cardPoints(c);
  const oppPts = total - mine;

  const mySide = sideKey(mySeat, ctx);
  const winSide = sideKey(winner, ctx);
  const mySideWins = winSide === mySide;
  const sure = remaining === 0 || lead.type === 'joker';
  // 不是最后一个出牌时，赢墩是不确定的，收益打折扣
  const conf = sure ? 1 : 0.62;

  let score = 0;
  if (mySideWins) {
    score += (oppPts + mine * 0.35) * conf;
    if (winner === mySeat) score += 0.9 * conf; // 赢墩能拿到下一墩的先手
  } else {
    score -= (oppPts + mine) * conf;
  }

  // 出牌代价
  for (const c of cand) score -= cardCost(c, trumpSuit);

  // 垫牌时照顾手牌结构：优先垫掉孤立短门，尽量不拆长门
  if (cand.length === 1 && lead.type !== 'joker') {
    const card = cand[0];
    if (!isTrump(card, trumpSuit)) {
      const len = hand.filter((c) => !isTrump(c, trumpSuit) && c.s === card.s).length;
      if (len <= 2) score += 0.25;
      else if (len >= 5) score -= 0.35;
    }
  }
  return score;
}

function chooseFollow(hand, lead, trumpSuit, ctx) {
  const cands = enumerateFollow(hand, lead, trumpSuit, ctx);
  if (!cands.length) return [hand[0]];
  let best = cands[0];
  let bestScore = -Infinity;
  for (const cand of cands) {
    const s = evaluateFollow(cand, hand, lead, trumpSuit, ctx);
    if (s > bestScore) {
      bestScore = s;
      best = cand;
    }
  }
  return best;
}

// ────────────────────────── 首出 ──────────────────────────

function singleLeadScore(card, hand, trumpSuit, handIds, playedIds, trumpCount) {
  const isT = isTrump(card, trumpSuit);
  const p = power(card, trumpSuit);
  const cost = cardCost(card, trumpSuit);
  const ri = rankIndex(card.r);

  if (isT) {
    if (p >= 1000) {
      // 5：全场最大，单张领出太浪费（留着毙分）
      return 2.4;
    }
    if (p >= 900) {
      // 王 / 2：同样是控制牌，不轻易单张领出
      return 3.4;
    }
    // 主花色普通牌
    if (trumpCount >= 4) {
      // 主牌够多，领最小主牌清主，逼对手交主
      return 7.2 - ri * 0.22;
    }
    return 2.2 + ri * 0.18;
  }

  const top = isSuitTopHonest(card, handIds, playedIds);
  if (top) {
    const len = hand.filter((c) => !isTrump(c, trumpSuit) && c.s === card.s).length;
    // 领出该花色最大牌：稳拿先手，长门还能逼对手垫分
    return 10 - cost * 0.25 + (len >= 4 ? 1.2 : 0);
  }
  // 领中低副牌容易送分，压低评分
  return 1.5 + ri * 0.2 - cost * 0.25;
}

function chooseLead(hand, trumpSuit, ctx) {
  const handIds = new Set(hand.map((c) => c.id));
  const playedIds = playedIdSet(ctx);
  const trumps = hand.filter((c) => isTrump(c, trumpSuit));
  const trumpCount = trumps.length;
  const cands = [];

  // 1) 金鸡：领出必胜，且强制每位对手交出两张最大主牌
  const bj = hand.find((c) => c.r === 'BJ');
  const lj = hand.find((c) => c.r === 'SJ');
  if (bj && lj) {
    let score = 42;
    // 队家模式会连带队友一起交主，略微降低优先级
    if (ctx.mode === 'team') score -= 2;
    cands.push({ cards: [bj, lj], type: 'joker', score });
  }

  // 2) 主花色 25 组合：领出基本稳赢，同时消耗对手两张主牌
  // 只有主花色的 2+5 算 25；其他花色的 2+5 都是常主，不能当 25 领出
  if (trumpSuit) {
    const two = hand.find((c) => c.s === trumpSuit && c.r === '2');
    const five = hand.find((c) => c.s === trumpSuit && c.r === '5');
    if (two && five) {
      const myMax = Math.max(power(two, trumpSuit), power(five, trumpSuit));
      const beaters = countUnseenTrumpsAbove(myMax, handIds, playedIds, trumpSuit);
      let score = 26;
      if (beaters > 0) score -= Math.min(9, beaters * 2.5);
      cands.push({ cards: [two, five], type: 'combo25', score });
    }
  }

  // 3) 副牌甩牌：取该花色能安全甩出的最长前缀
  for (const s of SUITS) {
    if (s === trumpSuit) continue;
    const mine = hand
      .filter((c) => !isTrump(c, trumpSuit) && c.s === s)
      .sort((a, b) => rankIndex(b.r) - rankIndex(a.r));
    for (let n = mine.length; n >= 2; n--) {
      const prefix = mine.slice(0, n);
      if (throwSafe(prefix, s, handIds, playedIds)) {
        cands.push({ cards: prefix, type: 'throw', score: 5 + 4 * n + (n >= 3 ? 2 : 0) });
        break;
      }
    }
  }

  // 4) 单张
  for (const card of hand) {
    cands.push({
      cards: [card],
      type: 'single',
      score: singleLeadScore(card, hand, trumpSuit, handIds, playedIds, trumpCount),
    });
  }

  cands.sort((a, b) => b.score - a.score);
  return cands[0].cards;
}

// ────────────────────────── 对外接口 ──────────────────────────

/**
 * 选择要打出的牌。
 * ctx 可提供：seat / maxSeats / mode / declarerSeat / plays / played
 */
export function choosePlay(hand, lead, trumpSuit, ctx = {}) {
  if (!hand || !hand.length) return [];
  const c = { seat: 0, maxSeats: 4, mode: 'grab', declarerSeat: null, plays: [], played: [], ...ctx };
  return lead ? chooseFollow(hand, lead, trumpSuit, c) : chooseLead(hand, trumpSuit, c);
}

/** 某花色对这副手牌的价值（亮主 / 叫分 / 噶点自选主花色共用） */
export function suitStrength(hand, suit) {
  let v = 0;
  for (const c of hand) {
    if (c.r === '5' || c.r === '2' || c.s === 'J') {
      v += 1.2;
      continue;
    }
    if (c.s === suit) v += 1.0 + (rankIndex(c.r) / 10) * 1.5;
    else if (c.r === 'A') v += 0.7;
    else if (c.r === 'K') v += 0.35;
  }
  return v;
}

/** 手牌最适合做主的副花色（不含 J） */
export function bestSuitFor(hand) {
  let best = SUITS[0];
  let bestScore = -Infinity;
  for (const s of SUITS) {
    const v = suitStrength(hand, s);
    if (v > bestScore) {
      bestScore = v;
      best = s;
    }
  }
  return best;
}

/**
 * 亮主 / 反主决策。
 * 返回 null 表示过牌，返回 { cards: [id...] } 表示要亮的牌。
 */
export function chooseDeclaration(hand, trumpSuit, opts = {}) {
  const redeals = opts.redeals || 0;
  const scored = SUITS.map((s) => ({ suit: s, score: suitStrength(hand, s) })).sort((a, b) => b.score - a.score);

  if (!trumpSuit) {
    // 首次亮主：只能用在手里有 2 的花色，挑其中最强的一门
    const available = scored.filter((x) => hand.some((c) => c.s === x.suit && c.r === '2'));
    if (!available.length) return null;
    const best = available[0];
    // 坐庄要独自对抗 2~3 家常，常家 45 分即上庄，因此只有明显强的手牌才值得亮主；
    // 连续重发时适当放宽，避免一直无人坐庄。
    // 队家模式庄家早已固定，亮主只决定主花色，随便哪门有 2 都该尽快定下来。
    const base = opts.mode === 'team' ? 5 : 9.5;
    const threshold = base - Math.min(2, redeals) * 1;
    if (best.score < threshold) return null;
    const two = hand.find((c) => c.s === best.suit && c.r === '2');
    return { cards: [two.id] };
  }

  // 已有主花色：只有换上「明显更强」的花色才反主（需要同花色 25）
  const best = scored.find((x) => x.suit !== trumpSuit);
  if (!best) return null;
  const two = hand.find((c) => c.s === best.suit && c.r === '2');
  const five = hand.find((c) => c.s === best.suit && c.r === '5');
  if (!two || !five) return null;
  const cur = scored.find((x) => x.suit === trumpSuit);
  if (cur && best.score < cur.score + 4.5) return null;
  return { cards: [two.id, five.id] };
}

/** 扣底：优先整门清空最短的副牌花色（形成断门），绝不扣分牌 */
export function chooseBury(hand, trumpSuit) {
  const plain = hand.filter((c) => cardPoints(c) === 0);
  const pool = plain.length >= 6 ? plain : hand.slice();

  // 按副牌花色分组，短门优先整门扣掉
  const groups = [];
  for (const s of SUITS) {
    if (s === trumpSuit) continue;
    const cards = pool.filter((c) => !isTrump(c, trumpSuit) && c.s === s);
    if (cards.length) groups.push({ suit: s, cards });
  }
  groups.sort((a, b) => a.cards.length - b.cards.length);

  const chosen = [];
  const chosenIds = new Set();
  let budget = 6;
  for (const g of groups) {
    if (budget <= 0) break;
    const asc = g.cards.slice().sort((a, b) => rankIndex(a.r) - rankIndex(b.r));
    if (asc.length <= budget) {
      // 整门都能扣掉，直接形成断门
      for (const c of asc) {
        chosen.push(c);
        chosenIds.add(c.id);
      }
      budget -= asc.length;
    } else {
      // 只能扣一部分：先扣低牌，A/K/Q 留作控制牌
      for (const c of asc.slice(0, budget)) {
        chosen.push(c);
        chosenIds.add(c.id);
      }
      budget = 0;
    }
  }

  // 还不够 6 张（手里副牌太少）：从剩下的牌里挑牌力最弱的补上
  if (chosen.length < 6) {
    const rest = pool
      .filter((c) => !chosenIds.has(c.id))
      .sort((a, b) => power(a, trumpSuit) - power(b, trumpSuit));
    for (const c of rest) {
      if (chosen.length >= 6) break;
      chosen.push(c);
      chosenIds.add(c.id);
    }
  }
  return chosen.slice(0, 6).map((c) => c.id);
}

/**
 * 噶点叫分：返回愿意叫到的分值或 null（不叫）。
 *
 * 噶点是 1 打 3，专家必须独自拿到叫分值。实测（上千局）专家最终得分与
 * 「最强花色强度」大致是：得分 ≈ 18 + 2.1 × 强度，例如强度 12 约 43 分、
 * 强度 15 约 50 分。因此绝大部分手牌只值 55 分，抬价只会白送；
 * 只有摸到明显强牌才敢叫 60 / 65。
 */
export function chooseBid(hand, redeals = 0) {
  let best = 0;
  for (const s of SUITS) best = Math.max(best, suitStrength(hand, s));
  // 重发次数越多，越愿意降低要求接盘
  const need = 11.2 - Math.min(2, redeals) * 1.2;
  if (best < need) return null;
  const expect = 18 + best * 2.1;
  if (expect >= 60) return 65;
  if (expect >= 55) return 60;
  return 55;
}
