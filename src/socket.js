const db = require('./db');
const { verifyToken, getBaseUrl } = require('./auth');
const { notifyOwnerMessage } = require('./telegram');

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > -1) {
      const key = pair.slice(0, idx).trim();
      const val = decodeURIComponent(pair.slice(idx + 1).trim());
      cookies[key] = val;
    }
  });
  return cookies;
}

function setupSocket(io) {
  io.on('connection', async (socket) => {
    let currentRoom = null;

    const cookies = parseCookies(socket.handshake.headers.cookie);
    const handshakeToken = cookies.token || socket.handshake.auth?.token;
    const handshakeUser = handshakeToken ? verifyToken(handshakeToken) : null;

    if (handshakeUser) {
      socket.user = handshakeUser;
      socket.join(`owner_${handshakeUser.id}`);
      try {
        const u = await db.get('SELECT role FROM users WHERE id = ?', [handshakeUser.id]);
        if (u && (u.role === 'admin' || u.role === 'super_admin')) {
          socket.join('admins_room');
        }
      } catch (e) {}
    }

    socket.on('join_chat', async (data) => {
      try {
        const { chatId, sessionId, token } = data || {};
        if (!chatId) return;

        const chat = await db.get(
          `SELECT c.*, i.name as item_name, i.user_id as owner_id
           FROM chats c
           JOIN items i ON c.item_id = i.id
           WHERE c.id = ?`,
          [chatId]
        );

        if (!chat) {
          return socket.emit('error', 'المحادثة غير موجودة');
        }

        let isAuthorized = false;
        let role = 'scanner';

        const activeUser = socket.user || (token ? verifyToken(token) : null);
        if (activeUser && activeUser.id === chat.owner_id) {
          isAuthorized = true;
          role = 'owner';
        }

        if (!isAuthorized && sessionId && chat.session_id === sessionId) {
          isAuthorized = true;
          role = 'scanner';
        }

        if (!isAuthorized) {
          return socket.emit('error', 'غير مصرح بالدخول لهذه الغرفة');
        }

        if (currentRoom && currentRoom !== `chat_${chatId}`) {
          socket.leave(currentRoom);
        }

        const roomName = `chat_${chatId}`;
        socket.join(roomName);
        currentRoom = roomName;
        socket.role = role;
        socket.chatId = Number(chatId);
        socket.ownerId = chat.owner_id;
        socket.itemName = chat.item_name;

        socket.emit('joined', { role, chatId: Number(chatId), itemName: chat.item_name });
      } catch (err) {
        console.error('Socket join_chat error:', err);
      }
    });

    socket.on('send_message', async (data) => {
      const { chatId, message, lat, lng } = data || {};
      if (!chatId || !message || !message.trim()) return;

      if (Number(socket.chatId) !== Number(chatId)) {
        return socket.emit('error', 'غير مصرح بإرسال رسالة لهذه الغرفة');
      }

      const role = socket.role || 'scanner';
      const cleanText = message.trim().slice(0, 2000);

      try {
        const info = await db.run(
          `INSERT INTO messages (chat_id, sender_type, message, lat, lng)
           VALUES (?, ?, ?, ?, ?)`,
          [chatId, role, cleanText, lat || null, lng || null]
        );

        if (role === 'scanner') {
          await db.run('UPDATE chats SET updated_at = CURRENT_TIMESTAMP, unread_owner = unread_owner + 1 WHERE id = ?', [chatId]);
        } else {
          await db.run('UPDATE chats SET updated_at = CURRENT_TIMESTAMP, unread_owner = 0 WHERE id = ?', [chatId]);
        }

        const newMsg = {
          id: info.lastInsertRowid,
          chat_id: Number(chatId),
          sender_type: role,
          message: cleanText,
          item_name: socket.itemName,
          lat: lat || null,
          lng: lng || null,
          created_at: new Date().toISOString()
        };

        io.to(`chat_${chatId}`).emit('new_message', newMsg);

        if (role === 'scanner' && socket.ownerId) {
          io.to(`owner_${socket.ownerId}`).emit('owner_new_message', newMsg);
          const baseUrl = getBaseUrl();
          notifyOwnerMessage(socket.ownerId, socket.itemName, cleanText, `${baseUrl}/dashboard.html?openChat=${chatId}`).catch(console.error);
        }
      } catch (err) {
        console.error('Socket message error:', err);
        socket.emit('error', 'فشل في حفظ الرسالة');
      }
    });

    socket.on('typing', () => {
      if (currentRoom) {
        socket.to(currentRoom).emit('user_typing', { role: socket.role });
      }
    });

    socket.on('stop_typing', () => {
      if (currentRoom) {
        socket.to(currentRoom).emit('user_stop_typing', { role: socket.role });
      }
    });
  });
}

module.exports = setupSocket;
