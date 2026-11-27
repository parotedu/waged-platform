const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { hashPassword, requireAuth, requireAdmin, requireSuperAdmin } = require('../auth');
const { PLANS, getSubscriptionTiming } = require('../plans');
const { syncExpiredSubscriptions } = require('../subscriptionSync');
const { sendTelegramMessage } = require('../telegram');

const router = express.Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.use(requireAuth, requireAdmin);

// Overview metrics & current admin role
router.get('/overview', async (req, res) => {
  try {
    await syncExpiredSubscriptions(req.app.get('io'), true);

    const [pendingRow, approvedRow, users] = await Promise.all([
      db.get("SELECT COUNT(*) as cnt FROM subscription_requests WHERE status = 'pending'"),
      db.get("SELECT COUNT(*) as cnt FROM subscription_requests WHERE status = 'approved'"),
      db.all('SELECT id, plan_id, subscription_status, subscription_expires_at FROM users')
    ]);

    let activePaidUsers = 0;
    let expiringSoonUsers = 0;
    let expiredUsers = 0;

    for (const u of users) {
      const timing = getSubscriptionTiming(u);
      if (timing.state === 'active') activePaidUsers += 1;
      else if (timing.state === 'expiring_soon') {
        activePaidUsers += 1;
        expiringSoonUsers += 1;
      } else if (timing.state === 'expired') {
        expiredUsers += 1;
      }
    }

    res.json({
      admin: {
        id: req.adminUser.id,
        name: req.adminUser.name,
        email: req.adminUser.email,
        role: req.adminUser.role,
        isSuperAdmin: req.adminUser.role === 'super_admin'
      },
      stats: {
        pendingRequests: Number(pendingRow?.cnt || 0),
        approvedRequests: Number(approvedRow?.cnt || 0),
        totalUsers: users.length,
        activePaidUsers,
        expiringSoonUsers,
        expiredUsers
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في جلب إحصائيات الإدارة' });
  }
});

// List subscription InstaPay payment requests
router.get('/requests', async (req, res) => {
  try {
    const status = req.query.status || 'all';
    let whereClause = '';
    const params = [];

    if (['pending', 'approved', 'rejected'].includes(status)) {
      whereClause = 'WHERE r.status = ?';
      params.push(status);
    }

    const requests = await db.all(
      `SELECT 
        r.*,
        u.name as user_name,
        u.email as user_email,
        u.phone as user_phone,
        u.plan_id as current_user_plan,
        rev.name as reviewer_name
      FROM subscription_requests r
      JOIN users u ON r.user_id = u.id
      LEFT JOIN users rev ON r.reviewed_by = rev.id
      ${whereClause}
      ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.created_at DESC
      LIMIT 150`,
      params
    );

    res.json({ requests });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في جلب طلبات التفعيل' });
  }
});

// Approve InstaPay payment request and activate user's subscription
router.post('/requests/:id/approve', async (req, res) => {
  try {
    const requestId = req.params.id;
    const { adminNote } = req.body || {};

    const reqRow = await db.get('SELECT * FROM subscription_requests WHERE id = ?', [requestId]);
    if (!reqRow) {
      return res.status(404).json({ error: 'طلب التفعيل غير موجود' });
    }
    if (reqRow.status !== 'pending') {
      return res.status(400).json({ error: 'تمت مراجعة هذا الطلب مسبقاً' });
    }

    const plan = PLANS[reqRow.plan_id];
    if (!plan) {
      return res.status(400).json({ error: 'الباقة المطلوبة غير صالحة' });
    }

    const durationDays = reqRow.billing_cycle === 'yearly' ? 365 : 30;
    const targetUser = await db.get(
      'SELECT plan_id, subscription_status, subscription_expires_at FROM users WHERE id = ?',
      [reqRow.user_id]
    );
    const now = Date.now();
    const curExp = targetUser?.subscription_expires_at ? new Date(targetUser.subscription_expires_at).getTime() : 0;
    const baseMs = (targetUser?.plan_id === plan.id && targetUser?.subscription_status === 'active' && curExp > now)
      ? curExp
      : now;
    const expiresAt = new Date(baseMs + durationDays * 24 * 60 * 60 * 1000).toISOString();
    const refCode = 'ACT-' + crypto.randomBytes(4).toString('hex').toUpperCase();

    await db.tx(async (tx) => {
      await tx.run(
        `UPDATE subscription_requests
         SET status = 'approved', admin_note = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [adminNote ? adminNote.trim() : 'تم التحقق من التحويل وتفعيل الاشتراك', req.adminUser.id, requestId]
      );

      await tx.run(
        `UPDATE users
         SET plan_id = ?, subscription_status = 'active', subscription_expires_at = ?
         WHERE id = ?`,
        [plan.id, expiresAt, reqRow.user_id]
      );

      await tx.run(
        `INSERT INTO subscription_logs (user_id, plan_id, amount, currency, billing_cycle, status, reference_code)
         VALUES (?, ?, ?, ?, ?, 'paid', ?)`,
        [reqRow.user_id, plan.id, reqRow.amount, reqRow.currency || 'EGP', reqRow.billing_cycle, refCode]
      );
    });

    const user = await db.get('SELECT telegram_chat_id, name FROM users WHERE id = ?', [reqRow.user_id]);
    if (user && user.telegram_chat_id) {
      sendTelegramMessage(
        user.telegram_chat_id,
        `<b>تم تفعيل اشتراكك في منصة واجد بنجاح</b>\n\nالباقة المفعلة: <b>${plan.name}</b>\nيمكنك الآن الاستفادة من كافة المميزات في لوحة التحكم.`
      ).catch(console.error);
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`owner_${reqRow.user_id}`).emit('subscription_updated', {
        status: 'approved',
        planId: plan.id,
        planName: plan.name,
        expiresAt
      });
    }

    res.json({
      success: true,
      message: `تم تأكيد التحويل وتفعيل ${plan.name} للمستخدم بنجاح`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء تفعيل الطلب' });
  }
});

// Reject InstaPay payment request
router.post('/requests/:id/reject', async (req, res) => {
  try {
    const requestId = req.params.id;
    const { adminNote } = req.body || {};

    const reqRow = await db.get('SELECT * FROM subscription_requests WHERE id = ?', [requestId]);
    if (!reqRow) {
      return res.status(404).json({ error: 'طلب التفعيل غير موجود' });
    }
    if (reqRow.status !== 'pending') {
      return res.status(400).json({ error: 'تمت مراجعة هذا الطلب مسبقاً' });
    }

    const reason = adminNote && adminNote.trim()
      ? adminNote.trim()
      : 'تعذر التحقق من وصول مبلغ التحويل على إنستا باي';

    await db.run(
      `UPDATE subscription_requests
       SET status = 'rejected', admin_note = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [reason, req.adminUser.id, requestId]
    );

    const io = req.app.get('io');
    if (io) {
      io.to(`owner_${reqRow.user_id}`).emit('subscription_updated', {
        status: 'rejected',
        reason
      });
    }

    res.json({ success: true, message: 'تم رفض الطلب وتسجيل السبب' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء رفض الطلب' });
  }
});

// Subscriptions tracking endpoint with remaining time & state filters
router.get('/subscriptions', async (req, res) => {
  try {
    await syncExpiredSubscriptions(req.app.get('io'), true);

    const filter = req.query.filter || 'all';
    const q = (req.query.q || '').trim().toLowerCase();

    let sql = `
      SELECT 
        u.id, u.name, u.email, u.phone, u.role, u.plan_id, u.subscription_status, u.subscription_expires_at, u.created_at,
        (SELECT COUNT(*) FROM items WHERE user_id = u.id) as items_count
      FROM users u
    `;
    const params = [];
    if (q) {
      sql += " WHERE LOWER(u.name) LIKE ? OR LOWER(u.email) LIKE ? OR COALESCE(u.phone, '') LIKE ?";
      const pattern = `%${q}%`;
      params.push(pattern, pattern, pattern);
    }

    const rows = await db.all(sql, params);

    const orderWeight = { expired: 0, expiring_soon: 1, active: 2, free: 3 };
    let subscriptions = rows.map(u => {
      const timing = getSubscriptionTiming(u);
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        role: u.role || 'user',
        plan_id: u.plan_id || 'free',
        subscription_status: u.subscription_status || 'active',
        subscription_expires_at: u.subscription_expires_at,
        items_count: Number(u.items_count || 0),
        timing
      };
    });

    if (['active', 'expiring_soon', 'expired', 'free'].includes(filter)) {
      subscriptions = subscriptions.filter(s => s.timing.state === filter);
    }

    subscriptions.sort((a, b) => {
      const wDiff = (orderWeight[a.timing.state] ?? 9) - (orderWeight[b.timing.state] ?? 9);
      if (wDiff !== 0) return wDiff;
      if (a.timing.remainingMs !== null && b.timing.remainingMs !== null) {
        return a.timing.remainingMs - b.timing.remainingMs;
      }
      return b.id - a.id;
    });

    res.json({ subscriptions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في جلب سجل الاشتراكات' });
  }
});

// List users for manual inspection/activation
router.get('/users', async (req, res) => {
  try {
    await syncExpiredSubscriptions(req.app.get('io'), true);

    const q = (req.query.q || '').trim().toLowerCase();
    let sql = `
      SELECT 
        u.id, u.name, u.email, u.phone, u.role, u.plan_id, u.subscription_status, u.subscription_expires_at, u.created_at,
        (SELECT COUNT(*) FROM items WHERE user_id = u.id) as items_count
      FROM users u
    `;
    const params = [];
    if (q) {
      sql += " WHERE LOWER(u.name) LIKE ? OR LOWER(u.email) LIKE ? OR COALESCE(u.phone, '') LIKE ?";
      const pattern = `%${q}%`;
      params.push(pattern, pattern, pattern);
    }
    sql += ' ORDER BY u.created_at DESC LIMIT 120';

    const rows = await db.all(sql, params);
    const users = rows.map(u => ({
      ...u,
      items_count: Number(u.items_count || 0),
      timing: getSubscriptionTiming(u)
    }));
    res.json({ users });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في جلب قائمة المستخدمين' });
  }
});

// Extend a user's subscription by N days (preserves remaining time if active, or restarts from now if expired)
router.post('/users/:id/extend', async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const days = Number(req.body.days || 30);
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      return res.status(400).json({ error: 'عدد الأيام يجب أن يكون بين 1 و 3650 يوماً' });
    }

    const user = await db.get(
      'SELECT id, name, plan_id, subscription_status, subscription_expires_at, telegram_chat_id FROM users WHERE id = ?',
      [targetId]
    );
    if (!user) {
      return res.status(404).json({ error: 'المستخدم غير موجود' });
    }

    const requestedPlanId = req.body.planId;
    const targetPlanId = requestedPlanId && PLANS[requestedPlanId] && requestedPlanId !== 'free'
      ? requestedPlanId
      : (user.plan_id && user.plan_id !== 'free' ? user.plan_id : 'pro');
    const plan = PLANS[targetPlanId];

    const now = Date.now();
    const curExp = user.subscription_expires_at ? new Date(user.subscription_expires_at).getTime() : 0;
    const baseMs = (user.subscription_status === 'active' && !Number.isNaN(curExp) && curExp > now)
      ? curExp
      : now;
    const newExpiresAt = new Date(baseMs + days * 24 * 60 * 60 * 1000).toISOString();
    const refCode = 'EXT-' + crypto.randomBytes(4).toString('hex').toUpperCase();

    await db.tx(async (tx) => {
      await tx.run(
        "UPDATE users SET plan_id = ?, subscription_status = 'active', subscription_expires_at = ? WHERE id = ?",
        [plan.id, newExpiresAt, targetId]
      );
      await tx.run(
        `INSERT INTO subscription_logs (user_id, plan_id, amount, currency, billing_cycle, status, reference_code)
         VALUES (?, ?, 0, 'EGP', ?, 'paid', ?)`,
        [targetId, plan.id, `${days}d`, refCode]
      );
    });

    const io = req.app.get('io');
    if (io) {
      io.to(`owner_${targetId}`).emit('subscription_updated', {
        status: 'approved',
        planId: plan.id,
        planName: plan.name,
        expiresAt: newExpiresAt
      });
    }

    if (user.telegram_chat_id) {
      sendTelegramMessage(
        user.telegram_chat_id,
        `<b>تم تمديد اشتراكك في منصة واجد</b>\n\nالباقة: <b>${plan.name}</b>\nالمدة المضافة: <b>${days} يوم</b>`
      ).catch(() => {});
    }

    res.json({
      success: true,
      message: `تم تمديد باقة (${plan.name}) للمستخدم (${user.name}) بمقدار ${days} يوماً`,
      expiresAt: newExpiresAt
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء تمديد الاشتراك' });
  }
});

// Immediately expire / lock a user's paid subscription
router.post('/users/:id/expire', async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const user = await db.get('SELECT id, name, plan_id FROM users WHERE id = ?', [targetId]);
    if (!user) {
      return res.status(404).json({ error: 'المستخدم غير موجود' });
    }
    if (user.plan_id === 'free') {
      return res.status(400).json({ error: 'المستخدم على الباقة المجانية بالفعل' });
    }

    const nowIso = new Date().toISOString();
    await db.run(
      "UPDATE users SET subscription_status = 'expired', subscription_expires_at = ? WHERE id = ?",
      [nowIso, targetId]
    );

    const io = req.app.get('io');
    if (io) {
      io.to(`owner_${targetId}`).emit('subscription_updated', {
        status: 'expired',
        planId: user.plan_id
      });
    }

    res.json({ success: true, message: `تم قفل وإغلاق اشتراك (${user.name}) بنجاح` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء قفل الاشتراك' });
  }
});

// Manually set a user's plan and duration
router.post('/users/:id/plan', async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const { planId, days = 30 } = req.body;
    const plan = PLANS[planId];

    if (!plan) {
      return res.status(400).json({ error: 'الباقة غير صالحة' });
    }

    const user = await db.get('SELECT id, role FROM users WHERE id = ?', [targetId]);
    if (!user) {
      return res.status(404).json({ error: 'المستخدم غير موجود' });
    }

    const expiresAt = plan.id === 'free'
      ? null
      : new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000).toISOString();

    await db.run(
      "UPDATE users SET plan_id = ?, subscription_status = 'active', subscription_expires_at = ? WHERE id = ?",
      [plan.id, expiresAt, targetId]
    );

    const io = req.app.get('io');
    if (io) {
      io.to(`owner_${targetId}`).emit('subscription_updated', {
        status: 'approved',
        planId: plan.id,
        planName: plan.name,
        expiresAt
      });
    }

    res.json({ success: true, message: `تم تحديث باقة المستخدم إلى ${plan.name}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء تحديث باقة المستخدم' });
  }
});

// ============================================================
// Super Admin Only: Manage Activation Admins
// ============================================================

router.get('/admins', requireSuperAdmin, async (req, res) => {
  try {
    const admins = await db.all(
      `SELECT id, name, email, phone, role, created_at
       FROM users
       WHERE role IN ('super_admin', 'admin')
       ORDER BY CASE WHEN role = 'super_admin' THEN 0 ELSE 1 END, created_at ASC`
    );
    res.json({ admins });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في جلب قائمة المسؤولين' });
  }
});

router.post('/admins', requireSuperAdmin, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!email || !EMAIL_REGEX.test(email.toLowerCase().trim())) {
      return res.status(400).json({ error: 'يرجى إدخال بريد إلكتروني صحيح' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const existing = await db.get('SELECT id, name, email, role FROM users WHERE email = ?', [cleanEmail]);

    if (existing) {
      if (existing.role === 'super_admin') {
        return res.status(400).json({ error: 'هذا الحساب هو المسؤول الرئيسي بالفعل' });
      }
      if (existing.role === 'admin') {
        return res.status(400).json({ error: 'هذا الحساب مضاف كمسؤول تفعيل بالفعل' });
      }

      await db.run("UPDATE users SET role = 'admin' WHERE id = ?", [existing.id]);
      return res.status(200).json({
        success: true,
        message: `تمت ترقية الحساب (${existing.email}) إلى مسؤول تفعيل حسابات بنجاح`,
        admin: { id: existing.id, name: existing.name, email: existing.email, role: 'admin' }
      });
    }

    if (!name || name.trim().length < 2) {
      return res.status(400).json({ error: 'هذا البريد غير مسجل مسبقاً؛ يرجى إدخال الاسم وكلمة المرور لإنشاء حساب المسؤول' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'كلمة المرور يجب أن لا تقل عن 6 أحرف' });
    }

    const passwordHash = hashPassword(password);
    const linkToken = crypto.randomBytes(16).toString('hex');

    const info = await db.run(
      `INSERT INTO users (name, email, password_hash, role, telegram_link_token, plan_id, subscription_status)
       VALUES (?, ?, ?, 'admin', ?, 'free', 'active')`,
      [name.trim(), cleanEmail, passwordHash, linkToken]
    );

    res.status(201).json({
      success: true,
      message: `تم إنشاء حساب المسؤول (${cleanEmail}) وإضافته بنجاح`,
      admin: { id: info.lastInsertRowid, name: name.trim(), email: cleanEmail, role: 'admin' }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء إضافة المسؤول' });
  }
});

router.delete('/admins/:id', requireSuperAdmin, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    if (targetId === req.adminUser.id) {
      return res.status(400).json({ error: 'لا يمكن إزالة صلاحية الحساب الرئيسي' });
    }

    const target = await db.get('SELECT id, role FROM users WHERE id = ?', [targetId]);
    if (!target) {
      return res.status(404).json({ error: 'المستخدم غير موجود' });
    }
    if (target.role === 'super_admin') {
      return res.status(403).json({ error: 'لا يمكن إزالة صلاحية المسؤول الرئيسي' });
    }

    await db.run("UPDATE users SET role = 'user' WHERE id = ?", [targetId]);
    res.json({ success: true, message: 'تمت إزالة صلاحية المسؤول بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء إزالة المسؤول' });
  }
});

module.exports = router;
