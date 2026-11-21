const db = require('./db');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'WagedBot';

async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  if (!BOT_TOKEN) {
    console.log(`[Telegram Simulation] Target ${chatId}: ${text}`);
    return { success: false, reason: 'TELEGRAM_BOT_TOKEN not configured' };
  }

  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const payload = {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: false
    };

    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    return data;
  } catch (err) {
    console.error('Error sending Telegram notification:', err.message);
    return { success: false, error: err.message };
  }
}

// Notify owner about QR scan & location
async function notifyOwnerScan(userId, itemName, lat, lng, chatUrl) {
  const user = db.prepare('SELECT telegram_chat_id, name FROM users WHERE id = ?').get(userId);
  if (!user || !user.telegram_chat_id) return;

  let locationText = 'غير محدد';
  let mapsUrl = '';
  if (lat && lng) {
    mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
    locationText = `<a href="${mapsUrl}">اضغط هنا لفتح الخريطة 📍</a>`;
  }

  const message = `🚨 <b>تنبيه من منصة واجد!</b>

قام شخص للتو بمسح رمز QR الخاص بـ:
<b>📦 الغرض:</b> ${itemName}
<b>📍 الموقع الجغرافي:</b> ${locationText}
<b>⏱ التوقيت:</b> ${new Date().toLocaleTimeString('ar-EG')}

💬 يمكنك الآن التواصل معه بأمان وبسرية تامة دون كشف رقمك:
<a href="${chatUrl}">👉 اضغط هنا لفتح المحادثة الفورية</a>`;

  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: '💬 فتح الشات المباشر', url: chatUrl }
      ]
    ]
  };

  if (mapsUrl) {
    inlineKeyboard.inline_keyboard[0].unshift({ text: '📍 فتح اللوكيشن', url: mapsUrl });
  }

  return sendTelegramMessage(user.telegram_chat_id, message, inlineKeyboard);
}

// Notify owner about new message in chat
async function notifyOwnerMessage(userId, itemName, messageSnippet, chatUrl) {
  const user = db.prepare('SELECT telegram_chat_id, name FROM users WHERE id = ?').get(userId);
  if (!user || !user.telegram_chat_id) return;

  const message = `💬 <b>رسالة جديدة على منصة واجد</b>

<b>📦 الغرض:</b> ${itemName}
<b>📩 نص الرسالة:</b>
<i>"${messageSnippet}"</i>

<a href="${chatUrl}">👉 اضغط هنا للرد على الشخص</a>`;

  return sendTelegramMessage(user.telegram_chat_id, message, {
    inline_keyboard: [
      [{ text: '💬 الرد المباشر', url: chatUrl }]
    ]
  });
}

module.exports = {
  BOT_TOKEN,
  BOT_USERNAME,
  sendTelegramMessage,
  notifyOwnerScan,
  notifyOwnerMessage
};
