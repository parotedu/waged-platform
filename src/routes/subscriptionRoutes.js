const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../auth');
const { PLANS, getEffectivePlan } = require('../plans');

const router = express.Router();

// Get all plans (public)
router.get('/plans', (req, res) => {
  res.json({ plans: Object.values(PLANS) });
});

// Get current user's subscription details & usage
router.get('/me', requireAuth, (req, res) => {
  try {
    const user = db.prepare(`
      SELECT id, plan_id, subscription_status, subscription_expires_at, webhook_url
      FROM users WHERE id = ?
    `).get(req.user.id);

    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });

    const plan = getEffectivePlan(user);
    const itemCount = db.prepare('SELECT COUNT(*) as cnt FROM items WHERE user_id = ?').get(req.user.id).cnt;
    const invoices = db.prepare(`
      SELECT id, plan_id, amount, currency, billing_cycle, status, reference_code, created_at
      FROM subscription_logs
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `).all(req.user.id);

    res.json({
      currentPlan: plan,
      subscriptionStatus: user.subscription_status || 'active',
      expiresAt: user.subscription_expires_at,
      webhookUrl: user.webhook_url || '',
      usage: {
        itemsCount: itemCount,
        maxItems: plan.maxItems
      },
      invoices
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب بيانات الاشتراك' });
  }
});

// Upgrade or change subscription plan
router.post('/subscribe', requireAuth, (req, res) => {
  try {
    const { planId, billingCycle = 'monthly', promoCode } = req.body;
    const targetPlan = PLANS[planId];

    if (!targetPlan) {
      return res.status(400).json({ error: 'الباقة المختارة غير صالحة' });
    }

    let amount = billingCycle === 'yearly' ? targetPlan.priceYearly : targetPlan.priceMonthly;
    if (promoCode && promoCode.trim().toUpperCase() === 'PAROT100' && amount > 0) {
      amount = 0;
    }

    const durationDays = billingCycle === 'yearly' ? 365 : 30;
    const expiresAt = targetPlan.id === 'free'
      ? null
      : new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();

    const refCode = 'INV-' + crypto.randomBytes(4).toString('hex').toUpperCase();

    const updateTx = db.transaction(() => {
      db.prepare(`
        UPDATE users
        SET plan_id = ?,
            subscription_status = 'active',
            subscription_expires_at = ?
        WHERE id = ?
      `).run(targetPlan.id, expiresAt, req.user.id);

      db.prepare(`
        INSERT INTO subscription_logs (user_id, plan_id, amount, currency, billing_cycle, status, reference_code)
        VALUES (?, ?, ?, 'EGP', ?, 'paid', ?)
      `).run(req.user.id, targetPlan.id, amount, billingCycle, refCode);
    });

    updateTx();

    res.json({
      success: true,
      message: `تم تفعيل ${targetPlan.name} بنجاح!`,
      plan: targetPlan,
      referenceCode: refCode,
      expiresAt
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء تفعيل الاشتراك' });
  }
});

// Update Webhook URL (Pro / Business feature)
router.post('/webhook', requireAuth, (req, res) => {
  try {
    const { webhookUrl } = req.body;
    const user = db.prepare('SELECT plan_id, subscription_status, subscription_expires_at FROM users WHERE id = ?').get(req.user.id);
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

    db.prepare('UPDATE users SET webhook_url = ? WHERE id = ?').run(webhookUrl ? webhookUrl.trim() : null, req.user.id);
    res.json({ success: true, message: 'تم حفظ رابط الـ Webhook بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء حفظ الإعدادات' });
  }
});

module.exports = router;
