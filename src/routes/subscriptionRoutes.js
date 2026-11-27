const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { requireAuth, getBaseUrl } = require('../auth');
const { PLANS, getEffectivePlan } = require('../plans');
const { notifyAdminsPaymentRequest } = require('../telegram');

const router = express.Router();

function getPaymentConfig() {
  return {
    method: 'instapay',
    label: 'InstaPay (إنستا باي)',
    targetNumber: config.INSTAPAY_NUMBER,
    accountName: config.INSTAPAY_ACCOUNT_NAME,
    slaHours: config.VERIFICATION_SLA_HOURS
  };
}

// Get all plans + InstaPay configuration (public)
router.get('/plans', (req, res) => {
  res.json({
    plans: Object.values(PLANS),
    paymentConfig: getPaymentConfig()
  });
});

// Get current user's subscription, usage, InstaPay requests, and invoices
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await db.get(
      `SELECT id, plan_id, subscription_status, subscription_expires_at, webhook_url
       FROM users WHERE id = ?`,
      [req.user.id]
    );

    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });

    const plan = getEffectivePlan(user);
    const countRow = await db.get('SELECT COUNT(*) as cnt FROM items WHERE user_id = ?', [req.user.id]);
    const itemCount = Number(countRow?.cnt || 0);

    const invoices = await db.all(
      `SELECT id, plan_id, amount, currency, billing_cycle, status, reference_code, created_at
       FROM subscription_logs
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 20`,
      [req.user.id]
    );

    const requests = await db.all(
      `SELECT id, plan_id, billing_cycle, amount, currency, payment_method, target_number, sender_account, reference_note, status, admin_note, created_at, reviewed_at
       FROM subscription_requests
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 10`,
      [req.user.id]
    );

    const pendingRequest = requests.find(r => r.status === 'pending') || null;

    res.json({
      currentPlan: plan,
      subscriptionStatus: user.subscription_status || 'active',
      expiresAt: user.subscription_expires_at,
      webhookUrl: user.webhook_url || '',
      usage: {
        itemsCount: itemCount,
        maxItems: plan.maxItems
      },
      paymentConfig: getPaymentConfig(),
      pendingRequest,
      requests,
      invoices
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب بيانات الاشتراك' });
  }
});

// Submit InstaPay payment notification (requires admin review within 24h)
router.post('/request', requireAuth, async (req, res) => {
  try {
    const { planId, billingCycle = 'monthly', senderAccount, referenceNote } = req.body;
    const targetPlan = PLANS[planId];

    if (!targetPlan || targetPlan.id === 'free') {
      return res.status(400).json({ error: 'يرجى اختيار باقة مدفوعة صالحة (الاحترافية أو الأعمال)' });
    }

    if (!['monthly', 'yearly'].includes(billingCycle)) {
      return res.status(400).json({ error: 'دورة الدفع غير صالحة' });
    }

    if (!senderAccount || senderAccount.trim().length < 4) {
      return res.status(400).json({ error: 'يرجى إدخال رقم الهاتف أو حساب إنستا باي المحول منه' });
    }

    const existingPending = await db.get(
      "SELECT id FROM subscription_requests WHERE user_id = ? AND status = 'pending'",
      [req.user.id]
    );
    if (existingPending) {
      return res.status(400).json({
        error: 'لديك طلب تفعيل قيد المراجعة بالفعل. سيتم التأكد وتفعيل حسابك خلال 24 ساعة.'
      });
    }

    const amount = billingCycle === 'yearly' ? targetPlan.priceYearly : targetPlan.priceMonthly;
    const cleanSender = senderAccount.trim().slice(0, 100);
    const cleanNote = referenceNote ? referenceNote.trim().slice(0, 300) : null;
    const refCode = 'INS-' + crypto.randomBytes(4).toString('hex').toUpperCase();

    const result = await db.tx(async (tx) => {
      const reqInfo = await tx.run(
        `INSERT INTO subscription_requests
         (user_id, plan_id, billing_cycle, amount, currency, payment_method, target_number, sender_account, reference_note, status)
         VALUES (?, ?, ?, ?, 'EGP', 'instapay', ?, ?, ?, 'pending')`,
        [req.user.id, targetPlan.id, billingCycle, amount, config.INSTAPAY_NUMBER, cleanSender, cleanNote]
      );

      await tx.run(
        `INSERT INTO subscription_logs (user_id, plan_id, amount, currency, billing_cycle, status, reference_code)
         VALUES (?, ?, ?, 'EGP', ?, 'pending', ?)`,
        [req.user.id, targetPlan.id, amount, billingCycle, refCode]
      );

      return reqInfo;
    });

    const userRow = await db.get('SELECT name FROM users WHERE id = ?', [req.user.id]);
    const baseUrl = getBaseUrl(req);
    const adminUrl = `${baseUrl}/admin.html`;

    const io = req.app.get('io');
    if (io) {
      io.to('admins_room').emit('admin_payment_request', {
        requestId: result.lastInsertRowid,
        userName: userRow?.name || req.user.name,
        planName: targetPlan.name,
        amount,
        senderAccount: cleanSender,
        createdAt: new Date().toISOString()
      });
    }

    notifyAdminsPaymentRequest(
      userRow?.name || req.user.name,
      targetPlan.name,
      amount,
      cleanSender,
      adminUrl
    ).catch(console.error);

    res.status(201).json({
      success: true,
      message: `تم إرسال إشعار التحويل على الرقم ${config.INSTAPAY_NUMBER} بنجاح. سيتم التأكد وتفعيل باقتك خلال 24 ساعة.`,
      request: {
        id: result.lastInsertRowid,
        plan_id: targetPlan.id,
        billing_cycle: billingCycle,
        amount,
        target_number: config.INSTAPAY_NUMBER,
        sender_account: cleanSender,
        status: 'pending'
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء إرسال إشعار التحويل' });
  }
});

// Downgrade back to free plan
router.post('/downgrade', requireAuth, async (req, res) => {
  try {
    await db.run(
      "UPDATE users SET plan_id = 'free', subscription_status = 'active', subscription_expires_at = NULL WHERE id = ?",
      [req.user.id]
    );
    res.json({ success: true, message: 'تم التحويل إلى الباقة المجانية بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء تحديث الباقة' });
  }
});

// Update Webhook URL (Pro / Business feature)
router.post('/webhook', requireAuth, async (req, res) => {
  try {
    const { webhookUrl } = req.body;
    const user = await db.get(
      'SELECT plan_id, subscription_status, subscription_expires_at FROM users WHERE id = ?',
      [req.user.id]
    );
    const plan = getEffectivePlan(user);

    if (!plan.capabilities.webhookAlerts) {
      return res.status(403).json({ error: 'ميزة الـ Webhook متاحة فقط في الباقة الاحترافية وباقة الأعمال' });
    }

    if (webhookUrl && webhookUrl.trim()) {
      try {
        const parsed = new URL(webhookUrl.trim());
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return res.status(400).json({ error: 'رابط الـ Webhook يجب أن يبدأ بـ http أو https' });
        }
      } catch {
        return res.status(400).json({ error: 'رابط الـ Webhook غير صالح' });
      }
    }

    await db.run('UPDATE users SET webhook_url = ? WHERE id = ?', [webhookUrl ? webhookUrl.trim() : null, req.user.id]);
    res.json({ success: true, message: 'تم حفظ رابط الـ Webhook بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء حفظ الإعدادات' });
  }
});

module.exports = router;
