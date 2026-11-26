const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const db = require('../db');
const { getBaseUrl } = require('../auth');
const { notifyOwnerScan } = require('../telegram');
const { getEffectivePlan } = require('../plans');

const router = express.Router();

// Generate crisp SVG QR code locally (no third-party leaks)
router.get('/qr/:code', async (req, res) => {
  try {
    const item = db.prepare('SELECT public_code FROM items WHERE public_code = ?').get(req.params.code);
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

// Get public info for scanned QR
router.get('/info/:code', (req, res) => {
  try {
    const item = db.prepare(`
      SELECT id, name, category, custom_message, status, require_location
      FROM items
      WHERE public_code = ?
    `).get(req.params.code);

    if (!item) {
      return res.status(404).json({ error: 'رمز الـ QR غير صالح أو تم حذفه' });
    }

    if (item.status === 'disabled') {
      return res.status(403).json({ error: 'تم تعطيل هذا الرمز مؤقتاً بواسطة المالك' });
    }

    // Strictly anonymous data (Zero PII)
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

// Fire custom user webhook if configured and allowed by plan
async function triggerUserWebhook(userId, payload) {
  try {
    const user = db.prepare('SELECT plan_id, subscription_status, subscription_expires_at, webhook_url FROM users WHERE id = ?').get(userId);
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

    const item = db.prepare('SELECT id, name, category, status, user_id FROM items WHERE public_code = ?').get(code);
    if (!item) {
      return res.status(404).json({ error: 'الرمز غير موجود' });
    }
    if (item.status === 'disabled') {
      return res.status(403).json({ error: 'تم تعطيل هذا الرمز بواسطة المالك' });
    }

    const sessionId = clientSessionId || crypto.randomUUID();
    const ipHash = crypto.createHash('sha256').update(req.ip || '127.0.0.1').digest('hex').substring(0, 16);

    db.prepare(`
      INSERT INTO scans (item_id, session_id, latitude, longitude, accuracy, ip_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      item.id,
      sessionId,
      latitude || null,
      longitude || null,
      accuracy || null,
      ipHash
    );

    let chat = db.prepare('SELECT id FROM chats WHERE item_id = ? AND session_id = ?').get(item.id, sessionId);
    let isNewChat = false;
    if (!chat) {
      isNewChat = true;
      const chatInfo = db.prepare(`
        INSERT INTO chats (item_id, session_id, unread_owner)
        VALUES (?, ?, 1)
      `).run(item.id, sessionId);
      chat = { id: chatInfo.lastInsertRowid };

      let sysMsg = item.status === 'lost'
        ? '🚨 هذا الغرض مُبلغ عنه كمفقود! شكراً لمبادرتك بالتواصل، محادثتك آمنة ومجهولة تماماً.'
        : 'مرحباً بك! هذه المحادثة آمنة ومجهولة تماماً. يمكنك مراسلة المالك هنا.';
      if (latitude && longitude) {
        sysMsg += ' تم إرفاق موقعك الجغرافي لمساعدة المالك.';
      }
      db.prepare(`
        INSERT INTO messages (chat_id, sender_type, message, lat, lng)
        VALUES (?, 'system', ?, ?, ?)
      `).run(chat.id, sysMsg, latitude || null, longitude || null);
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
