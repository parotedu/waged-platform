const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

async function waitForServer(url, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('Test server failed to become healthy in time');
}

async function runTests() {
  console.log('--- بدء الاختبارات الشاملة لمنصة واجد (Isolated Production Suite) ---');

  let BASE_URL = process.env.BASE_URL || '';
  let child = null;
  let tempDir = null;

  if (!BASE_URL) {
    const testPort = 4099;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waged-test-'));
    BASE_URL = `http://localhost:${testPort}`;

    child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(testPort),
        DATA_DIR: tempDir,
        DATABASE_URL: '',
        SUPER_ADMIN_EMAIL: 'admin@waged.app',
        SUPER_ADMIN_PASSWORD: 'WagedAdmin@2026!',
        INSTAPAY_NUMBER: '01557527365',
        TELEGRAM_BOT_TOKEN: '',
        NODE_ENV: 'test'
      },
      stdio: 'pipe'
    });

    await waitForServer(BASE_URL);
  }

  try {
    // 1. Health & Security Headers check
    const healthRes = await fetch(`${BASE_URL}/api/health`);
    const health = await healthRes.json();
    assert.strictEqual(health.status, 'ok', 'Health check failed');
    assert.ok(['sqlite', 'postgresql'].includes(health.db), 'Unexpected DB mode');
    assert.ok(healthRes.headers.get('x-content-type-options'), 'Helmet security header missing');
    console.log(`1. فحص الخادم وقاعدة البيانات (${health.db}) ورؤوس الأمان: ✅ نجح`);

    // 2. Signup regular user
    const testEmail = `user_${Date.now()}@example.com`;
    const signupRes = await fetch(`${BASE_URL}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'صهيب أحمد',
        email: testEmail,
        password: 'password123',
        phone: '01012345678'
      })
    });
    const signupData = await signupRes.json();
    assert.ok(signupRes.ok && signupData.token, 'Signup failed');
    assert.strictEqual(signupData.user.role, 'user', 'New signup must be regular user');
    const userToken = signupData.token;
    const userHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${userToken}` };

    // 3. Verify regular user CANNOT access Admin console APIs
    const forbiddenAdminRes = await fetch(`${BASE_URL}/api/admin/overview`, { headers: userHeaders });
    assert.strictEqual(forbiddenAdminRes.status, 403, 'Regular user accessed admin endpoint!');
    console.log('2. التسجيل العادي ومنع وصول المستخدم العادي للوحة التفعيل (403): ✅ نجح');

    // 4. Verify Free Plan Quota (2 items max, 3rd blocked)
    const item1Res = await fetch(`${BASE_URL}/api/items`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({ name: 'كيا سيراتو 2024', category: 'car' })
    });
    const item1Data = await item1Res.json();
    assert.ok(item1Res.ok, 'Item 1 failed');
    const publicCode = item1Data.item.public_code;

    const item2Res = await fetch(`${BASE_URL}/api/items`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({ name: 'MacBook Pro', category: 'laptop' })
    });
    assert.ok(item2Res.ok, 'Item 2 failed');

    const item3Blocked = await fetch(`${BASE_URL}/api/items`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({ name: 'شنطة السفر', category: 'bag' })
    });
    assert.strictEqual(item3Blocked.status, 403, 'Quota enforcement failed');
    console.log('3. إنشاء رموز QR وتطبيق حد الباقة المجانية: ✅ نجح');

    // 5. Submit InstaPay payment request -> plan MUST stay 'free' until approved
    const plansData = await (await fetch(`${BASE_URL}/api/subscriptions/plans`)).json();
    assert.strictEqual(plansData.paymentConfig.targetNumber, '01557527365', 'InstaPay target number mismatch');

    const reqPayRes = await fetch(`${BASE_URL}/api/subscriptions/request`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({
        planId: 'pro',
        billingCycle: 'monthly',
        senderAccount: '01098765432',
        referenceNote: 'تحويل إنستا باي الساعة 10'
      })
    });
    const reqPayData = await reqPayRes.json();
    assert.ok(reqPayRes.ok && reqPayData.request.status === 'pending', 'InstaPay request failed');
    const paymentReqId = reqPayData.request.id;

    const userAfterReq = await (await fetch(`${BASE_URL}/api/auth/me`, { headers: userHeaders })).json();
    assert.strictEqual(userAfterReq.user.plan.id, 'free', 'User must stay free while pending admin approval');
    console.log('4. إرسال إشعار تحويل إنستا باي (01557527365) وحجز الطلب قيد المراجعة: ✅ نجح');

    // 6. Login as Single Dedicated Super Admin & verify request + add/revoke secondary admin
    const superLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@waged.app',
        password: 'WagedAdmin@2026!'
      })
    });
    const superData = await superLoginRes.json();
    assert.ok(superLoginRes.ok && superData.user.role === 'super_admin', 'Super Admin login failed');
    const superHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${superData.token}` };

    const modEmail = `mod_${Date.now()}@example.com`;
    const addModRes = await fetch(`${BASE_URL}/api/admin/admins`, {
      method: 'POST',
      headers: superHeaders,
      body: JSON.stringify({ name: 'مسؤول التفعيل الثاني', email: modEmail, password: 'modpassword123' })
    });
    const addModData = await addModRes.json();
    assert.ok(addModRes.ok && addModData.admin.role === 'admin', 'Adding secondary admin failed');
    const modId = addModData.admin.id;

    const modLoginData = await (await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: modEmail, password: 'modpassword123' })
    })).json();
    const modHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${modLoginData.token}` };

    const modBlockedAdmins = await fetch(`${BASE_URL}/api/admin/admins`, { headers: modHeaders });
    assert.strictEqual(modBlockedAdmins.status, 403, 'Secondary admin accessed super-admin-only route!');

    const approveRes = await fetch(`${BASE_URL}/api/admin/requests/${paymentReqId}/approve`, {
      method: 'POST',
      headers: modHeaders,
      body: JSON.stringify({ adminNote: 'تم استلام المبلغ وتفعيل الباقة' })
    });
    assert.ok(approveRes.ok, 'Admin approval failed');

    const userAfterApprove = await (await fetch(`${BASE_URL}/api/auth/me`, { headers: userHeaders })).json();
    assert.strictEqual(userAfterApprove.user.plan.id, 'pro', 'User plan not upgraded after approval');

    const item3OkRes = await fetch(`${BASE_URL}/api/items`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({ name: 'شنطة السفر', category: 'bag' })
    });
    const item3Data = await item3OkRes.json();
    assert.ok(item3OkRes.ok, 'Item 3 after approval failed');
    const item3Code = item3Data.item.public_code;

    // 7. Test Admin Subscriptions Tracking + Auto-Expiration Locking + Extension
    const subsRes = await fetch(`${BASE_URL}/api/admin/subscriptions?filter=active`, { headers: superHeaders });
    const subsData = await subsRes.json();
    const activeEntry = subsData.subscriptions.find(s => s.email === testEmail);
    assert.ok(activeEntry && activeEntry.timing.remainingDays >= 29, 'Admin subscriptions remaining days missing');

    const expireRes = await fetch(`${BASE_URL}/api/admin/users/${userAfterApprove.user.id}/expire`, {
      method: 'POST',
      headers: superHeaders
    });
    assert.ok(expireRes.ok, 'Admin expire failed');

    const userExpiredMe = await (await fetch(`${BASE_URL}/api/auth/me`, { headers: userHeaders })).json();
    assert.strictEqual(userExpiredMe.user.plan.id, 'free', 'Expired user effective plan must revert to free');
    assert.strictEqual(userExpiredMe.user.timing.isExpired, true, 'User timing should show isExpired=true');

    const itemsAfterExpire = await (await fetch(`${BASE_URL}/api/items`, { headers: userHeaders })).json();
    const lockedItem = itemsAfterExpire.items.find(i => i.public_code === item3Code);
    assert.strictEqual(lockedItem.lockedByExpiration, true, 'Excess item not marked lockedByExpiration');
    const lockedScanRes = await fetch(`${BASE_URL}/api/scan/info/${item3Code}`);
    assert.strictEqual(lockedScanRes.status, 403, 'Locked item should be blocked from scanning while expired');

    const expiredSubsRes = await fetch(`${BASE_URL}/api/admin/subscriptions?filter=expired`, { headers: superHeaders });
    const expiredSubsData = await expiredSubsRes.json();
    assert.ok(expiredSubsData.subscriptions.some(s => s.email === testEmail), 'Expired user missing from admin expired filter');

    const ext1Res = await fetch(`${BASE_URL}/api/admin/users/${userAfterApprove.user.id}/extend`, {
      method: 'POST',
      headers: superHeaders,
      body: JSON.stringify({ days: 30, planId: 'pro' })
    });
    assert.ok(ext1Res.ok, 'Admin extend 30d failed');

    const ext2Res = await fetch(`${BASE_URL}/api/admin/users/${userAfterApprove.user.id}/extend`, {
      method: 'POST',
      headers: superHeaders,
      body: JSON.stringify({ days: 15, planId: 'pro' })
    });
    assert.ok(ext2Res.ok, 'Admin stack extend 15d failed');

    const userExtendedMe = await (await fetch(`${BASE_URL}/api/auth/me`, { headers: userHeaders })).json();
    assert.strictEqual(userExtendedMe.user.plan.id, 'pro', 'Extended user should be back on pro');
    assert.ok(userExtendedMe.user.timing.remainingDays >= 44, 'Extended days did not stack properly');

    const unlockedScanRes = await fetch(`${BASE_URL}/api/scan/info/${item3Code}`);
    assert.strictEqual(unlockedScanRes.status, 200, 'Item 3 should unlock immediately after extension');
    console.log('5. لوحة التفعيل، إدارة المسؤولين، انتهاء الاشتراك التلقائي وتمديد المدة: ✅ نجح');

    // Revoke secondary admin -> immediate 403
    const revokeRes = await fetch(`${BASE_URL}/api/admin/admins/${modId}`, {
      method: 'DELETE',
      headers: superHeaders
    });
    assert.ok(revokeRes.ok, 'Revoking secondary admin failed');
    const modRevokedCheck = await fetch(`${BASE_URL}/api/admin/overview`, { headers: modHeaders });
    assert.strictEqual(modRevokedCheck.status, 403, 'Revoked admin still has access!');

    // 8. Scan, Geolocation, Privacy & Chat check
    const scannerSession = 'test_scanner_' + Date.now();
    const recordData = await (await fetch(`${BASE_URL}/api/scan/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: publicCode, sessionId: scannerSession, latitude: 30.0444, longitude: 31.2357 })
    })).json();
    assert.ok(recordData.chatId, 'Scan record failed');

    const msgRes = await fetch(`${BASE_URL}/api/chat/${recordData.chatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'سيارتك تغلق الطريق', sessionId: scannerSession, lat: 30.0444, lng: 31.2357 })
    });
    assert.ok(msgRes.ok, 'Chat message failed');
    console.log('6. سحب الصلاحية الفوري، المسح، الموقع الجغرافي، والمحادثة الفورية: ✅ نجح');

    console.log('\n🎉 اكتملت جميع الاختبارات بنجاح 100%!');
  } finally {
    if (child) {
      child.kill('SIGTERM');
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

runTests().catch(err => {
  console.error('❌ فشل الاختبار:', err);
  process.exit(1);
});
