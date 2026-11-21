let currentUser = null;
let userItems = [];
let allPlans = [];
let subInfo = null;
let activeChatId = null;
let socket = null;
let soundEnabled = false;
let renderedDashMsgIds = new Set();
let dashTypingTimeout = null;

function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function playNotificationChime() {
  if (!soundEnabled) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1174.66, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.45);
  } catch (e) {}
}

function enableSoundAlerts() {
  soundEnabled = !soundEnabled;
  const btn = document.getElementById('soundToggleBtn');
  if (soundEnabled) {
    btn.textContent = '🔊 صوت التنبيهات مفعل';
    btn.className = 'btn btn-success btn-sm';
    playNotificationChime();
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    showToast('تم تفعيل التنبيهات الصوتية الفورية', 'success');
  } else {
    btn.textContent = '🔔 تفعيل صوت التنبيهات';
    btn.className = 'btn btn-outline btn-sm';
  }
}

let confirmCallback = null;
function askConfirm(title, text, onYes) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmText').textContent = text;
  confirmCallback = onYes;
  document.getElementById('confirmModal').classList.add('active');
}
function closeConfirmModal() {
  document.getElementById('confirmModal').classList.remove('active');
  confirmCallback = null;
}

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('confirmYesBtn').addEventListener('click', () => {
    if (confirmCallback) confirmCallback();
    closeConfirmModal();
  });

  await loadUserData();
  await Promise.all([loadItems(), loadConversations(), loadSubscription()]);
  initSocket();

  const params = new URLSearchParams(window.location.search);
  const openChatId = params.get('openChat');
  const openTab = params.get('tab');
  if (openChatId) {
    showDashboardTab('inbox');
    setTimeout(() => openChat(openChatId), 400);
  } else if (openTab) {
    showDashboardTab(openTab);
  }
});

function initSocket() {
  socket = io();

  socket.on('scan_alert', (alertData) => {
    playNotificationChime();
    showToast(`🚨 تم مسح رمز: ${alertData.itemName}!`, 'warning');
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('منصة واجد - مسح جديد 🚨', { body: `تم مسح رمز ${alertData.itemName}` });
    }
    loadItems();
    loadConversations();
  });

  socket.on('owner_new_message', (msg) => {
    playNotificationChime();
    if (Number(msg.chat_id) !== Number(activeChatId)) {
      showToast(`💬 رسالة جديدة على (${msg.item_name}): ${msg.message.slice(0, 40)}`, 'info');
    }
    loadConversations();
  });

  socket.on('new_message', (msg) => {
    if (activeChatId && Number(msg.chat_id) === Number(activeChatId)) {
      document.getElementById('dashTypingIndicator').style.display = 'none';
      appendChatMessage(msg);
    }
    loadConversations();
  });

  socket.on('user_typing', (data) => {
    if (data.role === 'scanner') {
      document.getElementById('dashTypingIndicator').style.display = 'block';
    }
  });

  socket.on('user_stop_typing', () => {
    document.getElementById('dashTypingIndicator').style.display = 'none';
  });
}

async function loadUserData() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) {
      window.location.href = '/login.html';
      return;
    }
    const data = await res.json();
    currentUser = data.user;
    document.getElementById('userNameBadge').textContent = `👤 ${currentUser.name}`;
    document.getElementById('userPlanBadge').textContent = currentUser.plan?.name || 'الباقة المجانية';

    // Fill settings form
    document.getElementById('settingsName').value = currentUser.name || '';
    document.getElementById('settingsEmail').value = currentUser.email || '';
    document.getElementById('settingsPhone').value = currentUser.phone || '';
    document.getElementById('webhookUrlInput').value = currentUser.webhook_url || '';

    updateTelegramBanner(currentUser.telegram_chat_id);
  } catch (err) {
    console.error(err);
    window.location.href = '/login.html';
  }
}

