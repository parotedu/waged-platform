const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { BOT_TOKEN, BOT_USERNAME, handleTelegramUpdate } = require('../telegram');

const router = express.Router();

router.post('/webhook', async (req, res) => {
  await handleTelegramUpdate(req.body);
  res.sendStatus(200);
});

router.get('/status', requireAuth, async (req, res) => {
  try {
    const user = await db.get('SELECT telegram_chat_id, telegram_link_token FROM users WHERE id = ?', [req.user.id]);
    const configured = Boolean(BOT_TOKEN && BOT_USERNAME);
    const deepLinkUrl = configured && user?.telegram_link_token
      ? `https://t.me/${BOT_USERNAME}?start=${user.telegram_link_token}`
      : null;

    res.json({
      configured,
      botUsername: BOT_USERNAME || null,
      linked: Boolean(user?.telegram_chat_id),
      chatId: user?.telegram_chat_id || null,
      deepLinkUrl
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في فحص حالة تليجرام' });
  }
});

module.exports = router;
