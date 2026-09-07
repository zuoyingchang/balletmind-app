const express = require('express');
const { ADMIN_KEY } = require('../config');
const { buildAdminStats } = require('../admin-stats');

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

module.exports = router;
