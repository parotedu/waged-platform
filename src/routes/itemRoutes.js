const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const db = require('../db');
const { requireAuth, getBaseUrl } = require('../auth');
const { getEffectivePlan } = require('../plans');

const router = express.Router();

// List all user items
router.get('/', requireAuth, async (req, res) => {
  try {
    const items = db.prepare(`
      SELECT 
        i.*,
        (SELECT COUNT(*) FROM scans WHERE item_id = i.id) as scan_count,
        (SELECT COUNT(*) FROM chats WHERE item_id = i.id) as chat_count,
        (SELECT MAX(created_at) FROM scans WHERE item_id = i.id) as last_scan
      FROM items i
      WHERE i.user_id = ?
      ORDER BY i.created_at DESC
    `).all(req.user.id);

    const baseUrl = getBaseUrl(req);

    const itemsWithQr = await Promise.all(items.map(async (item) => {
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
        scanUrl,
        qrDataUrl
      };
    }));

    res.json({ items: itemsWithQr });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب الأغراض' });
  }
});

// Create new item & QR (enforces plan quota)
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, category, custom_message, require_location } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'يرجى إدخال اسم الغرض أو وسيلة النقل' });
    }

    const user = db.prepare('SELECT plan_id, subscription_status, subscription_expires_at FROM users WHERE id = ?').get(req.user.id);
    const plan = getEffectivePlan(user);
    const currentCount = db.prepare('SELECT COUNT(*) as cnt FROM items WHERE user_id = ?').get(req.user.id).cnt;

    if (currentCount >= plan.maxItems) {
      return res.status(403).json({
        error: `لقد وصلت للحد الأقصى لباقتك الحالية (${plan.maxItems} رموز QR). قم بالترقية لإضافة المزيد من الأغراض.`,
        upgradeRequired: true,
        currentPlan: plan.id
      });
    }

    const publicCode = 'wgd_' + crypto.randomBytes(8).toString('hex');

    const stmt = db.prepare(`
      INSERT INTO items (user_id, public_code, name, category, custom_message, require_location)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(
      req.user.id,
      publicCode,
      name.trim(),
      category || 'car',
      custom_message ? custom_message.trim() : 'في حالة الركنة أو العثور على هذا الغرض، يرجى مراسلتي هنا بأمان وبسرية تامة.',
      require_location !== undefined ? (require_location ? 1 : 0) : 1
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

// Update item (name, category, message, status: active | lost | disabled)
router.put('/:id', requireAuth, (req, res) => {
  try {
    const { name, category, custom_message, status, require_location } = req.body;
    const item = db.prepare('SELECT id FROM items WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!item) {
      return res.status(404).json({ error: 'الغرض غير موجود' });
    }

    if (status && !['active', 'lost', 'disabled'].includes(status)) {
      return res.status(400).json({ error: 'حالة الغرض غير صالحة' });
    }

    db.prepare(`
      UPDATE items
      SET name = COALESCE(?, name),
          category = COALESCE(?, category),
          custom_message = COALESCE(?, custom_message),
          status = COALESCE(?, status),
          require_location = COALESCE(?, require_location)
      WHERE id = ? AND user_id = ?
    `).run(
      name ? name.trim() : null,
      category || null,
      custom_message !== undefined ? custom_message.trim() : null,
      status || null,
      require_location !== undefined ? (require_location ? 1 : 0) : null,
      req.params.id,
      req.user.id
    );

    res.json({ message: 'تم تحديث البيانات بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء التحديث' });
  }
});

// Delete item
router.delete('/:id', requireAuth, (req, res) => {
  try {
    const item = db.prepare('SELECT id FROM items WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!item) {
      return res.status(404).json({ error: 'الغرض غير موجود' });
    }

    db.prepare('DELETE FROM items WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    res.json({ message: 'تم حذف رمز الـ QR بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء الحذف' });
  }
});

// Get item scan history & location analytics
router.get('/:id/scans', requireAuth, (req, res) => {
  try {
    const item = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!item) {
      return res.status(404).json({ error: 'الغرض غير موجود' });
    }

    const user = db.prepare('SELECT plan_id, subscription_status, subscription_expires_at FROM users WHERE id = ?').get(req.user.id);
    const plan = getEffectivePlan(user);

    const scans = db.prepare(`
      SELECT id, session_id, latitude, longitude, accuracy, created_at
      FROM scans
      WHERE item_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(item.id, plan.maxScansView);

    res.json({ item, scans });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب سجل المسح' });
  }
});

module.exports = router;
