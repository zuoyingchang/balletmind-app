const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { listCorrections, addCorrection } = require('../terms');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  res.json(await listCorrections(req.userId));
});

// POST /api/terms  { wrongTerm, correctTerm } — the user explicitly flags a
// term AI got wrong. Never inferred by diffing their edits.
router.post('/', async (req, res) => {
  const { wrongTerm, correctTerm } = req.body || {};
  if (!wrongTerm || !wrongTerm.trim() || !correctTerm || !correctTerm.trim()) {
    return res.status(400).json({ error: '请填写错误写法和正确写法' });
  }
  const correction = await addCorrection(req.userId, wrongTerm.trim(), correctTerm.trim());
  res.json(correction);
});

module.exports = router;
