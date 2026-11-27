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
    btn.innerHTML = '<i data-lucide="bell"></i>';
    btn.style.borderColor = 'var(--primary)';
    btn.style.color = 'var(--primary)';
    playNotificationChime();
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    showToast('تم تفعيل صوت التنبيهات اللحظية', 'success');
  } else {
    btn.innerHTML = '<i data-lucide="bell-off"></i>';
    btn.style.borderColor = 'var(--card-border)';
    btn.style.color = 'var(--text-secondary)';
  }
  refreshIcons(btn);
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

document.addEventListener('click', (e) => {
  if (!e.target.closest('.dropdown-wrap')) {
    document.querySelectorAll('.dropdown-menu.open').forEach(m => m.classList.remove('open'));
  }
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const itemId = Number(btn.dataset.id);
  const item = userItems.find(i => i.id === itemId);

  if (action === 'toggle-menu') {
    const menu = btn.parentElement.querySelector('.dropdown-menu');
    const wasOpen = menu.classList.contains('open');
    document.querySelectorAll('.dropdown-menu.open').forEach(m => m.classList.remove('open'));
    if (!wasOpen) menu.classList.add('open');
    return;
  }

  document.querySelectorAll('.dropdown-menu.open').forEach(m => m.classList.remove('open'));
  if (!item) return;

  if (action === 'copy') copyScanLink(item.scanUrl);
  else if (action === 'edit') openEditModal(item.id);
  else if (action === 'toggle-lost') toggleLostStatus(item);
  else if (action === 'scans') viewScans(item.id, item.name);
  else if (action === 'download') downloadQr(item.qrDataUrl, item.name);
  else if (action === 'delete') deleteItem(item.id);
});

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
  const upgradePlan = params.get('upgrade');

  if (openChatId) {
    showDashboardTab('inbox');
    setTimeout(() => openChat(openChatId), 350);
  } else if (openTab) {
    showDashboardTab(openTab);
    if (openTab === 'billing' && upgradePlan) {
      showToast('اختر دورة الدفع واضغط ترقية لتفعيل باقتك المختارة', 'info');
    }
  }
});

