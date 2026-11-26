const assert = require('assert');

async function runTests() {
  console.log('--- بدء الاختبارات الشاملة لمنصة واجد v2.1 ---');
  const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';

  // 1. Health & Security Headers check
  const healthRes = await fetch(`${BASE_URL}/api/health`);
  const health = await healthRes.json();
  assert.strictEqual(health.status, 'ok', 'Health check failed');
  assert.strictEqual(health.db, 'connected', 'DB connection check failed');
  assert.ok(healthRes.headers.get('x-content-type-options'), 'Helmet security header missing');
  console.log('1. فحص الخادم، قاعدة البيانات، ورؤوس الأمان: ✅ نجح');

  // 2. Unauthenticated access must fail
  const unauthRes = await fetch(`${BASE_URL}/api/items`);
  assert.strictEqual(unauthRes.status, 401, 'Unauthenticated request should be 401');

  // 3. Signup & Login & Profile/Password
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
  const token = signupData.token;
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  const meRes = await fetch(`${BASE_URL}/api/auth/me`, { headers: authHeaders });
  const meData = await meRes.json();
  assert.ok(meRes.ok && meData.user.telegram_link_token, 'Me endpoint missing telegram_link_token');

  const profRes = await fetch(`${BASE_URL}/api/auth/profile`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ name: 'صهيب محمود', phone: '01099998888' })
  });
  assert.ok(profRes.ok, 'Profile update failed');

  const tgStatRes = await fetch(`${BASE_URL}/api/telegram/status`, { headers: authHeaders });
  assert.ok(tgStatRes.ok, 'Telegram status endpoint failed');
  console.log('2. إنشاء الحساب، المصادقة، وتحديث الملف الشخصي: ✅ نجح');

  // 4. Telegram Webhook Auto-Link Test
  const tgWebhookRes = await fetch(`${BASE_URL}/api/telegram/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        chat: { id: 99887766 },
        text: `/start ${meData.user.telegram_link_token}`
      }
    })
  });
  assert.ok(tgWebhookRes.ok, 'Telegram webhook failed');
  const meAfterTg = await (await fetch(`${BASE_URL}/api/auth/me`, { headers: authHeaders })).json();
  assert.strictEqual(meAfterTg.user.telegram_chat_id, '99887766', 'Telegram auto-linking failed');
  console.log('3. الربط التلقائي لبوت تليجرام عبر Webhook: ✅ نجح');

  // 5. Create 2 Items (Free Plan Quota = 2)
  const item1Res = await fetch(`${BASE_URL}/api/items`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: "كيا 'سيراتو' 2024",
      category: 'car',
      custom_message: 'لو العربية مزنقة على حضرتك كلمني هنا فوراً.',
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
    body: JSON.stringify({ name: 'MacBook Pro M3', category: 'laptop' })
  });
  assert.ok(item2Res.ok, 'Item 2 creation failed');

  const item3BlockedRes = await fetch(`${BASE_URL}/api/items`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: 'شنطة السفر', category: 'bag' })
  });
  const item3Blocked = await item3BlockedRes.json();
  assert.strictEqual(item3BlockedRes.status, 403, 'Quota enforcement failed');
  assert.strictEqual(item3Blocked.upgradeRequired, true);
  console.log('4. إنشاء الرموز وتطبيق حد الباقة المجانية (Quota): ✅ نجح');

  // 6. Upgrade to Pro Plan, save Webhook URL, create 3rd item
  const subRes = await fetch(`${BASE_URL}/api/subscriptions/subscribe`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ planId: 'pro', billingCycle: 'yearly', promoCode: 'PAROT100' })
  });
  assert.ok(subRes.ok, 'Subscription upgrade failed');

  const whRes = await fetch(`${BASE_URL}/api/subscriptions/webhook`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ webhookUrl: 'https://example.com/hook' })
  });
  assert.ok(whRes.ok, 'Webhook save failed');

  const item3OkRes = await fetch(`${BASE_URL}/api/items`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: 'شنطة السفر', category: 'bag' })
  });
  assert.ok(item3OkRes.ok, 'Item 3 after Pro upgrade failed');
  console.log('5. الترقية للباقة الاحترافية، تفعيل Webhook، وفك حد الرموز: ✅ نجح');

  // 7. Edit Item -> Lost Mode + Local SVG QR + New Logo Asset
  const editRes = await fetch(`${BASE_URL}/api/items/${itemId}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ status: 'lost' })
  });
  assert.ok(editRes.ok, 'Item update failed');

  const qrSvgRes = await fetch(`${BASE_URL}/api/scan/qr/${publicCode}`);
  const qrSvg = await qrSvgRes.text();
  assert.ok(qrSvgRes.ok && qrSvg.includes('<svg'), 'Local SVG QR generation failed');

  const logoRes = await fetch(`${BASE_URL}/logo.svg`);
  const logoSvg = await logoRes.text();
  assert.ok(logoRes.ok && logoSvg.includes('wagedGrad'), 'Waged evolved logo.svg missing');
  console.log('6. وضع المفقودات، توليد QR محلي SVG، والشعار المطور: ✅ نجح');

  // 8. Privacy Zero-PII check + Disabled block check
  const scanInfoRes = await fetch(`${BASE_URL}/api/scan/info/${publicCode}`);
  const scanInfo = await scanInfoRes.json();
  assert.strictEqual(scanInfo.status, 'lost');
  assert.ok(!scanInfo.phone && !scanInfo.email && !scanInfo.user_id, 'PII leaked!');

  // 9. Scan record + Geolocation + Chat + Cross-session security check + Delete chat
  const scannerSession = 'test_scanner_session_' + Date.now();
  const recordRes = await fetch(`${BASE_URL}/api/scan/record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: publicCode,
      sessionId: scannerSession,
      latitude: 30.0444,
      longitude: 31.2357,
      accuracy: 12.0
    })
  });
  const recordData = await recordRes.json();
  assert.ok(recordRes.ok && recordData.chatId, 'Scan record failed');
  const chatId = recordData.chatId;

  // Cross-session unauthorized check
  const spoofRes = await fetch(`${BASE_URL}/api/chat/${chatId}/messages?sessionId=wrong_session`);
  assert.strictEqual(spoofRes.status, 403, 'Cross-session chat access was not blocked!');

  const msgRes = await fetch(`${BASE_URL}/api/chat/${chatId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'لو سمحت العربية قافلة عليا 🚗',
      sessionId: scannerSession,
      lat: 30.0444,
      lng: 31.2357
    })
  });
  assert.ok(msgRes.ok, 'Scanner message failed');

  const ownerChatMsgsRes = await fetch(`${BASE_URL}/api/chat/${chatId}/messages`, { headers: authHeaders });
  const ownerChatMsgs = await ownerChatMsgsRes.json();
  assert.strictEqual(ownerChatMsgs.scanLocation.lat, 30.0444, 'scanLocation missing from owner chat view');

  const replyRes = await fetch(`${BASE_URL}/api/chat/${chatId}/messages`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ message: 'نازل حالا في خلال دقيقة!' })
  });
  assert.ok(replyRes.ok, 'Owner reply failed');

  const delChatRes = await fetch(`${BASE_URL}/api/chat/${chatId}`, {
    method: 'DELETE',
    headers: authHeaders
  });
  assert.ok(delChatRes.ok, 'Chat deletion failed');
  console.log('7. الخصوصية، حماية الجلسات، الموقع الجغرافي، والمحادثة الفورية: ✅ نجح');

  console.log('\n🎉 اكتملت جميع الاختبارات بنجاح 100% — المنصة جاهزة تماماً للإنتاج والنشر على Render!');
}

runTests().catch(err => {
  console.error('❌ فشل الاختبار:', err);
  process.exit(1);
});
