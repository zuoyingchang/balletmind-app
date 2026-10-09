const db = require('../db');

// 课卡管家: plain bookkeeping, no AI. A card is a pack of classes bought from a
// studio; each card_usages row is one class deducted from it.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TOTAL_COUNT = 500;
const MAX_PRICE = 1000000;

class CardError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function validDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Validates a create (partial=false) or PATCH (partial=true) body against the
// existing card. Returns the column values to write; throws CardError(400).
function cardFieldsFrom(body, existing) {
  const b = body || {};
  const partial = !!existing;
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);

  if (!partial || has('name')) {
    const name = String(b.name || '').trim().slice(0, 40);
    if (!name) throw new CardError(400, '给这张卡起个名字，比如「XX 舞蹈 20 次卡」');
    out.name = name;
  }
  if (!partial || has('kind')) {
    const kind = b.kind === 'period' ? 'period' : (b.kind === 'count' || b.kind === undefined ? 'count' : null);
    if (!kind) throw new CardError(400, '卡的类型不对');
    out.kind = kind;
  }
  if (!partial || has('totalCount')) {
    if (b.totalCount === null || b.totalCount === undefined || b.totalCount === '') {
      out.total_count = null;
    } else {
      const n = Number(b.totalCount);
      if (!Number.isInteger(n) || n < 1 || n > MAX_TOTAL_COUNT) throw new CardError(400, `总次数填 1 到 ${MAX_TOTAL_COUNT} 之间的整数`);
      out.total_count = n;
    }
  }
  if (!partial || has('price')) {
    if (b.price === null || b.price === undefined || b.price === '') {
      out.price = null;
    } else {
      const p = Number(b.price);
      if (!Number.isFinite(p) || p < 0 || p > MAX_PRICE) throw new CardError(400, '价格填一个正常的金额');
      out.price = Math.round(p * 100) / 100;
    }
  }
  for (const [key, col] of [['startDate', 'start_date'], ['expireDate', 'expire_date']]) {
    if (!partial || has(key)) {
      const v = b[key];
      if (v === null || v === undefined || v === '') out[col] = null;
      else if (typeof v === 'string' && validDate(v)) out[col] = v;
      else throw new CardError(400, '日期格式不对');
    }
  }
  if (partial && has('archived')) out.archived = b.archived ? 1 : 0;

  const merged = { ...(existing || {}), ...out };
  if (merged.kind === 'count' && !merged.total_count) throw new CardError(400, '次卡要填总次数');
  if (merged.kind === 'period') {
    if (!merged.expire_date) throw new CardError(400, '期限卡要填到期日');
    out.total_count = null;
  }
  if (merged.start_date && merged.expire_date && merged.start_date > merged.expire_date) {
    throw new CardError(400, '到期日不能早于开始日');
  }
  return out;
}

async function ownedCard(userId, cardId) {
  const id = Number(cardId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.get('SELECT * FROM class_cards WHERE id = ? AND user_id = ?', [id, userId]);
}

async function usedCount(cardId) {
  const row = await db.get('SELECT COUNT(*) AS c FROM card_usages WHERE card_id = ?', [cardId]);
  return Number(row?.c || 0);
}

// Deducts one class. recordId optional (the 课记/打卡 it came with).
async function useCard(userId, cardId, { recordId = null, usedAt = Date.now() } = {}) {
  const card = await ownedCard(userId, cardId);
  if (!card) throw new CardError(404, '没找到这张卡');
  if (card.archived) throw new CardError(400, '这张卡已经收起来了，先恢复再扣', 'card_archived');
  if (card.kind === 'count' && (await usedCount(card.id)) >= card.total_count) {
    throw new CardError(409, '这张卡的课已经用完了', 'card_used_up');
  }
  if (recordId) {
    const record = await db.get('SELECT id FROM records WHERE id = ? AND user_id = ?', [recordId, userId]);
    if (!record) throw new CardError(404, '没找到这条记录');
    const dup = await db.get('SELECT id FROM card_usages WHERE record_id = ? AND user_id = ?', [recordId, userId]);
    if (dup) throw new CardError(409, '这节课已经扣过卡了', 'card_already_used');
  }
  const info = await db.run(
    'INSERT INTO card_usages (card_id, user_id, record_id, used_at, created_at) VALUES (?, ?, ?, ?, ?)',
    [card.id, userId, recordId || null, usedAt, Date.now()]
  );
  return { usageId: Number(info.lastInsertRowid), card: await cardSummary(card) };
}

async function cardSummary(card) {
  const used = await usedCount(card.id);
  // used_at 0 = taken before the card was added to the app; not something to show or undo.
  const recent = await db.all(
    `SELECT u.id, u.used_at, u.record_id, r.class_name
     FROM card_usages u LEFT JOIN records r ON r.id = u.record_id
     WHERE u.card_id = ? AND u.used_at > 0 ORDER BY u.used_at DESC, u.id DESC LIMIT 5`,
    [card.id]
  );
  return {
    id: card.id,
    name: card.name,
    kind: card.kind,
    totalCount: card.total_count,
    price: card.price,
    startDate: card.start_date,
    expireDate: card.expire_date,
    archived: !!card.archived,
    createdAt: card.created_at,
    usedCount: used,
    remaining: card.kind === 'count' ? Math.max(0, card.total_count - used) : null,
    lastUsedAt: recent[0]?.used_at || null,
    lastClassName: recent.find((u) => u.class_name)?.class_name || null,
    recentUsages: recent.map((u) => ({
      id: u.id, usedAt: u.used_at, recordId: u.record_id, className: u.class_name || null,
    })),
  };
}

async function listCards(userId) {
  const cards = await db.all(
    'SELECT * FROM class_cards WHERE user_id = ? ORDER BY archived ASC, created_at DESC',
    [userId]
  );
  return Promise.all(cards.map(cardSummary));
}

// Deleting a 课记 hands its class back to the card. Returns how many were returned.
async function releaseRecordUsages(userId, recordId) {
  const row = await db.get(
    'SELECT COUNT(*) AS c FROM card_usages WHERE record_id = ? AND user_id = ?',
    [recordId, userId]
  );
  const n = Number(row?.c || 0);
  if (n) await db.run('DELETE FROM card_usages WHERE record_id = ? AND user_id = ?', [recordId, userId]);
  return n;
}

module.exports = {
  CardError, cardFieldsFrom, ownedCard, useCard, cardSummary, listCards, releaseRecordUsages,
};