function initSocket() {
  socket = io();

  socket.on('scan_alert', (alertData) => {
    playNotificationChime();
    showToast(`تنبيه مسح جديد: ${alertData.itemName}`, 'warning');
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('منصة واجد — مسح جديد', { body: `تم مسح رمز ${alertData.itemName}` });
    }
    loadItems();
    loadConversations();
  });

  socket.on('owner_new_message', (msg) => {
    playNotificationChime();
    if (Number(msg.chat_id) !== Number(activeChatId)) {
      showToast(`رسالة جديدة (${msg.item_name}): ${msg.message.slice(0, 40)}`, 'info');
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

  socket.on('subscription_updated', (data) => {
    if (data.status === 'approved') {
      showToast(`تم تفعيل ${data.planName} لحسابك بنجاح!`, 'success');
    } else if (data.status === 'rejected') {
      showToast(`تمت مراجعة طلب الترقية: ${data.reason || 'يرجى التحقق من التحويل'}`, 'error');
    } else if (data.status === 'expired') {
      showToast('انتهت مدة اشتراكك وتم إيقاف المزايا المدفوعة تلقائياً', 'warning');
    }
    loadUserData();
    loadSubscription();
    loadItems();
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
    document.getElementById('userNameBadge').textContent = currentUser.name;
    document.getElementById('userPlanBadge').textContent = currentUser.plan?.name || 'الباقة المجانية';

    const adminLink = document.getElementById('adminConsoleLink');
    if (adminLink) {
      adminLink.style.display = (currentUser.role === 'admin' || currentUser.role === 'super_admin') ? 'inline-flex' : 'none';
    }

    const expiredBanner = document.getElementById('expiredAlertBanner');
    if (expiredBanner) {
      if (currentUser.timing && currentUser.timing.isExpired) {
        expiredBanner.style.display = 'flex';
        document.getElementById('expiredAlertText').textContent =
          `انتهت صلاحية (${currentUser.timing.assignedPlan?.name || 'باقتك'}) (${currentUser.timing.remainingLabel}). جدّد عبر إنستا باي لإعادة تفعيل الرموز المقيدة.`;
        refreshIcons(expiredBanner);
      } else {
        expiredBanner.style.display = 'none';
      }
    }

    document.getElementById('settingsName').value = currentUser.name || '';
    document.getElementById('settingsEmail').value = currentUser.email || '';
    document.getElementById('settingsPhone').value = currentUser.phone || '';
    document.getElementById('webhookUrlInput').value = currentUser.webhook_url || '';

    updateTelegramUI(currentUser);
  } catch (err) {
    console.error(err);
    window.location.href = '/login.html';
  }
}

function updateTelegramUI(user) {
  const banner = document.getElementById('telegramBanner');
  const pill = document.getElementById('tgConnectedPill');
  const actionContainer = document.getElementById('tgActionContainer');
  const settingsInfo = document.getElementById('settingsTgInfo');
  const settingsActions = document.getElementById('settingsTgActions');

  if (user.telegramDeepLink) {
    document.getElementById('tgAutoBox').style.display = 'block';
    document.getElementById('tgDeepLinkBtn').href = user.telegramDeepLink;
  } else {
    document.getElementById('tgAutoBox').style.display = 'none';
  }

  if (user.telegram_chat_id) {
    banner.style.display = 'none';
    pill.style.display = 'inline-flex';
    pill.className = 'badge badge-success';
    pill.innerHTML = '<i data-lucide="check-circle-2"></i><span>تليجرام متصل</span>';
    pill.style.cursor = 'pointer';
    pill.title = 'إعدادات تليجرام';
    pill.onclick = () => showDashboardTab('settings');
    refreshIcons(pill);

    settingsInfo.innerHTML = `تليجرام متصل بالمعرف الرقمي: <code>${escapeHtml(user.telegram_chat_id)}</code>`;
    settingsActions.innerHTML = `
      <button type="button" class="btn btn-primary btn-sm" onclick="testTelegramAlert()">
        <i data-lucide="send"></i>
        <span>إرسال إشعار تجريبي</span>
      </button>
      <button type="button" class="btn btn-outline btn-sm" onclick="unlinkTelegram()" style="color: var(--danger);">
        <i data-lucide="x"></i>
        <span>إلغاء الربط</span>
      </button>
    `;
  } else {
    pill.style.display = 'none';
    banner.style.display = 'flex';
    actionContainer.innerHTML = user.telegramDeepLink
      ? `<a href="${user.telegramDeepLink}" target="_blank" rel="noopener" class="btn btn-primary btn-sm"><i data-lucide="send"></i><span>ربط تلقائي الآن</span></a>
         <button type="button" class="btn btn-outline btn-sm" onclick="openTgModal()">ربط برقم ID</button>`
      : `<button type="button" class="btn btn-primary btn-sm" onclick="openTgModal()"><i data-lucide="settings"></i><span>ربط تليجرام</span></button>`;

    settingsInfo.textContent = 'حساب تليجرام غير مربوط بعد.';
    settingsActions.innerHTML = `
      <button type="button" class="btn btn-primary btn-sm" onclick="openTgModal()">
        <i data-lucide="send"></i>
        <span>ربط تليجرام</span>
      </button>
    `;
  }
  refreshIcons(banner);
  refreshIcons(settingsActions);
}

async function testTelegramAlert() {
  try {
    const res = await fetch('/api/auth/test-telegram', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'تعذر الإرسال');
    showToast(data.message || 'تم الإرسال', 'success');
  } catch (err) {
    showToast(err.message, 'error');
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
        <div class="card" style="grid-column: 1/-1; text-align: center; padding: 48px 20px; background: var(--bg-subtle); border-style: dashed;">
          <div class="stat-icon" style="width: 54px; height: 54px; margin: 0 auto 14px; border-radius: 14px;">
            <i data-lucide="qr-code" style="width: 26px; height: 26px;"></i>
          </div>
          <h3 style="font-size: 18px; font-weight: 700; margin-bottom: 6px;">أنشئ أول رمز QR في ثوانٍ</h3>
          <p style="color: var(--text-muted); font-size: 13.5px; margin-bottom: 20px;">اختر نوع الغرض للبدء السريع، أو اضغط إنشاء رمز جديد</p>
          <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
            <button type="button" class="btn btn-primary btn-sm" onclick="openCreateModal('car')">
              <i data-lucide="car"></i>
              <span>إضافة سيارة</span>
            </button>
            <button type="button" class="btn btn-outline btn-sm" onclick="openCreateModal('laptop')">
              <i data-lucide="laptop"></i>
              <span>إضافة لابتوب</span>
            </button>
            <button type="button" class="btn btn-outline btn-sm" onclick="openCreateModal('bag')">
              <i data-lucide="briefcase"></i>
              <span>إضافة حقيبة / مفاتيح</span>
            </button>
          </div>
        </div>
      `;
      refreshIcons(grid);
      return;
    }

    const catMeta = {
      car: { icon: 'car', label: 'سيارة' },
      laptop: { icon: 'laptop', label: 'لابتوب' },
      bag: { icon: 'briefcase', label: 'حقيبة' },
      keys: { icon: 'key-round', label: 'مفاتيح' },
      pet: { icon: 'tag', label: 'أليف' },
      other: { icon: 'package', label: 'غرض' }
    };

    grid.innerHTML = userItems.map(item => {
      const meta = catMeta[item.category] || catMeta.other;

      let statusBadge = '<span class="badge badge-success"><i data-lucide="check-circle-2"></i><span>نشط</span></span>';
      if (item.lockedByExpiration) {
        statusBadge = '<span class="badge badge-danger"><i data-lucide="lock"></i><span>مغلق (انتهى الاشتراك)</span></span>';
      } else if (item.status === 'lost') {
        statusBadge = '<span class="badge badge-danger"><i data-lucide="alert-triangle"></i><span>مفقود</span></span>';
      } else if (item.status === 'disabled') {
        statusBadge = '<span class="badge badge-warning"><i data-lucide="pause-circle"></i><span>معطل</span></span>';
      }

      const lostLabel = item.status === 'lost' ? 'إنهاء وضع المفقود' : 'تفعيل وضع المفقود';
      const lostIcon = item.status === 'lost' ? 'check-circle-2' : 'alert-triangle';

      return `
        <div class="card item-card">
          <div>
            <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
              <div>
                <div style="display: flex; gap: 6px; margin-bottom: 7px; flex-wrap: wrap;">
                  <span class="badge badge-primary"><i data-lucide="${meta.icon}"></i><span>${meta.label}</span></span>
                  ${statusBadge}
                </div>
                <h3 style="font-size: 16.5px; font-weight: 700;">${escapeHtml(item.name)}</h3>
              </div>
              <span class="badge badge-neutral">${item.scan_count} مسح</span>
            </div>

            <div class="item-qr-frame">
              <img src="${item.qrDataUrl}" alt="QR Code">
              <div class="item-qr-code-text">${escapeHtml(item.public_code)}</div>
            </div>
          </div>

          <div class="item-card-footer">
            <a href="/print.html?code=${encodeURIComponent(item.public_code)}" target="_blank" class="btn btn-primary btn-sm" style="flex: 1;">
              <i data-lucide="printer"></i>
              <span>طباعة</span>
            </a>
            <button type="button" class="btn btn-outline btn-sm" data-action="copy" data-id="${item.id}" style="flex: 1;">
              <i data-lucide="copy"></i>
              <span>نسخ</span>
            </button>
            <a href="/scan.html?code=${encodeURIComponent(item.public_code)}" target="_blank" class="btn btn-outline btn-sm" title="معاينة صفحة المسح">
              <i data-lucide="external-link"></i>
            </a>
            <div class="dropdown-wrap">
              <button type="button" class="btn btn-outline btn-sm" data-action="toggle-menu" data-id="${item.id}" title="خيارات إضافية">
                <i data-lucide="more-horizontal"></i>
              </button>
              <div class="dropdown-menu">
                <button type="button" class="dropdown-item" data-action="edit" data-id="${item.id}">
                  <i data-lucide="pencil"></i><span>تعديل التفاصيل</span>
                </button>
                <button type="button" class="dropdown-item" data-action="toggle-lost" data-id="${item.id}">
                  <i data-lucide="${lostIcon}"></i><span>${lostLabel}</span>
                </button>
                <button type="button" class="dropdown-item" data-action="scans" data-id="${item.id}">
                  <i data-lucide="map-pin"></i><span>سجل المواقع</span>
                </button>
                <button type="button" class="dropdown-item" data-action="download" data-id="${item.id}">
                  <i data-lucide="download"></i><span>تحميل صورة QR</span>
                </button>
                <button type="button" class="dropdown-item danger" data-action="delete" data-id="${item.id}">
                  <i data-lucide="trash-2"></i><span>حذف الرمز</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
    refreshIcons(grid);
  } catch (err) {
    console.error(err);
  }
}

async function toggleLostStatus(item) {
  const nextStatus = item.status === 'lost' ? 'active' : 'lost';
  try {
    const res = await fetch(`/api/items/${item.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: nextStatus })
    });
    if (!res.ok) throw new Error('تعذر تغيير الحالة');
    showToast(nextStatus === 'lost' ? 'تم تفعيل وضع المفقودات العاجل' : 'تمت إعادة الغرض للوضع الطبيعي', 'success');
    await loadItems();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function showDashboardTab(tab) {
  const tabs = ['items', 'inbox', 'billing', 'settings'];
  tabs.forEach(t => {
    const sec = document.getElementById(`${t}Section`);
    const btn = document.getElementById(`tab${t.charAt(0).toUpperCase() + t.slice(1)}Btn`);
    if (sec) sec.style.display = t === tab ? 'block' : 'none';
    if (btn) btn.classList.toggle('active', t === tab);
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
        <div style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 36px 10px;">
          لا توجد محادثات حتى الآن.
        </div>
      `;
      return;
    }

    list.innerHTML = convs.map(c => `
      <div onclick="openChat(${c.chat_id})" style="padding: 12px; border-radius: var(--radius-sm); border: 1px solid ${activeChatId == c.chat_id ? 'var(--primary)' : 'var(--card-border)'}; background: ${activeChatId == c.chat_id ? 'var(--primary-light)' : '#ffffff'}; cursor: pointer; transition: all 0.16s;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
          <strong style="font-size: 13.5px;">${escapeHtml(c.item_name)}</strong>
          <div style="display: flex; align-items: center; gap: 6px;">
            ${c.unread_owner > 0 ? `<span class="badge badge-danger" style="padding: 2px 7px;">${c.unread_owner}</span>` : ''}
            <span style="font-size: 11px; color: var(--text-muted);">${formatTime(c.updated_at)}</span>
          </div>
        </div>
        <div style="font-size: 12.5px; color: var(--text-muted); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
          ${c.last_message ? escapeHtml(c.last_message) : 'محادثة جديدة'}
        </div>
        ${c.scan_lat && c.scan_lng ? `
          <div style="margin-top: 5px; font-size: 11px; color: var(--primary); display: flex; align-items: center; gap: 4px;">
            <i data-lucide="map-pin" style="width: 12px; height: 12px;"></i>
            <span>موقع جغرافي مرفق</span>
          </div>
        ` : ''}
      </div>
    `).join('');
    refreshIcons(list);
  } catch (err) {
    console.error(err);
  }
}

async function openChat(chatId) {
  activeChatId = chatId;
  renderedDashMsgIds.clear();
  loadConversations();

  const messagesBox = document.getElementById('dashChatMessages');
  document.getElementById('dashChatForm').style.display = 'flex';
  messagesBox.innerHTML = '<div style="text-align: center; color: var(--text-muted); margin: auto;">جاري جلب الرسائل...</div>';

  try {
    const res = await fetch(`/api/chat/${chatId}/messages`);
    const data = await res.json();

    document.getElementById('activeChatTitle').textContent = `محادثة: ${data.itemName}`;
    document.getElementById('activeChatSub').textContent = 'تواصل آمن ومجهول مع الزائر';

    const actionsEl = document.getElementById('activeChatActions');
    let actionsHtml = '';
    if (data.scanLocation && data.scanLocation.lat && data.scanLocation.lng) {
      const mapUrl = `https://www.google.com/maps?q=${data.scanLocation.lat},${data.scanLocation.lng}`;
      actionsHtml += `<a href="${mapUrl}" target="_blank" rel="noopener" class="btn btn-soft btn-sm"><i data-lucide="map-pin"></i><span>موقع المسح</span></a>`;
    }
    actionsHtml += `<button type="button" class="btn btn-outline btn-sm" style="color: var(--danger);" onclick="deleteActiveChat(${chatId})"><i data-lucide="trash-2"></i><span>حذف</span></button>`;
    actionsEl.innerHTML = actionsHtml;
    refreshIcons(actionsEl);

    if (socket) {
      socket.emit('join_chat', { chatId });
    }

    renderChatMessages(data.messages || []);
    loadConversations();
  } catch (err) {
    console.error(err);
    messagesBox.innerHTML = '<div style="color: var(--danger); text-align: center;">فشل في تحميل المحادثة</div>';
  }
}

function deleteActiveChat(chatId) {
  askConfirm('حذف المحادثة', 'هل تريد حذف سجل هذه المحادثة نهائياً؟', async () => {
    try {
      const res = await fetch(`/api/chat/${chatId}`, { method: 'DELETE' });
      if (res.ok) {
        activeChatId = null;
        document.getElementById('activeChatTitle').textContent = 'اختر محادثة من القائمة';
        document.getElementById('activeChatSub').textContent = 'تواصل آمن ومجهول';
        document.getElementById('activeChatActions').innerHTML = '';
        document.getElementById('dashChatForm').style.display = 'none';
        document.getElementById('dashChatMessages').innerHTML = '<div style="text-align: center; color: var(--text-muted); margin: auto;">تم حذف المحادثة</div>';
        showToast('تم حذف المحادثة', 'info');
        loadConversations();
      }
    } catch (err) {
      console.error(err);
    }
  });
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
        <i data-lucide="map-pin" style="width: 14px; height: 14px;"></i>
        <strong>الموقع:</strong>
        <a href="${mapUrl}" target="_blank" rel="noopener" style="text-decoration: underline;">
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
  refreshIcons(div);
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
function selectCategory(cat) {
  document.getElementById('itemCategory').value = cat;
  document.querySelectorAll('#catPicker .cat-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.cat === cat);
  });
  updateDefaultMsg();
}

function openCreateModal(presetCat = 'car') {
  document.getElementById('editItemId').value = '';
  document.getElementById('itemModalTitle').textContent = 'إنشاء رمز QR جديد';
  document.getElementById('itemStatusGroup').style.display = 'none';
  document.getElementById('itemName').value = '';
  document.getElementById('itemReqLocation').checked = true;
  selectCategory(presetCat);
  document.getElementById('createModal').classList.add('active');
  setTimeout(() => document.getElementById('itemName').focus(), 80);
}

function openEditModal(id) {
  const item = userItems.find(i => i.id === id);
  if (!item) return;

  document.getElementById('editItemId').value = item.id;
  document.getElementById('itemModalTitle').textContent = `تعديل: ${item.name}`;
  document.getElementById('itemStatusGroup').style.display = 'block';
  document.getElementById('itemStatusSelect').value = item.status || 'active';
  document.getElementById('itemName').value = item.name;
  selectCategory(item.category || 'car');
  document.getElementById('itemMessage').value = item.custom_message || '';
  document.getElementById('itemReqLocation').checked = Boolean(item.require_location);
  document.getElementById('createModal').classList.add('active');
}

function closeCreateModal() {
  document.getElementById('createModal').classList.remove('active');
}

function updateDefaultMsg() {
  if (document.getElementById('editItemId').value) return;
  const cat = document.getElementById('itemCategory').value;
  const defaults = {
    car: 'لو السيارة تغلق الطريق أو في أي طارئ، يرجى مراسلتي هنا فوراً وسأتحرك خلال دقيقتين.',
    laptop: 'إذا عثرت على هذا اللابتوب، أرجو مراسلتي عبر هذه الصفحة لتنسيق استلامه ولك جزيل الشكر.',
    bag: 'إذا عثرت على هذه الحقيبة، يرجى التواصل معي هنا بأمان لاستعادتها.',
    keys: 'هذه المفاتيح ملكي، لو وجدتها يرجى مراسلتي هنا وسأكون ممتناً جداً.',
    pet: 'هذا الأليف ملكي وفي حالة العثور عليه أرجو التواصل معي فوراً.',
    other: 'في حالة العثور على هذا الغرض، يرجى التواصل معي هنا بأمان وسرية.'
  };
  document.getElementById('itemMessage').value = defaults[cat] || defaults.other;
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
    btn.textContent = 'حفظ رمز الـ QR';
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

// Subscriptions & Billing (InstaPay Flow)
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
    let usageLine = `الاستخدام: ${meData.usage.itemsCount} من ${maxLabel} رموز QR`;
    if (meData.timing && meData.timing.isPaid) {
      usageLine += ` — ${meData.timing.remainingLabel}`;
    }
    document.getElementById('billingUsageText').textContent = usageLine;
    document.getElementById('userPlanBadge').textContent = meData.timing?.isExpired
      ? `${meData.currentPlan.name} (انتهى المدفوع)`
      : meData.currentPlan.name;

    const pendingBanner = document.getElementById('pendingPaymentBanner');
    if (meData.pendingRequest) {
      const reqPlan = allPlans.find(p => p.id === meData.pendingRequest.plan_id);
      pendingBanner.style.display = 'flex';
      pendingBanner.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px;">
          <div class="stat-icon" style="color: var(--warning);"><i data-lucide="clock"></i></div>
          <div>
            <strong style="font-size: 14px;">طلب الترقية إلى (${escapeHtml(reqPlan?.name || meData.pendingRequest.plan_id)}) قيد المراجعة</strong>
            <div style="font-size: 12.5px; color: var(--text-secondary);">
              تم استلام إشعار التحويل عبر إنستا باي (${escapeHtml(meData.pendingRequest.sender_account)}) على الرقم <span class="mono">${escapeHtml(meData.pendingRequest.target_number)}</span>. سيتم التأكد وتفعيل حسابك خلال 24 ساعة.
            </div>
          </div>
        </div>
        <span class="badge badge-warning">جاري التحقق</span>
      `;
      refreshIcons(pendingBanner);
    } else {
      pendingBanner.style.display = 'none';
    }

    renderBillingPlans();
    renderBillingHistory(meData.requests || [], meData.invoices || []);
  } catch (err) {
    console.error(err);
  }
}

function renderBillingPlans() {
  const grid = document.getElementById('billingPlansGrid');
  if (!grid || !allPlans.length) return;
  const cycle = document.getElementById('billingCycleSelect').value;
  const currentId = subInfo?.currentPlan?.id || 'free';
  const hasPending = Boolean(subInfo?.pendingRequest);

  grid.innerHTML = allPlans.map(plan => {
    const isCurrent = plan.id === currentId;
    const price = cycle === 'yearly' ? plan.priceYearly : plan.priceMonthly;
    const periodLabel = cycle === 'yearly' ? '/ سنوياً' : '/ شهرياً';

    let btnHtml = '';
    if (isCurrent) {
      btnHtml = `<button class="btn btn-outline" style="width: 100%; padding: 11px;" disabled>مفعلة حالياً</button>`;
    } else if (plan.id === 'free') {
      btnHtml = `<button onclick="downgradeToFree()" class="btn btn-outline" style="width: 100%; padding: 11px;">العودة للمجانية</button>`;
    } else if (hasPending && subInfo.pendingRequest.plan_id === plan.id) {
      btnHtml = `<button class="btn btn-soft" style="width: 100%; padding: 11px;" disabled>طلبك قيد المراجعة</button>`;
    } else {
      btnHtml = `<button onclick="openInstapayModal('${plan.id}')" class="btn btn-primary" style="width: 100%; padding: 11px;" ${hasPending ? 'disabled' : ''}>الدفع عبر إنستا باي</button>`;
    }

    return `
      <div class="card pricing-card ${plan.id === 'pro' ? 'featured' : ''}">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <h3 style="font-size: 18px; font-weight: 700;">${plan.name}</h3>
            <span class="badge ${isCurrent ? 'badge-success' : 'badge-primary'}">${isCurrent ? 'باقتك الحالية' : plan.badge}</span>
          </div>
          <div class="pricing-price">
            ${price === 0 ? 'مجاناً' : `${price} <span style="font-size:15px;">${plan.currency}</span>`}
            ${price > 0 ? `<span>${periodLabel}</span>` : ''}
          </div>
          <ul class="pricing-features">
            ${plan.features.map(f => `<li><i data-lucide="check" style="color: var(--accent);"></i><span>${f}</span></li>`).join('')}
          </ul>
        </div>
        ${btnHtml}
      </div>
    `;
  }).join('');
  refreshIcons(grid);
}

function openInstapayModal(planId) {
  const plan = allPlans.find(p => p.id === planId);
  if (!plan) return;
  const cycle = document.getElementById('billingCycleSelect').value;
  const amount = cycle === 'yearly' ? plan.priceYearly : plan.priceMonthly;
  const cycleLabel = cycle === 'yearly' ? 'سنوياً' : 'شهرياً';
  const targetNum = subInfo?.paymentConfig?.targetNumber || '01557527365';

  document.getElementById('ipPlanId').value = plan.id;
  document.getElementById('ipBillingCycle').value = cycle;
  document.getElementById('ipPlanName').textContent = `${plan.name} (${cycleLabel})`;
  document.getElementById('ipAmount').textContent = `${amount} ${plan.currency}`;
  document.getElementById('ipTargetNumber').textContent = targetNum;
  document.getElementById('ipSenderAccount').value = currentUser?.phone || '';
  document.getElementById('ipReferenceNote').value = '';

  document.getElementById('instapayModal').classList.add('active');
  refreshIcons(document.getElementById('instapayModal'));
}

function closeInstapayModal() {
  document.getElementById('instapayModal').classList.remove('active');
}

function copyInstapayNumber() {
  const num = document.getElementById('ipTargetNumber').textContent.trim();
  navigator.clipboard.writeText(num).then(() => {
    showToast(`تم نسخ رقم إنستا باي: ${num}`, 'success');
  });
}

async function handleSubmitInstapay(e) {
  e.preventDefault();
  const btn = document.getElementById('ipSubmitBtn');
  btn.disabled = true;

  const payload = {
    planId: document.getElementById('ipPlanId').value,
    billingCycle: document.getElementById('ipBillingCycle').value,
    senderAccount: document.getElementById('ipSenderAccount').value.trim(),
    referenceNote: document.getElementById('ipReferenceNote').value.trim()
  };

  try {
    const res = await fetch('/api/subscriptions/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'تعذر إرسال الطلب');

    closeInstapayModal();
    showToast(data.message, 'success');
    await loadSubscription();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function downgradeToFree() {
  askConfirm('العودة للباقة المجانية', 'هل تريد التحويل إلى الباقة المجانية؟', async () => {
    try {
      const res = await fetch('/api/subscriptions/downgrade', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      showToast(data.message, 'info');
      await loadUserData();
      await loadSubscription();
      await loadItems();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

function renderBillingHistory(requests, invoices) {
  const box = document.getElementById('invoicesList');
  if (!requests.length && !invoices.length) {
    box.innerHTML = 'لا توجد طلبات تفعيل أو فواتير مسجلة حتى الآن.';
    return;
  }

  const statusMeta = {
    pending: { cls: 'badge-warning', label: 'قيد المراجعة (خلال 24 ساعة)' },
    approved: { cls: 'badge-success', label: 'تم التفعيل' },
    rejected: { cls: 'badge-danger', label: 'مرفوض' }
  };

  box.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 10px;">
      ${requests.map(r => {
        const st = statusMeta[r.status] || statusMeta.pending;
        return `
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; background: var(--bg-subtle); border-radius: 10px; border: 1px solid var(--card-border); flex-wrap: wrap; gap: 8px;">
            <div>
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <strong>طلب #${r.id}</strong>
                <span class="badge badge-primary">${escapeHtml(r.plan_id.toUpperCase())}</span>
                <span class="badge ${st.cls}">${st.label}</span>
              </div>
              <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">
                إنستا باي من: <span class="mono">${escapeHtml(r.sender_account)}</span> — ${new Date(r.created_at).toLocaleString('ar-EG')}
              </div>
              ${r.admin_note ? `<div style="font-size: 12px; color: var(--text-secondary); margin-top: 3px;">ملاحظة الإدارة: ${escapeHtml(r.admin_note)}</div>` : ''}
            </div>
            <div style="font-weight: 700; color: var(--text-main);">
              ${r.amount} ${escapeHtml(r.currency)} (${r.billing_cycle === 'yearly' ? 'سنوي' : 'شهري'})
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// Settings Handlers
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

// Telegram Modal
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
  askConfirm('إلغاء ربط تليجرام', 'لن تصلك تنبيهات فورية على تليجرام عند مسح رموزك. هل تريد المتابعة؟', async () => {
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

// Scans Modal
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
      <div style="display: flex; flex-direction: column; gap: 10px;">
        ${scans.map(s => {
          let mapHtml = '<span style="color: var(--text-muted); font-size: 12px;">بدون إحداثيات</span>';
          if (s.latitude && s.longitude) {
            const url = `https://www.google.com/maps?q=${s.latitude},${s.longitude}`;
            mapHtml = `
              <a href="${url}" target="_blank" rel="noopener" class="btn btn-soft btn-sm" style="font-size: 12px; padding: 5px 12px;">
                <i data-lucide="map-pin"></i>
                <span>الخريطة (${s.latitude.toFixed(4)}, ${s.longitude.toFixed(4)})</span>
              </a>
            `;
          }
          return `
            <div style="padding: 12px 14px; background: var(--bg-subtle); border: 1px solid var(--card-border); border-radius: var(--radius-sm); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
              <div>
                <div style="font-weight: 600; font-size: 13.5px;">مسح رمز QR</div>
                <div style="font-size: 12px; color: var(--text-muted);">${new Date(s.created_at).toLocaleString('ar-EG')}</div>
              </div>
              <div>${mapHtml}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
    refreshIcons(content);
  } catch (err) {
    content.innerHTML = '<div style="color: var(--danger);">فشل في جلب السجل</div>';
  }
}
function closeScansModal() {
  document.getElementById('scansModal').classList.remove('active');
}

function copyScanLink(url) {
  navigator.clipboard.writeText(url).then(() => {
    showToast('تم نسخ رابط المسح بنجاح', 'success');
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
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
}
