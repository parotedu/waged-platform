const db = require('./db');
const { getPlan } = require('./plans');
const { sendTelegramMessage } = require('./telegram');

let lastSyncAt = 0;

/**
 * Checks all active paid users and automatically locks/marks expired subscriptions.
 * Runs safely across both SQLite and PostgreSQL by comparing timestamps in JS.
 */
async function syncExpiredSubscriptions(io = null, force = false) {
  const now = Date.now();
  if (!force && now - lastSyncAt < 3000) {
    return [];
  }
  lastSyncAt = now;

  try {
    const candidates = await db.all(
      `SELECT id, name, plan_id, subscription_status, subscription_expires_at, telegram_chat_id
       FROM users
       WHERE plan_id != 'free'
         AND subscription_status = 'active'
         AND subscription_expires_at IS NOT NULL`
    );

    const expiredUsers = [];
    for (const u of candidates) {
      const expMs = new Date(u.subscription_expires_at).getTime();
      if (!Number.isNaN(expMs) && expMs <= now) {
        await db.run(
          "UPDATE users SET subscription_status = 'expired' WHERE id = ?",
          [u.id]
        );
        expiredUsers.push(u);

        const plan = getPlan(u.plan_id);
        if (io) {
          io.to(`owner_${u.id}`).emit('subscription_updated', {
            status: 'expired',
            planId: u.plan_id,
            planName: plan.name
          });
        }

        if (u.telegram_chat_id) {
          sendTelegramMessage(
            u.telegram_chat_id,
            `<b>انتهت مدة اشتراكك في منصة واجد</b>\n\nتم إيقاف مزايا <b>${plan.name}</b> تلقائياً لانتهاء المدة. يمكنك تجديد الاشتراك عبر إنستا باي من لوحة التحكم لإعادة التفعيل فوراً.`
          ).catch(() => {});
        }
      }
    }

    return expiredUsers;
  } catch (err) {
    console.error('Error syncing expired subscriptions:', err.message);
    return [];
  }
}

module.exports = { syncExpiredSubscriptions };