function updateTelegramBanner(chatId) {
  const text = document.getElementById('tgStatusText');
  const actionContainer = document.getElementById('tgActionContainer');

  if (chatId) {
    text.innerHTML = `✅ <strong>مفعل بنجاح!</strong> حسابك مربوط برقم الشات: <code>${escapeHtml(chatId)}</code> وتصلك التنبيهات فورياً.`;
    actionContainer.innerHTML = `
      <button class="btn btn-primary btn-sm" onclick="testTelegramAlert()" style="background: #0088cc;">
        🧪 إرسال إشعار تجريبي
      </button>
      <button class="btn btn-outline btn-sm" onclick="unlinkTelegram()" style="border-color: #ef4444; color: #ef4444;">
        إلغاء الربط
      </button>
    `;
  } else {
    text.textContent = 'اربط حسابك بتليجرام ليصلك إشعار فوري بصوت ورابط اللوكيشن بمجرد أن يمسح أي شخص رمز سيارتك أو غرضك!';
    actionContainer.innerHTML = `
      <button class="btn btn-primary btn-sm" onclick="openTgModal()" style="background: #0088cc;">
        ⚙️ إعداد ربط تليجرام
      </button>
    `;
  }
}

async function testTelegramAlert() {
  try {
    const res = await fetch('/api/auth/test-telegram', { method: 'POST' });
    const data = await res.json();
    showToast(data.message || 'تم الإرسال', 'success');
  } catch {
    showToast('حدث خطأ أثناء الاختبار', 'error');
  }
}

