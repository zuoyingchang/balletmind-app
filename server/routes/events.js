const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { logEvent, KNOWN_EVENTS } = require('../events');
const { practiceFromReq } = require('../lib/practice');

const router = express.Router();

// POST /api/events  { event, metadata? } -> fire-and-forget analytics event
// from the client (things the server never otherwise sees: recording started,
// ASR errored, user opened history, etc). Server-side events that already hit
// an existing route (ai_process_*, save_record) are logged directly there
// instead of round-tripping through here.
router.post('/', requireAuth, async (req, res) => {
  const { event, metadata } = req.body || {};
  if (!KNOWN_EVENTS.has(event)) return res.status(400).json({ error: '未知事件类型' });
  const meta = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  await logEvent(req.userId, event, { ...meta, practice: practiceFromReq(req) });
  res.json({ ok: true });
});

module.exports = router;
