const express = require('express');
const db = require('../db');
const { requireAuth, verifyToken, getBaseUrl } = require('../auth');
const { notifyOwnerMessage } = require('../telegram');

const router = express.Router();

// Helper to check chat access
function verifyChatAccess(req, chatId, sessionId) {
  const chat = db.prepare(`
    SELECT c.*, i.name as item_name, i.user_id as owner_id
    FROM chats c
    JOIN items i ON c.item_id = i.id
    WHERE c.id = ?
  `).get(chatId);

  if (!chat) return null;

  const token = req.cookies.token || (req.headers.authorization && req.headers.authorization.split(' ')[1]);
  if (token) {
    const user = verifyToken(token);
    if (user && user.id === chat.owner_id) {
      return { chat, role: 'owner', userId: user.id };
    }
  }

  if (sessionId && chat.session_id === sessionId) {
    return { chat, role: 'scanner' };
  }

  return null;
}

// Get messages for a chat (plus latest scan coordinates)
router.get('/:chatId/messages', (req, res) => {
  try {
    const chatId = req.params.chatId;
    const sessionId = req.query.sessionId || req.headers['x-session-id'];

    const access = verifyChatAccess(req, chatId, sessionId);
    if (!access) {
      return res.status(403).json({ error: 'غير مصرح لك بالوصول لهذه المحادثة' });
    }

    if (access.role === 'owner') {
      db.prepare('UPDATE chats SET unread_owner = 0 WHERE id = ?').run(chatId);
    }

    const messages = db.prepare(`
      SELECT id, sender_type, message, lat, lng, created_at
      FROM messages
      WHERE chat_id = ?
      ORDER BY id ASC
    `).all(chatId);

    const lastScan = db.prepare(`
      SELECT latitude, longitude
      FROM scans
      WHERE item_id = ? AND session_id = ? AND latitude IS NOT NULL AND longitude IS NOT NULL
      ORDER BY id DESC LIMIT 1
    `).get(access.chat.item_id, access.chat.session_id);

    res.json({
      role: access.role,
      itemName: access.chat.item_name,
      scanLocation: lastScan ? { lat: lastScan.latitude, lng: lastScan.longitude } : null,
      messages
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في جلب الرسائل' });
  }
});

// Send message via REST endpoint
router.post('/:chatId/messages', async (req, res) => {
  try {
    const chatId = req.params.chatId;
    const { message, sessionId, lat, lng } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'نص الرسالة مطلوب' });
    }

    if (message.trim().length > 2000) {
      return res.status(400).json({ error: 'الرسالة طويلة جداً (الحد الأقصى 2000 حرف)' });
    }

    const access = verifyChatAccess(req, chatId, sessionId);
    if (!access) {
      return res.status(403).json({ error: 'غير مصرح لك بإرسال رسائل في هذه المحادثة' });
    }

    const cleanMsg = message.trim();
    const senderType = access.role;

    const stmt = db.prepare(`
      INSERT INTO messages (chat_id, sender_type, message, lat, lng)
      VALUES (?, ?, ?, ?, ?)
    `);
    const info = stmt.run(chatId, senderType, cleanMsg, lat || null, lng || null);

    if (senderType === 'scanner') {
      db.prepare('UPDATE chats SET updated_at = CURRENT_TIMESTAMP, unread_owner = unread_owner + 1 WHERE id = ?').run(chatId);
    } else {
      db.prepare('UPDATE chats SET updated_at = CURRENT_TIMESTAMP, unread_owner = 0 WHERE id = ?').run(chatId);
    }

    const savedMessage = {
      id: info.lastInsertRowid,
      chat_id: Number(chatId),
      sender_type: senderType,
      message: cleanMsg,
      item_name: access.chat.item_name,
      lat: lat || null,
      lng: lng || null,
      created_at: new Date().toISOString()
    };

    const io = req.app.get('io');
    if (io) {
      io.to(`chat_${chatId}`).emit('new_message', savedMessage);
      if (senderType === 'scanner') {
        io.to(`owner_${access.chat.owner_id}`).emit('owner_new_message', savedMessage);
      }
    }

    if (senderType === 'scanner') {
      const baseUrl = getBaseUrl(req);
      const ownerChatUrl = `${baseUrl}/dashboard.html?openChat=${chatId}`;
      notifyOwnerMessage(access.chat.owner_id, access.chat.item_name, cleanMsg, ownerChatUrl).catch(console.error);
    }

    res.status(201).json({ success: true, message: savedMessage });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء إرسال الرسالة' });
  }
});

// Owner: Delete a conversation
router.delete('/:chatId', requireAuth, (req, res) => {
  try {
    const chat = db.prepare(`
      SELECT c.id FROM chats c
      JOIN items i ON c.item_id = i.id
      WHERE c.id = ? AND i.user_id = ?
    `).get(req.params.chatId, req.user.id);

    if (!chat) {
      return res.status(404).json({ error: 'المحادثة غير موجودة' });
    }

    db.prepare('DELETE FROM chats WHERE id = ?').run(chat.id);
    res.json({ success: true, message: 'تم حذف المحادثة بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء حذف المحادثة' });
  }
});

// Owner: Get list of all recent conversations across all user items
router.get('/owner/conversations', requireAuth, (req, res) => {
  try {
    const conversations = db.prepare(`
      SELECT 
        c.id as chat_id,
        c.session_id,
        c.unread_owner,
        c.updated_at,
        i.id as item_id,
        i.name as item_name,
        i.category as item_category,
        (SELECT message FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) as last_message,
        (SELECT sender_type FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) as last_sender,
        (SELECT created_at FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) as last_message_time,
        (SELECT COUNT(*) FROM messages WHERE chat_id = c.id) as message_count,
        (SELECT latitude FROM scans WHERE item_id = i.id AND session_id = c.session_id ORDER BY id DESC LIMIT 1) as scan_lat,
        (SELECT longitude FROM scans WHERE item_id = i.id AND session_id = c.session_id ORDER BY id DESC LIMIT 1) as scan_lng
      FROM chats c
      JOIN items i ON c.item_id = i.id
      WHERE i.user_id = ?
      ORDER BY c.updated_at DESC
    `).all(req.user.id);

    res.json({ conversations });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في جلب المحادثات' });
  }
});

module.exports = router;