async function loadItems() {
  try {
    const res = await fetch('/api/items');
    const data = await res.json();
    userItems = data.items || [];

    const maxItems = currentUser?.plan?.maxItems || 2;
    document.getElementById('statItems').textContent = `${userItems.length} / ${maxItems > 999 ? '∞' : maxItems}`;
    const totalScans = userItems.reduce((acc, item) => acc + (item.scan_count || 0), 0);
    const totalChats = userItems.reduce((acc, item) => acc + (item.chat_count || 0), 0);
    document.getElementById('statScans').textContent = totalScans;
    document.getElementById('statChats').textContent = totalChats;

    const grid = document.getElementById('itemsGrid');
    if (userItems.length === 0) {
      grid.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 60px 20px; background: #fff; border-radius: var(--radius-lg); border: 2px dashed var(--border-color);">
          <div style="font-size: 40px; margin-bottom: 14px;">🏷️</div>
          <h3 style="font-size: 20px; font-weight: 800; margin-bottom: 8px;">لم تقم بإنشاء أي رمز QR حتى الآن</h3>
          <p style="color: var(--text-muted); margin-bottom: 20px;">ابدأ بإضافة سيارتك أو لابتوبك أو أي مقتنيات لحمايتها فوراً</p>
          <button class="btn btn-primary" onclick="openCreateModal()">➕ إنشاء أول رمز QR</button>
        </div>
      `;
      return;
    }

    grid.innerHTML = userItems.map(item => {
      const catIcon = {
        car: '🚗 سيارة',
        laptop: '💻 لابتوب',
        bag: '💼 حقيبة',
        keys: '🔑 مفاتيح',
        pet: '🐾 حيوان أليف',
        other: '📦 غرض'
      }[item.category] || '📦 غرض';

      let statusBadge = `<span class="badge badge-success">🟢 نشط</span>`;
      if (item.status === 'lost') statusBadge = `<span class="badge badge-danger">🚨 مفقود</span>`;
      if (item.status === 'disabled') statusBadge = `<span class="badge badge-warning">⛔ معطل</span>`;

      return `
        <div class="card item-card">
          <div>
            <div class="item-header">
              <div>
                <div style="display: flex; gap: 6px; margin-bottom: 6px; flex-wrap: wrap;">
                  <span class="badge badge-primary">${catIcon}</span>
                  ${statusBadge}
                </div>
                <h3 class="item-title">${escapeHtml(item.name)}</h3>
              </div>
              <span class="badge ${item.scan_count > 0 ? 'badge-success' : 'badge-warning'}">
                👁️ ${item.scan_count} مسح
              </span>
            </div>

            <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 10px; line-height: 1.4;">
              ${item.custom_message ? escapeHtml(item.custom_message) : 'لا توجد رسالة مخصصة'}
            </p>

            <div class="item-qr-wrap">
              <img src="${item.qrDataUrl}" alt="QR Code">
              <div style="font-size: 11px; color: var(--text-muted); margin-top: 6px;">كود: <code>${item.public_code}</code></div>
            </div>
          </div>

          <div>
            <div class="item-actions">
              <a href="/print.html?code=${item.public_code}" target="_blank" class="btn btn-outline btn-sm" style="flex: 1;">
                🖨️ طباعة ملصق
              </a>
              <button onclick="openEditModal(${item.id})" class="btn btn-outline btn-sm" title="تعديل الغرض والحالة">
                ✏️ تعديل
              </button>
              <button onclick="copyScanLink('${item.scanUrl}')" class="btn btn-outline btn-sm" title="نسخ رابط المسح">
                🔗 نسخ
              </button>
              <button onclick="downloadQr('${item.qrDataUrl}', '${escapeHtml(item.name)}')" class="btn btn-outline btn-sm" title="تحميل صورة الـ QR">
                📥 تحميل
              </button>
              <button onclick="viewScans(${item.id}, '${escapeHtml(item.name)}')" class="btn btn-outline btn-sm" title="سجل المواقع">
                📍 المواقع
              </button>
              <button onclick="deleteItem(${item.id})" class="btn btn-sm" style="color: #ef4444; background: #fee2e2;" title="حذف الرمز">
                🗑️
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error(err);
  }
}

function showDashboardTab(tab) {
  const tabs = ['items', 'inbox', 'billing', 'settings'];
  tabs.forEach(t => {
    const sec = document.getElementById(`${t}Section`);
    const btn = document.getElementById(`tab${t.charAt(0).toUpperCase() + t.slice(1)}Btn`);
    if (sec) sec.style.display = t === tab ? 'block' : 'none';
    if (btn) btn.className = t === tab ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm';
  });
}

async function loadConversations() {
  try {
    const res = await fetch('/api/chat/owner/conversations');
    const data = await res.json();
    const convs = data.conversations || [];

    const unreadTotal = convs.reduce((acc, c) => acc + (c.unread_owner || 0), 0);
    document.getElementById('inboxBadge').textContent = unreadTotal > 0 ? `${unreadTotal} جديد` : convs.length;

    const list = document.getElementById('conversationsList');
    if (convs.length === 0) {
      list.innerHTML = `
        <div style="color: var(--text-muted); font-size: 14px; text-align: center; padding: 40px 10px;">
          لا توجد محادثات حتى الآن.<br>
          <small>بمجرد أن يمسح أحد رمزك ويرسل رسالة، ستظهر هنا فوراً.</small>
        </div>
      `;
      return;
    }

    list.innerHTML = convs.map(c => `
      <div onclick="openChat(${c.chat_id})" style="padding: 12px 14px; border-radius: var(--radius-md); border: 1.5px solid ${activeChatId == c.chat_id ? 'var(--primary)' : 'var(--border-color)'}; background: ${activeChatId == c.chat_id ? 'var(--primary-light)' : '#ffffff'}; cursor: pointer; transition: all 0.2s;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
          <strong style="font-size: 14px; color: var(--dark);">${escapeHtml(c.item_name)}</strong>
          <div style="display: flex; align-items: center; gap: 6px;">
            ${c.unread_owner > 0 ? `<span class="badge badge-danger" style="padding: 2px 7px;">${c.unread_owner}</span>` : ''}
            <span style="font-size: 11px; color: var(--text-muted);">${formatTime(c.updated_at)}</span>
          </div>
        </div>
        <div style="font-size: 13px; color: var(--text-muted); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
          ${c.last_message ? escapeHtml(c.last_message) : 'محادثة جديدة'}
        </div>
        ${c.scan_lat && c.scan_lng ? `
          <div style="margin-top: 6px; font-size: 11px; color: #0284c7; display: flex; align-items: center; gap: 4px;">
            📍 موقع جغرافي متوفر
          </div>
        ` : ''}
      </div>
    `).join('');
  } catch (err) {
    console.error(err);
  }
}

async function openChat(chatId) {
  activeChatId = chatId;
  renderedDashMsgIds.clear();
  loadConversations();

  const messagesBox = document.getElementById('dashChatMessages');
  document.getElementById('dashChatForm').style.display = 'block';
  messagesBox.innerHTML = '<div style="text-align: center; color: var(--text-muted); margin: auto;">جاري جلب الرسائل...</div>';

  try {
    const res = await fetch(`/api/chat/${chatId}/messages`);
    const data = await res.json();

    document.getElementById('activeChatTitle').textContent = `محادثة حول: ${data.itemName}`;
    document.getElementById('activeChatSub').textContent = `تواصل آمن ومجهول مع الزائر`;

    if (socket) {
      socket.emit('join_chat', { chatId });
    }

    renderChatMessages(data.messages || []);
    loadConversations();
  } catch (err) {
    console.error(err);
    messagesBox.innerHTML = '<div style="color: #ef4444; text-align: center;">فشل في تحميل المحادثة</div>';
  }
}

function renderChatMessages(messages) {
  const box = document.getElementById('dashChatMessages');
  if (messages.length === 0) {
    box.innerHTML = '<div style="text-align: center; color: var(--text-muted); margin: auto;">لا توجد رسائل بعد.</div>';
    return;
  }

  box.innerHTML = '';
  messages.forEach(msg => appendChatMessage(msg, false));
  box.scrollTop = box.scrollHeight;
}

function appendChatMessage(msg, autoScroll = true) {
  if (msg.id && renderedDashMsgIds.has(msg.id)) return;
  if (msg.id) renderedDashMsgIds.add(msg.id);

  const box = document.getElementById('dashChatMessages');
  const div = document.createElement('div');

  let bubbleClass = 'msg-system';
  if (msg.sender_type === 'owner') bubbleClass = 'msg-owner';
  else if (msg.sender_type === 'scanner') bubbleClass = 'msg-scanner';

  let locationHtml = '';
  if (msg.lat && msg.lng) {
    const mapUrl = `https://www.google.com/maps?q=${msg.lat},${msg.lng}`;
    locationHtml = `
      <div class="msg-location-card">
        📍 <strong>موقع المسح:</strong>
        <a href="${mapUrl}" target="_blank" style="color: #2563eb; text-decoration: underline; margin-right: 6px;">
          عرض على Google Maps
        </a>
      </div>
    `;
  }

  div.className = `msg-bubble ${bubbleClass}`;
  div.innerHTML = `
    <div>${escapeHtml(msg.message)}</div>
    ${locationHtml}
    <span class="msg-time">${formatTime(msg.created_at)}</span>
  `;

  box.appendChild(div);
  if (autoScroll) {
    box.scrollTop = box.scrollHeight;
  }
}

function emitDashTyping() {
  if (!socket) return;
  socket.emit('typing');
  clearTimeout(dashTypingTimeout);
  dashTypingTimeout = setTimeout(() => socket.emit('stop_typing'), 1500);
}

async function handleDashSendMessage(e) {
  e.preventDefault();
  if (!activeChatId) return;

  const input = document.getElementById('dashChatInput');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  if (socket) socket.emit('stop_typing');

  try {
    const res = await fetch(`/api/chat/${activeChatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    });
    if (!res.ok) showToast('فشل في إرسال الرسالة', 'error');
  } catch (err) {
    console.error(err);
  }
}

// Create / Edit Item Modal
function openCreateModal() {
  document.getElementById('editItemId').value = '';
  document.getElementById('itemModalTitle').textContent = 'إنشاء رمز QR جديد';
  document.getElementById('itemStatusGroup').style.display = 'none';
  document.getElementById('itemName').value = '';
  document.getElementById('itemCategory').value = 'car';
  document.getElementById('itemReqLocation').checked = true;
  updateDefaultMsg();
  document.getElementById('createModal').classList.add('active');
}

function openEditModal(id) {
  const item = userItems.find(i => i.id === id);
  if (!item) return;

  document.getElementById('editItemId').value = item.id;
  document.getElementById('itemModalTitle').textContent = `تعديل: ${item.name}`;
  document.getElementById('itemStatusGroup').style.display = 'block';
  document.getElementById('itemStatusSelect').value = item.status || 'active';
  document.getElementById('itemName').value = item.name;
  document.getElementById('itemCategory').value = item.category || 'car';
  document.getElementById('itemMessage').value = item.custom_message || '';
  document.getElementById('itemReqLocation').checked = Boolean(item.require_location);
  document.getElementById('createModal').classList.add('active');
}

function closeCreateModal() {
  document.getElementById('createModal').classList.remove('active');
}

function updateDefaultMsg() {
  if (document.getElementById('editItemId').value) return; // Don't overwrite on edit
  const cat = document.getElementById('itemCategory').value;
  const msgInput = document.getElementById('itemMessage');
  const defaults = {
    car: 'لو العربية مزنقة على حضرتك أو في أي طارئ، برجاء مراسلتي هنا فوراً وسأتحرك خلال دقيقتين.',
    laptop: 'إذا عثرت على هذا اللابتوب، أرجو مراسلتي عبر هذه الصفحة لتنسيق استلامه ولك جزيل الشكر.',
    bag: 'إذا عثرت على هذه الحقيبة، برجاء التواصل معي هنا بأمان لاستعادتها.',
    keys: 'هذه المفاتيح ملكي، لو وجدتها برجاء مراسلتي هنا وسأكون ممتناً جداً.',
    pet: 'هذا الأليف ملكي وفي حالة العثور عليه أرجو التواصل معي فوراً.',
    other: 'في حالة العثور على هذا الغرض، برجاء التواصل معي هنا بأمان وسرية.'
  };
  msgInput.value = defaults[cat] || defaults.other;
}

async function handleSaveItem(e) {
  e.preventDefault();
  const btn = document.getElementById('createItemBtn');
  btn.disabled = true;
  btn.textContent = 'جاري الحفظ...';

  const editId = document.getElementById('editItemId').value;
  const payload = {
    name: document.getElementById('itemName').value,
    category: document.getElementById('itemCategory').value,
    custom_message: document.getElementById('itemMessage').value,
    require_location: document.getElementById('itemReqLocation').checked
  };
  if (editId) {
    payload.status = document.getElementById('itemStatusSelect').value;
  }

  try {
    const url = editId ? `/api/items/${editId}` : '/api/items';
    const method = editId ? 'PUT' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.upgradeRequired) {
        closeCreateModal();
        showDashboardTab('billing');
      }
      throw new Error(data.error || 'فشل حفظ الغرض');
    }

    closeCreateModal();
    showToast(editId ? 'تم تحديث الغرض بنجاح' : 'تم إنشاء رمز الـ QR بنجاح', 'success');
    await loadItems();
    await loadSubscription();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'تأكيد وحفظ رمز الـ QR';
  }
}

function deleteItem(id) {
  askConfirm('حذف رمز QR', 'هل أنت متأكد من حذف هذا الرمز؟ ستتوقف جميع الملصقات المرتبطة به فوراً.', async () => {
    try {
      const res = await fetch(`/api/items/${id}`, { method: 'DELETE' });
      if (res.ok) {
        showToast('تم حذف الرمز بنجاح', 'success');
        await loadItems();
        await loadSubscription();
      } else {
        showToast('فشل في حذف الغرض', 'error');
      }
    } catch (err) {
      console.error(err);
    }
  });
}

// Subscriptions & Billing
async function loadSubscription() {
  try {
    const [plansRes, meRes] = await Promise.all([
      fetch('/api/subscriptions/plans'),
      fetch('/api/subscriptions/me')
    ]);
    const plansData = await plansRes.json();
    const meData = await meRes.json();

    allPlans = plansData.plans || [];
    subInfo = meData;

    document.getElementById('billingCurrentPlanName').textContent = meData.currentPlan.name;
    const maxLabel = meData.usage.maxItems > 999 ? 'غير محدود' : meData.usage.maxItems;
    document.getElementById('billingUsageText').textContent = `الاستخدام: ${meData.usage.itemsCount} من ${maxLabel} رموز QR`;
    document.getElementById('userPlanBadge').textContent = meData.currentPlan.name;

    renderBillingPlans();
    renderInvoices(meData.invoices || []);
  } catch (err) {
    console.error(err);
  }
}

function renderBillingPlans() {
  const grid = document.getElementById('billingPlansGrid');
  if (!grid || !allPlans.length) return;
  const cycle = document.getElementById('billingCycleSelect').value;
  const currentId = subInfo?.currentPlan?.id || 'free';

  grid.innerHTML = allPlans.map(plan => {
    const isCurrent = plan.id === currentId;
    const price = cycle === 'yearly' ? plan.priceYearly : plan.priceMonthly;
    const periodLabel = cycle === 'yearly' ? '/ سنوياً' : '/ شهرياً';

    return `
      <div class="pricing-card ${plan.id === 'pro' ? 'featured' : ''}">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <h3 style="font-size: 20px; font-weight: 800;">${plan.name}</h3>
            <span class="badge ${isCurrent ? 'badge-success' : 'badge-primary'}">${isCurrent ? 'باقتك الحالية' : plan.badge}</span>
          </div>
          <div class="pricing-price">
            ${price === 0 ? 'مجاناً' : `${price} <span style="font-size:18px;">${plan.currency}</span>`}
            ${price > 0 ? `<span>${periodLabel}</span>` : ''}
          </div>
          <ul class="pricing-features">
            ${plan.features.map(f => `<li>✅ <span>${f}</span></li>`).join('')}
          </ul>
        </div>
        <button
          onclick="subscribePlan('${plan.id}')"
          class="btn ${isCurrent ? 'btn-outline' : 'btn-primary'}"
          style="width: 100%; padding: 12px;"
          ${isCurrent ? 'disabled' : ''}>
          ${isCurrent ? 'مفعلة حالياً' : (price === 0 ? 'العودة للمجانية' : 'ترقية وتفعيل الباقة')}
        </button>
      </div>
    `;
  }).join('');
}

async function subscribePlan(planId) {
  const cycle = document.getElementById('billingCycleSelect').value;
  const promoCode = document.getElementById('promoCodeInput').value.trim();

  try {
    const res = await fetch('/api/subscriptions/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId, billingCycle: cycle, promoCode })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'فشل تفعيل الباقة');

    showToast(data.message, 'success');
    await loadUserData();
    await loadSubscription();
    await loadItems();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderInvoices(invoices) {
  const box = document.getElementById('invoicesList');
  if (!invoices.length) {
    box.innerHTML = 'لا توجد فواتير مسجلة حتى الآن.';
    return;
  }
  box.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 10px;">
      ${invoices.map(inv => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px; background: #f8fafc; border-radius: 10px; border: 1px solid var(--border-color); flex-wrap: wrap; gap: 10px;">
          <div>
            <strong>فاتورة #${inv.reference_code}</strong> — <span class="badge badge-primary">${inv.plan_id.toUpperCase()}</span>
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">${new Date(inv.created_at).toLocaleString('ar-EG')}</div>
          </div>
          <div style="font-weight: 800; color: var(--accent);">
            ${inv.amount} ${inv.currency} (${inv.billing_cycle === 'yearly' ? 'سنوي' : 'شهري'})
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// Account Settings Handlers
async function handleUpdateProfile(e) {
  e.preventDefault();
  const name = document.getElementById('settingsName').value.trim();
  const phone = document.getElementById('settingsPhone').value.trim();
  try {
    const res = await fetch('/api/auth/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast(data.message, 'success');
    await loadUserData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleChangePassword(e) {
  e.preventDefault();
  const currentPassword = document.getElementById('currentPassInput').value;
  const newPassword = document.getElementById('newPassInput').value;
  try {
    const res = await fetch('/api/auth/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast(data.message, 'success');
    e.target.reset();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleSaveWebhook(e) {
  e.preventDefault();
  const webhookUrl = document.getElementById('webhookUrlInput').value.trim();
  try {
    const res = await fetch('/api/subscriptions/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast(data.message, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Telegram modal
function openTgModal() {
  document.getElementById('tgModal').classList.add('active');
}
function closeTgModal() {
  document.getElementById('tgModal').classList.remove('active');
}

async function handleSaveTgChatId(e) {
  e.preventDefault();
  const chatId = document.getElementById('tgChatIdInput').value.trim();
  try {
    const res = await fetch('/api/auth/link-telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId })
    });
    const data = await res.json();
    if (res.ok) {
      closeTgModal();
      await loadUserData();
      showToast('تم ربط حساب تليجرام بنجاح!', 'success');
    } else {
      showToast(data.error || 'فشل ربط تليجرام', 'error');
    }
  } catch (err) {
    console.error(err);
  }
}

function unlinkTelegram() {
  askConfirm('إلغاء ربط تليجرام', 'هل تريد بالتأكيد إلغاء ربط تليجرام؟ لن تصلك تنبيهات فورية على هاتفك.', async () => {
    try {
      const res = await fetch('/api/auth/unlink-telegram', { method: 'POST' });
      if (res.ok) {
        showToast('تم إلغاء ربط تليجرام', 'info');
        await loadUserData();
      }
    } catch (err) {
      console.error(err);
    }
  });
}

// Scans & location modal
async function viewScans(itemId, itemName) {
  document.getElementById('scansModalTitle').textContent = `سجل مسح: ${itemName}`;
  const content = document.getElementById('scansModalContent');
  content.innerHTML = 'جاري التحميل...';
  document.getElementById('scansModal').classList.add('active');

  try {
    const res = await fetch(`/api/items/${itemId}/scans`);
    const data = await res.json();
    const scans = data.scans || [];

    if (scans.length === 0) {
      content.innerHTML = '<div style="text-align: center; padding: 30px; color: var(--text-muted);">لم يتم مسح هذا الرمز حتى الآن.</div>';
      return;
    }

    content.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 12px;">
        ${scans.map(s => {
          let mapHtml = '<span style="color: var(--text-muted); font-size: 12px;">الموقع الجغرافي لم يتم مشاركته</span>';
          if (s.latitude && s.longitude) {
            const url = `https://www.google.com/maps?q=${s.latitude},${s.longitude}`;
            mapHtml = `
              <a href="${url}" target="_blank" class="btn btn-primary btn-sm" style="display: inline-flex; font-size: 12px; padding: 4px 10px;">
                📍 فتح في Google Maps (${s.latitude.toFixed(4)}, ${s.longitude.toFixed(4)})
              </a>
            `;
          }
          return `
            <div style="padding: 12px 16px; background: #f8fafc; border: 1px solid var(--border-color); border-radius: var(--radius-md); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
              <div>
                <div style="font-weight: 700; font-size: 14px;">مسح بواسطة زائر</div>
                <div style="font-size: 12px; color: var(--text-muted);">${new Date(s.created_at).toLocaleString('ar-EG')}</div>
              </div>
              <div>${mapHtml}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  } catch (err) {
    content.innerHTML = '<div style="color: #ef4444;">فشل في جلب السجل</div>';
  }
}
function closeScansModal() {
  document.getElementById('scansModal').classList.remove('active');
}

function copyScanLink(url) {
  navigator.clipboard.writeText(url).then(() => {
    showToast('تم نسخ رابط المسح إلى الحافظة!', 'success');
  });
}

function downloadQr(dataUrl, name) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `QR_واجد_${name}.png`;
  a.click();
}

async function handleLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  localStorage.removeItem('waged_user');
  window.location.href = '/login.html';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
}
