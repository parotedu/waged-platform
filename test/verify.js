const assert = require('assert');

async function runTests() {
  console.log('--- بدء الاختبارات الشاملة لمنصة واجد v2.3 (InstaPay & Admin RBAC) ---');
  const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';

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
      email: process.env.SUPER_ADMIN_EMAIL || 'admin@waged.app',
      password: process.env.SUPER_ADMIN_PASSWORD || 'WagedAdmin@2026!'
    })
  });
  const superData = await superLoginRes.json();
  assert.ok(superLoginRes.ok && superData.user.role === 'super_admin', 'Super Admin login failed');
  const superHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${superData.token}` };

  // Super Admin adds a secondary activation admin
  const modEmail = `mod_${Date.now()}@example.com`;
  const addModRes = await fetch(`${BASE_URL}/api/admin/admins`, {
    method: 'POST',
    headers: superHeaders,
    body: JSON.stringify({ name: 'مسؤول التفعيل الثاني', email: modEmail, password: 'modpassword123' })
  });
  const addModData = await addModRes.json();
  assert.ok(addModRes.ok && addModData.admin.role === 'admin', 'Adding secondary admin failed');
  const modId = addModData.admin.id;

  // Login as secondary admin
  const modLoginData = await (await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: modEmail, password: 'modpassword123' })
  })).json();
  const modHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${modLoginData.token}` };

  // Secondary admin CANNOT add/manage other admins (403)
  const modBlockedAdmins = await fetch(`${BASE_URL}/api/admin/admins`, { headers: modHeaders });
  assert.strictEqual(modBlockedAdmins.status, 403, 'Secondary admin accessed super-admin-only route!');

  // Secondary admin CAN approve InstaPay request!
  const approveRes = await fetch(`${BASE_URL}/api/admin/requests/${paymentReqId}/approve`, {
    method: 'POST',
    headers: modHeaders,
    body: JSON.stringify({ adminNote: 'تم استلام المبلغ وتفعيل الباقة' })
  });
  assert.ok(approveRes.ok, 'Admin approval failed');

  // Verify user's plan is now 'pro' and can create 3rd QR item!
  const userAfterApprove = await (await fetch(`${BASE_URL}/api/auth/me`, { headers: userHeaders })).json();
  assert.strictEqual(userAfterApprove.user.plan.id, 'pro', 'User plan not upgraded after approval');

  const item3Ok = await fetch(`${BASE_URL}/api/items`, {
    method: 'POST',
    headers: userHeaders,
    body: JSON.stringify({ name: 'شنطة السفر', category: 'bag' })
  });
  assert.ok(item3Ok.ok, 'Item 3 after approval failed');

  // Super admin revokes secondary admin -> immediate 403 even with existing JWT!
  const revokeRes = await fetch(`${BASE_URL}/api/admin/admins/${modId}`, {
    method: 'DELETE',
    headers: superHeaders
  });
  assert.ok(revokeRes.ok, 'Revoking secondary admin failed');

  const modRevokedCheck = await fetch(`${BASE_URL}/api/admin/overview`, { headers: modHeaders });
  assert.strictEqual(modRevokedCheck.status, 403, 'Revoked admin still has access!');
  console.log('5. لوحة التفعيل، صلاحيات الحساب الرئيسي وإضافة/إزالة المسؤولين، وتفعيل الاشتراك: ✅ نجح');

  // 7. Scan, Geolocation, Privacy & Chat check
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
  console.log('6. المسح، الموقع الجغرافي، والمحادثة الفورية: ✅ نجح');

  console.log('\n🎉 اكتملت جميع الاختبارات بنجاح 100%!');
}

runTests().catch(err => {
  console.error('❌ فشل الاختبار:', err);
  process.exit(1);
});
