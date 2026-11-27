const db = require('./db');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || '';
let pollingActive = false;
let lastUpdateId = 0;

function escapeTgHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  if (!BOT_TOKEN) {
    console.log(`[Telegram Simulation] Target ${chatId}: ${text.replace(/<[^>]+>/g, '')}`);
    return { success: false, simulated: true, reason: 'TELEGRAM_BOT_TOKEN not configured' };
  }

  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const payload = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false
    };

    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000)
    });

    return await response.json();
  } catch (err) {
    console.error('Error sending Telegram notification:', err.message);
    return { success: false, error: err.message };
  }
}

async function handleTelegramUpdate(update) {
  try {
    const msg = update && update.message;
    if (!msg || !msg.text || !msg.chat) return;

    const text = msg.text.trim();
    const chatId = String(msg.chat.id);

    if (text.startsWith('/start')) {
      const parts = text.split(/\s+/);
      const token = parts[1];

      if (!token) {
        await sendTelegramMessage(
          chatId,
          `أهلاً بك في بوت <b>منصة واجد (Waged)</b>!\n\nلربط حسابك تلقائياً، افتح لوحة التحكم في منصة واجد واضغط على زر <b>ربط تليجرام التلقائي</b>، أو استخدم معرفك الرقمي التالي للربط اليدوي:\n\n<code>${chatId}</code>`
        );
        return;
      }

      const user = await db.get('SELECT id, name FROM users WHERE telegram_link_token = ?', [token]);
      if (!user) {
        await sendTelegramMessage(
          chatId,
          'رمز الربط غير صالح أو منتهي الصلاحية. يرجى العودة إلى لوحة التحكم وإعادة المحاولة.'
        );
        return;
      }

      await db.run('UPDATE users SET telegram_chat_id = ? WHERE id = ?', [chatId, user.id]);

      await sendTelegramMessage(
        chatId,
        `تم ربط حسابك بنجاح يا <b>${escapeTgHtml(user.name)}</b>.\n\nستصلك من الآن تنبيهات فورية بالموقع الجغرافي ورابط المحادثة المباشرة بمجرد مسح أحد رموز واجد الخاصة بك.`
      );
    }
  } catch (err) {
    console.error('Telegram update error:', err.message);
  }
}

async function setupTelegramWebhook(appUrl) {
  if (!BOT_TOKEN || !appUrl || !appUrl.startsWith('https://')) return;
  try {
    const webhookUrl = `${appUrl.replace(/\/$/, '')}/api/telegram/webhook`;
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message'] })
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`Telegram Webhook registered: ${webhookUrl}`);
    }
  } catch (err) {
    console.warn('Failed to register Telegram webhook:', err.message);
  }
}

function startTelegramPolling() {
  if (!BOT_TOKEN || pollingActive) return;
  pollingActive = true;

  const poll = async () => {
    if (!pollingActive) return;
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=25`,
        { signal: AbortSignal.timeout(30000) }
      );
      const data = await res.json();
      if (data.ok && Array.isArray(data.result)) {
        for (const upd of data.result) {
          lastUpdateId = Math.max(lastUpdateId, upd.update_id);
          await handleTelegramUpdate(upd);
        }
      }
    } catch (err) {}
    if (pollingActive) {
      setTimeout(poll, 1000);
    }
  };

  poll();
}

function stopTelegramPolling() {
  pollingActive = false;
}

async function notifyOwnerScan(userId, itemName, lat, lng, chatUrl) {
  const user = await db.get('SELECT telegram_chat_id, name FROM users WHERE id = ?', [userId]);
  if (!user || !user.telegram_chat_id) return;

  const safeName = escapeTgHtml(itemName);
  let locationText = 'لم يتم مشاركته';
  let mapsUrl = '';
  if (lat && lng) {
    mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
    locationText = `<a href="${mapsUrl}">عرض الموقع على الخريطة</a>`;
  }

  const message = `<b>تنبيه مسح جديد — منصة واجد</b>

<b>الغرض:</b> ${safeName}
<b>الموقع الجغرافي:</b> ${locationText}
<b>التوقيت:</b> ${new Date().toLocaleTimeString('ar-EG')}

<a href="${chatUrl}">اضغط هنا لفتح المحادثة الفورية والرد بأمان</a>`;

  const inlineKeyboard = {
    inline_keyboard: [[{ text: 'فتح المحادثة الفورية', url: chatUrl }]]
  };

  if (mapsUrl) {
    inlineKeyboard.inline_keyboard[0].unshift({ text: 'فتح اللوكيشن', url: mapsUrl });
  }

  return sendTelegramMessage(user.telegram_chat_id, message, inlineKeyboard);
}

async function notifyOwnerMessage(userId, itemName, messageSnippet, chatUrl) {
  const user = await db.get('SELECT telegram_chat_id, name FROM users WHERE id = ?', [userId]);
  if (!user || !user.telegram_chat_id) return;

  const safeName = escapeTgHtml(itemName);
  const safeSnippet = escapeTgHtml(messageSnippet.slice(0, 300));

  const message = `<b>رسالة جديدة — منصة واجد</b>

<b>الغرض:</b> ${safeName}
<b>الرسالة:</b>
<i>"${safeSnippet}"</i>

<a href="${chatUrl}">اضغط هنا للرد المباشر</a>`;

  return sendTelegramMessage(user.telegram_chat_id, message, {
    inline_keyboard: [[{ text: 'الرد المباشر', url: chatUrl }]]
  });
}

async function notifyAdminsPaymentRequest(userName, planName, amount, senderAccount, adminUrl) {
  const admins = await db.all(
    "SELECT telegram_chat_id FROM users WHERE role IN ('super_admin', 'admin') AND telegram_chat_id IS NOT NULL"
  );
  if (!admins.length) return;

  const message = `<b>طلب تفعيل اشتراك جديد (إنستا باي)</b>

<b>المستخدم:</b> ${escapeTgHtml(userName)}
<b>الباقة:</b> ${escapeTgHtml(planName)}
<b>المبلغ:</b> ${amount} ج.م
<b>حساب/رقم المحول:</b> <code>${escapeTgHtml(senderAccount)}</code>

<a href="${adminUrl}">فتح لوحة التفعيل للمراجعة</a>`;

  await Promise.all(
    admins.map(a => sendTelegramMessage(a.telegram_chat_id, message))
  );
}

module.exports = {
  BOT_TOKEN,
  BOT_USERNAME,
  sendTelegramMessage,
  handleTelegramUpdate,
  setupTelegramWebhook,
  startTelegramPolling,
  stopTelegramPolling,
  notifyOwnerScan,
  notifyOwnerMessage,
  notifyAdminsPaymentRequest
};
