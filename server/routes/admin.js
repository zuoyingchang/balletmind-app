const express = require('express');
const { ADMIN_KEY } = require('../config');
const { buildAdminStats, listAdminEvents } = require('../admin-stats');
const { knownEventNames } = require('../analytics');

const router = express.Router();

function requireAdminKey(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: '管理统计功能未配置 ADMIN_KEY' });
  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) return res.status(401).json({ error: '管理密钥不对' });
  next();
}

router.get('/stats', requireAdminKey, async (req, res) => {
  try {
    res.json(await buildAdminStats());
  } catch (e) {
    res.status(500).json({ error: '统计查询失败', detail: e.message });
  }
});

// Raw event rows for debugging. Never joins email. Metadata is already sanitized at write.
router.get('/events', requireAdminKey, async (req, res) => {
  try {
    const eventName = String(req.query.event || '').trim();
    if (eventName && !knownEventNames().has(eventName)) {
      return res.status(400).json({ error: '未知事件类型' });
    }
    const rows = await listAdminEvents({ eventName, limit: req.query.limit });
    res.json({ events: rows, note: '只有 user_id，没有邮箱/转写/复盘正文。' });
  } catch (e) {
    res.status(500).json({ error: '事件查询失败', detail: e.message });
  }
});

module.exports = router;
