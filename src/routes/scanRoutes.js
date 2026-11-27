const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const db = require('../db');
const { getBaseUrl } = require('../auth');
const { notifyOwnerScan } = require('../telegram');
const { getEffectivePlan } = require('../plans');
const { syncExpiredSubscriptions } = require('../subscriptionSync');

const router = express.Router();

// Checks if an item is locked due to owner's expired subscription exceeding Free tier quota
async function isItemLockedByExpiration(item, io = null) {
  await syncExpiredSubscriptions(io);
  const owner = await db.get(
    'SELECT plan_id, subscription_status, subscription_expires_at FROM users WHERE id = ?',
    [item.user_id]
  );
  const effectivePlan = getEffectivePlan(owner);
  const rankRow = await db.get(
    'SELECT COUNT(*) as cnt FROM items WHERE user_id = ? AND id < ?',
    [item.user_id, item.id]
  );
  const rank = Number(rankRow?.cnt || 0);
  return rank >= effectivePlan.maxItems;
}

// Generate crisp SVG QR code locally
router.get('/qr/:code', async (req, res) => {
  try {
    const item = await db.get('SELECT public_code FROM items WHERE public_code = ?', [req.params.code]);
    if (!item) {
      return res.status(404).send('QR code not found');
    }

    const baseUrl = getBaseUrl(req);
    const scanUrl = `${baseUrl}/scan.html?code=${item.public_code}`;

    const svg = await QRCode.toString(scanUrl, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'H',
      color: {
        dark: '#0f172a',
        light: '#ffffff'
      }
    });

    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(svg);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error generating QR');
  }
});

// Get public info for scanned QR (Zero PII)
router.get('/info/:code', async (req, res) => {
  try {
    const item = await db.get(
      `SELECT id, user_id, name, category, custom_message, status, require_location
       FROM items
       WHERE public_code = ?`,
      [req.params.code]
    );

    if (!item) {
      return res.status(404).json({ error: 'رمز الـ QR غير صالح أو تم حذفه' });
    }

    if (item.status === 'disabled') {
      return res.status(403).json({ error: 'تم تعطيل هذا الرمز مؤقتاً بواسطة المالك' });
    }

    if (await isItemLockedByExpiration(item, req.app.get('io'))) {
      return res.status(403).json({ error: 'تم إيقاف هذا الرمز مؤقتاً لحين تجديد اشتراك المالك' });
    }

    res.json({
      name: item.name,
      category: item.category,
      custom_message: item.custom_message,
      require_location: Boolean(item.require_location),
      status: item.status
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ في قراءة رمز الـ QR' });
  }
});

async function triggerUserWebhook(userId, payload) {
  try {
    const user = await db.get(
      'SELECT plan_id, subscription_status, subscription_expires_at, webhook_url FROM users WHERE id = ?',
      [userId]
    );
    if (!user || !user.webhook_url) return;
    const plan = getEffectivePlan(user);
    if (!plan.capabilities.webhookAlerts) return;

    await fetch(user.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000)
    });
  } catch (err) {
    console.warn('Webhook delivery failed:', err.message);
  }
}

// Record scan & optional geolocation, return/create session & chat room
router.post('/record', async (req, res) => {
  try {
    const { code, latitude, longitude, accuracy, sessionId: clientSessionId } = req.body;

    const item = await db.get('SELECT id, name, category, status, user_id FROM items WHERE public_code = ?', [code]);
    if (!item) {
      return res.status(404).json({ error: 'الرمز غير موجود' });
    }
    if (item.status === 'disabled') {
      return res.status(403).json({ error: 'تم تعطيل هذا الرمز بواسطة المالك' });
    }
    if (await isItemLockedByExpiration(item, req.app.get('io'))) {
      return res.status(403).json({ error: 'تم إيقاف هذا الرمز مؤقتاً لحين تجديد اشتراك المالك' });
    }

    const sessionId = clientSessionId || crypto.randomUUID();
    const ipHash = crypto.createHash('sha256').update(req.ip || '127.0.0.1').digest('hex').substring(0, 16);

    await db.run(
      `INSERT INTO scans (item_id, session_id, latitude, longitude, accuracy, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        sessionId,
        latitude || null,
        longitude || null,
        accuracy || null,
        ipHash
      ]
    );

    let chat = await db.get('SELECT id FROM chats WHERE item_id = ? AND session_id = ?', [item.id, sessionId]);
    let isNewChat = false;
    if (!chat) {
      isNewChat = true;
      const chatInfo = await db.run(
        `INSERT INTO chats (item_id, session_id, unread_owner)
         VALUES (?, ?, 1)`,
        [item.id, sessionId]
      );
      chat = { id: chatInfo.lastInsertRowid };

      let sysMsg = item.status === 'lost'
        ? 'تنبيه عاجل: هذا الغرض مُبلغ عنه كمفقود. شكراً لمبادرتك بالتواصل، محادثتك آمنة ومجهولة تماماً.'
        : 'مرحباً بك! هذه المحادثة آمنة ومجهولة تماماً، يمكنك مراسلة المالك هنا دون كشف بياناتك.';
      if (latitude && longitude) {
        sysMsg += ' تم إرفاق موقعك الجغرافي لمساعدة المالك.';
      }
      await db.run(
        `INSERT INTO messages (chat_id, sender_type, message, lat, lng)
         VALUES (?, 'system', ?, ?, ?)`,
        [chat.id, sysMsg, latitude || null, longitude || null]
      );
    }

    const baseUrl = getBaseUrl(req);
    const ownerChatUrl = `${baseUrl}/dashboard.html?openChat=${chat.id}`;

    const io = req.app.get('io');
    if (io) {
      io.to(`owner_${item.user_id}`).emit('scan_alert', {
        chatId: chat.id,
        itemId: item.id,
        itemName: item.name,
        lat: latitude || null,
        lng: longitude || null,
        isNewChat,
        timestamp: new Date().toISOString()
      });
    }

    notifyOwnerScan(item.user_id, item.name, latitude, longitude, ownerChatUrl).catch(console.error);
    triggerUserWebhook(item.user_id, {
      event: 'qr_scanned',
      platform: 'Waged',
      itemName: item.name,
      category: item.category,
      location: latitude && longitude ? { lat: latitude, lng: longitude, mapsUrl: `https://www.google.com/maps?q=${latitude},${longitude}` } : null,
      chatUrl: ownerChatUrl,
      timestamp: new Date().toISOString()
    }).catch(console.error);

    res.json({
      success: true,
      sessionId,
      chatId: chat.id,
      itemName: item.name
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء تسجيل المسح' });
  }
});

module.exports = router;
