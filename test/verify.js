const assert = require('assert');

async function runTests() {
  console.log('--- بدء الاختبارات الشاملة لمنصة واجد v2.0 ---');
  const BASE_URL = 'http://localhost:4000';

  // 1. Health & Security Headers check
  const healthRes = await fetch(`${BASE_URL}/api/health`);
  const health = await healthRes.json();
  assert.strictEqual(health.status, 'ok', 'Health check failed');
  assert.ok(healthRes.headers.get('x-content-type-options'), 'Helmet security header missing');
  console.log('1. فحص صحة الخادم ورؤوس الأمان (Helmet): ✅ نجح');

  // 2. Signup
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
  console.log('2. إنشاء الحساب والتحقق من التوكن:', '✅ نجح', signupData.user.email);

  const token = signupData.token;
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  // 3. Create 2 Items (Free Plan Limit = 2)
  const item1Res = await fetch(`${BASE_URL}/api/items`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'كيا سيراتو 2024 فضي',
      category: 'car',
      custom_message: 'لو العربية مزنقة على حضرتك كلمني هنا فوراً وسأتحرك.',
      require_location: true
    })
  });
  const item1Data = await item1Res.json();
  assert.ok(item1Res.ok, 'Item 1 creation failed');
  const publicCode = item1Data.item.public_code;
  const itemId = item1Data.item.id;

  const item2Res = await fetch(`${BASE_URL}/api/items`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: 'لابتوب MacBook Pro', category: 'laptop' })
  });
  assert.ok(item2Res.ok, 'Item 2 creation failed');

  // 4. Test Free Plan Quota Enforcement (3rd item should be blocked)
  const item3BlockedRes = await fetch(`${BASE_URL}/api/items`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: 'شنطة السفر', category: 'bag' })
  });
  const item3Blocked = await item3BlockedRes.json();
  assert.strictEqual(item3BlockedRes.status, 403, 'Quota enforcement failed');
  assert.strictEqual(item3Blocked.upgradeRequired, true);
  console.log('3. إنشاء الرموز وتطبيق حد الباقة المجانية (Quota): ✅ نجح');

  // 5. Upgrade to Pro Plan & create 3rd item
  const subRes = await fetch(`${BASE_URL}/api/subscriptions/subscribe`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ planId: 'pro', billingCycle: 'monthly', promoCode: 'PAROT100' })
  });
  const subData = await subRes.json();
  assert.ok(subRes.ok && subData.success, 'Subscription upgrade failed');

  const item3OkRes = await fetch(`${BASE_URL}/api/items`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: 'شنطة السفر', category: 'bag' })
  });
  assert.ok(item3OkRes.ok, 'Item 3 after Pro upgrade failed');
  console.log('4. ترقية الاشتراك للباقة الاحترافية وإضافة غرض ثالث: ✅ نجح');

  // 6. Test Edit Item & Lost Mode + Local SVG QR
  const editRes = await fetch(`${BASE_URL}/api/items/${itemId}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ status: 'lost' })
  });
  assert.ok(editRes.ok, 'Item update failed');

  const qrSvgRes = await fetch(`${BASE_URL}/api/scan/qr/${publicCode}`);
  const qrSvg = await qrSvgRes.text();
  assert.ok(qrSvgRes.ok && qrSvg.includes('<svg'), 'Local SVG QR generation failed');
  console.log('5. تعديل الحالة (وضع المفقودات) وتوليد QR محلي بصيغة SVG: ✅ نجح');

  // 7. Test Scanner Public Info (Zero-PII Privacy check)
  const scanInfoRes = await fetch(`${BASE_URL}/api/scan/info/${publicCode}`);
  const scanInfo = await scanInfoRes.json();
  assert.strictEqual(scanInfo.name, 'كيا سيراتو 2024 فضي');
  assert.strictEqual(scanInfo.status, 'lost');
  assert.ok(!scanInfo.phone && !scanInfo.email && !scanInfo.user_id, 'PII leaked!');
  console.log('6. فحص الخصوصية (Zero-PII) عند المسح: ✅ محمي تماماً');

  // 8. Test Scanner Record with Geolocation & Chat Flow
  const scannerSession = 'test_scanner_session_' + Date.now();
  const recordRes = await fetch(`${BASE_URL}/api/scan/record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: publicCode,
      sessionId: scannerSession,
      latitude: 30.0444,
      longitude: 31.2357,
      accuracy: 15.0
    })
  });
  const recordData = await recordRes.json();
  assert.ok(recordRes.ok && recordData.chatId, 'Scan record failed');
  const chatId = recordData.chatId;

  const msgRes = await fetch(`${BASE_URL}/api/chat/${chatId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'لو سمحت العربية قافلة عليا ومحتاج أتحرك ضروري 🚗',
      sessionId: scannerSession,
      lat: 30.0444,
      lng: 31.2357
    })
  });
  assert.ok(msgRes.ok, 'Scanner message failed');

  const ownerConvsRes = await fetch(`${BASE_URL}/api/chat/owner/conversations`, { headers: authHeaders });
  const ownerConvs = await ownerConvsRes.json();
  assert.ok(ownerConvs.conversations.length > 0 && ownerConvs.conversations[0].unread_owner >= 1, 'Unread counter failed');

  const replyRes = await fetch(`${BASE_URL}/api/chat/${chatId}/messages`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ message: 'بعتذر لحضرتك جداً، نازل حالا في خلال دقيقة!' })
  });
  assert.ok(replyRes.ok, 'Owner reply failed');
  console.log('7. مسح الكود، الموقع الجغرافي، والمحادثة الفورية: ✅ نجح');

  console.log('\n🎉 اكتملت جميع الاختبارات الشاملة لمنصة واجد بنجاح 100%!');
}

runTests().catch(err => {
  console.error('❌ فشل الاختبار:', err);
  process.exit(1);
});
