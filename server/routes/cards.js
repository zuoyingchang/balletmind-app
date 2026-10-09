const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logEvent } = require('../events');
const {
  CardError, cardFieldsFrom, ownedCard, useCard, cardSummary, listCards,
} = require('../lib/cards');

const router = express.Router();
router.use(requireAuth);

const MAX_CARDS_PER_USER = 50;

function sendCardError(res, e) {
  if (e instanceof CardError) {
    return res.status(e.status).json({ error: e.message, ...(e.code ? { code: e.code } : {}) });
  }
  throw e;
}

router.get('/', async (req, res) => {
  res.json(await listCards(req.userId));
});

router.post('/', async (req, res) => {
  let fields;
  try {
    fields = cardFieldsFrom(req.body);
  } catch (e) {
    return sendCardError(res, e);
  }
  const count = await db.get('SELECT COUNT(*) AS c FROM class_cards WHERE user_id = ?', [req.userId]);
  if (Number(count?.c || 0) >= MAX_CARDS_PER_USER) {
    return res.status(400).json({ error: '卡太多了，先删掉几张用完的' });
  }
  // A card bought before the app: classes already taken count as used, with no record attached
  // and used_at 0 (date unknown), so they never show up as the "上次扣课".
  const usedBefore = Number(req.body && req.body.usedBefore) || 0;
  const usedCap = fields.kind === 'count' ? fields.total_count : 500;
  if (!Number.isInteger(usedBefore) || usedBefore < 0 || usedBefore > usedCap) {
    return res.status(400).json({ error: '已经上过的节数不对' });
  }
  const now = Date.now();
  const info = await db.run(
    `INSERT INTO class_cards (user_id, name, kind, total_count, price, start_date, expire_date, archived, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [req.userId, fields.name, fields.kind, fields.total_count, fields.price, fields.start_date, fields.expire_date, now, now]
  );
  const cardId = Number(info.lastInsertRowid);
  for (let i = 0; i < usedBefore; i++) {
    await db.run(
      'INSERT INTO card_usages (card_id, user_id, record_id, used_at, created_at) VALUES (?, ?, NULL, ?, ?)',
      [cardId, req.userId, 0, now]
    );
  }
  const card = await ownedCard(req.userId, cardId);
  res.json(await cardSummary(card));
});

router.patch('/:id', async (req, res) => {
  const card = await ownedCard(req.userId, req.params.id);
  if (!card) return res.status(404).json({ error: '没找到这张卡' });
  let fields;
  try {
    fields = cardFieldsFrom(req.body, card);
  } catch (e) {
    return sendCardError(res, e);
  }
  const cols = Object.keys(fields);
  if (cols.length) {
    await db.run(
      `UPDATE class_cards SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND user_id = ?`,
      [...cols.map((c) => fields[c]), Date.now(), card.id, req.userId]
    );
  }
  res.json(await cardSummary(await ownedCard(req.userId, card.id)));
});

router.delete('/:id', async (req, res) => {
  const card = await ownedCard(req.userId, req.params.id);
  if (card) {
    await db.run('DELETE FROM card_usages WHERE card_id = ? AND user_id = ?', [card.id, req.userId]);
    await db.run('DELETE FROM class_cards WHERE id = ? AND user_id = ?', [card.id, req.userId]);
  }
  res.json({ ok: true });
});

// Manual 扣一次 (a class that has no 课记 in the app).
router.post('/:id/use', async (req, res) => {
  try {
    const result = await useCard(req.userId, req.params.id);
    await logEvent(req.userId, 'card_used', { from: 'manual' });
    res.json(result);
  } catch (e) {
    sendCardError(res, e);
  }
});

router.delete('/usages/:usageId', async (req, res) => {
  const usage = await db.get(
    'SELECT * FROM card_usages WHERE id = ? AND user_id = ?',
    [Number(req.params.usageId) || 0, req.userId]
  );
  if (!usage) return res.status(404).json({ error: '没找到这次扣课' });
  await db.run('DELETE FROM card_usages WHERE id = ? AND user_id = ?', [usage.id, req.userId]);
  const card = await ownedCard(req.userId, usage.card_id);
  res.json({ ok: true, card: card ? await cardSummary(card) : null });
});

module.exports = router;
