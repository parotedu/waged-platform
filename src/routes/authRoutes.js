const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { hashPassword, comparePassword, generateToken, getCookieOptions, requireAuth } = require('../auth');
const { getEffectivePlan, getSubscriptionTiming } = require('../plans');
const { syncExpiredSubscriptions } = require('../subscriptionSync');
const { BOT_TOKEN, BOT_USERNAME, sendTelegramMessage } = require('../telegram');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات دخول كثيرة، يرجى الانتظار 15 دقيقة والمحاولة مرة أخرى.' }
});

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Signup (always creates standard 'user' role)
router.post('/signup', authLimiter, async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'يرجى إدخال جميع الحقول المطلوبة' });
    }

    const cleanName = name.trim();
    const cleanEmail = email.toLowerCase().trim();

    if (cleanName.length < 2 || cleanName.length > 80) {
      return res.status(400).json({ error: 'الاسم يجب أن يكون بين حرفين و80 حرفاً' });
    }

    if (!EMAIL_REGEX.test(cleanEmail)) {
      return res.status(400).json({ error: 'صيغة البريد الإلكتروني غير صحيحة' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'كلمة المرور يجب أن لا تقل عن 6 أحرف' });
    }

    const existing = await db.get('SELECT id FROM users WHERE email = ?', [cleanEmail]);
    if (existing) {
      return res.status(400).json({ error: 'البريد الإلكتروني مسجل بالفعل' });
    }

    const passwordHash = hashPassword(password);
    const telegramLinkToken = crypto.randomBytes(16).toString('hex');

    const info = await db.run(
      `INSERT INTO users (name, email, password_hash, phone, role, telegram_link_token, plan_id, subscription_status)
       VALUES (?, ?, ?, ?, 'user', ?, 'free', 'active')`,
      [cleanName, cleanEmail, passwordHash, phone ? phone.trim() : null, telegramLinkToken]
    );

    const user = { id: info.lastInsertRowid, name: cleanName, email: cleanEmail, role: 'user', plan_id: 'free' };
    const token = generateToken(user);

    res.cookie('token', token, getCookieOptions(req));
    res.status(201).json({ message: 'تم إنشاء الحساب بنجاح', user, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ في الخادم' });
  }
});

// Login
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'يرجى إدخال البريد الإلكتروني وكلمة المرور' });
    }

    const user = await db.get('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (!user || !comparePassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    }

    const token = generateToken(user);
    res.cookie('token', token, getCookieOptions(req));

    const effectivePlan = getEffectivePlan(user);
    res.json({
      message: 'تم تسجيل الدخول بنجاح',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role || 'user',
        plan_id: effectivePlan.id
      },
      token
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ في الخادم' });
  }
});

// Logout
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'تم تسجيل الخروج' });
});

// Current User Details
router.get('/me', requireAuth, async (req, res) => {
  try {
    await syncExpiredSubscriptions(req.app.get('io'));

    const user = await db.get(
      `SELECT id, name, email, phone, role, telegram_chat_id, telegram_link_token, plan_id, subscription_status, subscription_expires_at, webhook_url, created_at
       FROM users WHERE id = ?`,
      [req.user.id]
    );

    if (!user) {
      return res.status(404).json({ error: 'المستخدم غير موجود' });
    }

    const plan = getEffectivePlan(user);
    const timing = getSubscriptionTiming(user);
    const botConfigured = Boolean(BOT_TOKEN && BOT_USERNAME);
    const telegramDeepLink = botConfigured && user.telegram_link_token
      ? `https://t.me/${BOT_USERNAME}?start=${user.telegram_link_token}`
      : null;

    res.json({
      user: {
        ...user,
        role: user.role || 'user',
        plan,
        timing,
        botConfigured,
        telegramBotUsername: BOT_USERNAME || null,
        telegramDeepLink
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ في جلب بيانات المستخدم' });
  }
});

// Update profile
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name || name.trim().length < 2) {
      return res.status(400).json({ error: 'يرجى إدخال اسم صحيح لا يقل عن حرفين' });
    }

    await db.run('UPDATE users SET name = ?, phone = ? WHERE id = ?', [
      name.trim(),
      phone ? phone.trim() : null,
      req.user.id
    ]);

    res.json({ message: 'تم تحديث بيانات الحساب بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء تحديث الحساب' });
  }
});

// Change password
router.put('/password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'كلمة المرور الجديدة يجب أن لا تقل عن 6 أحرف' });
    }

    const user = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (!user || !comparePassword(currentPassword, user.password_hash)) {
      return res.status(401).json({ error: 'كلمة المرور الحالية غير صحيحة' });
    }

    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), req.user.id]);
    res.json({ message: 'تم تغيير كلمة المرور بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء تغيير كلمة المرور' });
  }
});

// Link Telegram manually
router.post('/link-telegram', requireAuth, async (req, res) => {
  try {
    const { chatId } = req.body;
    if (!chatId || !/^-?\d+$/.test(chatId.trim())) {
      return res.status(400).json({ error: 'يرجى إدخال معرف شات رقمي صحيح (مثال: 123456789)' });
    }

    await db.run('UPDATE users SET telegram_chat_id = ? WHERE id = ?', [chatId.trim(), req.user.id]);
    res.json({ message: 'تم ربط حساب تليجرام بنجاح', telegram_chat_id: chatId.trim() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ في الربط' });
  }
});

// Test Telegram alert
router.post('/test-telegram', requireAuth, async (req, res) => {
  try {
    const user = await db.get('SELECT telegram_chat_id, name FROM users WHERE id = ?', [req.user.id]);
    if (!user || !user.telegram_chat_id) {
      return res.status(400).json({ error: 'حساب تليجرام غير مربوط بعد' });
    }

    const result = await sendTelegramMessage(
      user.telegram_chat_id,
      `<b>اختبار اتصال ناجح من منصة واجد</b>\nمرحباً ${user.name}، إشعاراتك الفورية تعمل الآن بنجاح.`
    );

    if (result && result.ok) {
      return res.json({ success: true, message: 'تم إرسال رسالة الاختبار إلى حسابك على تليجرام!' });
    }
    if (result && result.simulated) {
      return res.json({
        success: true,
        simulated: true,
        message: 'تم التحقق من معرفك. (فعّل TELEGRAM_BOT_TOKEN في البيئة لإرسال تنبيهات حقيقية عبر البوت)'
      });
    }
    return res.status(400).json({ error: result?.description || 'تعذر إرسال الرسالة إلى تليجرام' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء الاختبار' });
  }
});

// Unlink Telegram
router.post('/unlink-telegram', requireAuth, async (req, res) => {
  try {
    await db.run('UPDATE users SET telegram_chat_id = NULL WHERE id = ?', [req.user.id]);
    res.json({ message: 'تم إلغاء ربط تليجرام بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

module.exports = router;
