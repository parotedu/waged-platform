const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const db = require('../db');
const { requireAuth, getBaseUrl } = require('../auth');
const { getEffectivePlan } = require('../plans');
const { syncExpiredSubscriptions } = require('../subscriptionSync');

const router = express.Router();

// List all user items (marks items beyond effective plan limit as lockedByExpiration)
router.get('/', requireAuth, async (req, res) => {
  try {
    await syncExpiredSubscriptions(req.app.get('io'));

    const user = await db.get(
      'SELECT plan_id, subscription_status, subscription_expires_at FROM users WHERE id = ?',
      [req.user.id]
    );
    const effectivePlan = getEffectivePlan(user);

    const itemsAsc = await db.all(
      `SELECT 
        i.*,
        (SELECT COUNT(*) FROM scans WHERE item_id = i.id) as scan_count,
        (SELECT COUNT(*) FROM chats WHERE item_id = i.id) as chat_count,
        (SELECT MAX(created_at) FROM scans WHERE item_id = i.id) as last_scan
      FROM items i
      WHERE i.user_id = ?
      ORDER BY i.id ASC`,
      [req.user.id]
    );

    const baseUrl = getBaseUrl(req);

    const enrichedAsc = await Promise.all(itemsAsc.map(async (item, idx) => {
      const scanUrl = `${baseUrl}/scan.html?code=${item.public_code}`;
      const qrDataUrl = await QRCode.toDataURL(scanUrl, {
        width: 360,
        margin: 2,
        errorCorrectionLevel: 'H',
        color: {
          dark: '#0f172a',
          light: '#ffffff'
        }
      });
      return {
        ...item,
        scan_count: Number(item.scan_count || 0),
        chat_count: Number(item.chat_count || 0),
        lockedByExpiration: idx >= effectivePlan.maxItems,
        scanUrl,
        qrDataUrl
      };
    }));

    // Return newest first for UI
    res.json({ items: enrichedAsc.reverse() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب الأغراض' });
  }
});

// Create new item & QR (enforces effective plan quota)
router.post('/', requireAuth, async (req, res) => {
  try {
    await syncExpiredSubscriptions(req.app.get('io'));

    const { name, category, custom_message, require_location } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'يرجى إدخال اسم الغرض أو وسيلة النقل' });
    }

    const user = await db.get(
      'SELECT plan_id, subscription_status, subscription_expires_at FROM users WHERE id = ?',
      [req.user.id]
    );
    const plan = getEffectivePlan(user);
    const countRow = await db.get('SELECT COUNT(*) as cnt FROM items WHERE user_id = ?', [req.user.id]);
    const currentCount = Number(countRow?.cnt || 0);

    if (currentCount >= plan.maxItems) {
      return res.status(403).json({
        error: user?.subscription_status === 'expired'
          ? `انتهت مدة اشتراكك وتم تقييد الحد إلى ${plan.maxItems} رموز. جدّد اشتراكك لإضافة المزيد.`
          : `لقد وصلت للحد الأقصى لباقتك الحالية (${plan.maxItems} رموز QR). قم بالترقية لإضافة المزيد من الأغراض.`,
        upgradeRequired: true,
        currentPlan: plan.id
      });
    }

    const publicCode = 'wgd_' + crypto.randomBytes(8).toString('hex');

    const info = await db.run(
      `INSERT INTO items (user_id, public_code, name, category, custom_message, require_location)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        publicCode,
        name.trim(),
        category || 'car',
        custom_message ? custom_message.trim() : 'في حالة الركنة أو العثور على هذا الغرض، يرجى مراسلتي هنا بأمان وبسرية تامة.',
        require_location !== undefined ? (require_location ? 1 : 0) : 1
      ]
    );

    const baseUrl = getBaseUrl(req);
    const scanUrl = `${baseUrl}/scan.html?code=${publicCode}`;
    const qrDataUrl = await QRCode.toDataURL(scanUrl, {
      width: 400,
      margin: 2,
      errorCorrectionLevel: 'H',
      color: {
        dark: '#0f172a',
        light: '#ffffff'
      }
    });

    res.status(201).json({
      message: 'تم إنشاء رمز الـ QR بنجاح',
      item: {
        id: info.lastInsertRowid,
        public_code: publicCode,
        name: name.trim(),
        category: category || 'car',
        status: 'active',
        scanUrl,
        qrDataUrl
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء إنشاء الغرض' });
  }
});

// Update item
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { name, category, custom_message, status, require_location } = req.body;
    const item = await db.get('SELECT * FROM items WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!item) {
      return res.status(404).json({ error: 'الغرض غير موجود' });
    }

    if (status && !['active', 'lost', 'disabled'].includes(status)) {
      return res.status(400).json({ error: 'حالة الغرض غير صالحة' });
    }

    await db.run(
      `UPDATE items
       SET name = ?, category = ?, custom_message = ?, status = ?, require_location = ?
       WHERE id = ? AND user_id = ?`,
      [
        name ? name.trim() : item.name,
        category || item.category,
        custom_message !== undefined ? custom_message.trim() : item.custom_message,
        status || item.status,
        require_location !== undefined ? (require_location ? 1 : 0) : item.require_location,
        req.params.id,
        req.user.id
      ]
    );

    res.json({ message: 'تم تحديث البيانات بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء التحديث' });
  }
});

// Delete item
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const item = await db.get('SELECT id FROM items WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!item) {
      return res.status(404).json({ error: 'الغرض غير موجود' });
    }

    await db.run('DELETE FROM items WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ message: 'تم حذف رمز الـ QR بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء الحذف' });
  }
});

// Get item scan history
router.get('/:id/scans', requireAuth, async (req, res) => {
  try {
    const item = await db.get('SELECT * FROM items WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!item) {
      return res.status(404).json({ error: 'الغرض غير موجود' });
    }

    const user = await db.get(
      'SELECT plan_id, subscription_status, subscription_expires_at FROM users WHERE id = ?',
      [req.user.id]
    );
    const plan = getEffectivePlan(user);

    const scans = await db.all(
      `SELECT id, session_id, latitude, longitude, accuracy, created_at
       FROM scans
       WHERE item_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [item.id, plan.maxScansView]
    );

    res.json({ item, scans });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب سجل المسح' });
  }
});

module.exports = router;
