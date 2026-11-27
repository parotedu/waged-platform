let itemInfo = null;
let currentChatId = null;
let userSessionId = null;
let socket = null;
let userCoords = null;
let renderedMessageIds = new Set();
let typingTimeout = null;

const params = new URLSearchParams(window.location.search);
const publicCode = params.get('code');

function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

document.addEventListener('DOMContentLoaded', async () => {
  if (!publicCode) {
    document.getElementById('itemHeaderTitle').textContent = 'رمز غير صالح';
    document.getElementById('chatMessages').innerHTML = '<div style="color: var(--danger); text-align: center; margin: auto;">لم يتم تحديد رمز QR صالح.</div>';
    return;
  }

  const sessionKey = `waged_session_${publicCode}`;
  userSessionId = localStorage.getItem(sessionKey);
  if (!userSessionId) {
    userSessionId = 'sess_' + Math.random().toString(36).substring(2, 15) + Date.now();
    localStorage.setItem(sessionKey, userSessionId);
  }

  await fetchItemInfo();
});

async function fetchItemInfo() {
  try {
    const res = await fetch(`/api/scan/info/${encodeURIComponent(publicCode)}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'فشل في قراءة الرمز');
    }
    itemInfo = await res.json();

    document.getElementById('itemHeaderTitle').textContent = itemInfo.name;
    const catIcons = {
      car: 'car',
      laptop: 'laptop',
      bag: 'briefcase',
      keys: 'key-round',
      pet: 'tag',
      other: 'package'
    };
    const avatar = document.getElementById('itemAvatar');
    avatar.innerHTML = `<i data-lucide="${catIcons[itemInfo.category] || 'package'}"></i>`;
    refreshIcons(avatar);

    if (itemInfo.status === 'lost') {
      document.getElementById('lostBanner').style.display = 'flex';
    }

    if (itemInfo.custom_message) {
      document.getElementById('ownerMsgText').textContent = itemInfo.custom_message;
      document.getElementById('ownerMsgCard').style.display = 'block';
    }

    if (itemInfo.require_location) {
      document.getElementById('shareLocationBtn').style.display = 'inline-flex';
    }

    renderQuickReplies(itemInfo.category);
    // Open chat immediately with zero friction
    await recordScanAndStartChat();
  } catch (err) {
    document.getElementById('itemHeaderTitle').textContent = 'تنبيه';
    document.getElementById('chatMessages').innerHTML = `<div style="color: var(--danger); text-align: center; margin: auto;">${escapeHtml(err.message)}</div>`;
  }
}

function renderQuickReplies(cat) {
  const container = document.getElementById('quickReplies');
  let replies = [];

  if (cat === 'car') {
    replies = [
      'سيارتك تغلق الطريق، أرجو التحريك',
      'أنا متواجد عند السيارة الآن',
      'يرجى التواصل للأهمية',
      'شكراً لتعاونك'
    ];
  } else if (cat === 'laptop' || cat === 'bag' || cat === 'keys') {
    replies = [
      'وجدت الغرض وهو في أمان معي',
      'أنا متواجد في نفس المكان الآن',
      'كيف يمكنني تسليمه لك؟'
    ];
  } else {
    replies = [
      'مرحباً، قمت بمسح رمز الـ QR الخاص بك',
      'أرجو التواصل معي للأهمية',
      'أنا في موقع الغرض الآن'
    ];
  }

  container.innerHTML = replies.map(r => `
    <button type="button" class="quick-chip" data-text="${escapeHtml(r)}">
      ${escapeHtml(r)}
    </button>
  `).join('');

  container.querySelectorAll('.quick-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('messageInput').value = btn.dataset.text;
      document.getElementById('chatForm').dispatchEvent(new Event('submit'));
    });
  });
}

async function sendLiveLocationPin() {
  const btn = document.getElementById('shareLocationBtn');
  if (!navigator.geolocation || !currentChatId) {
    showToast('تعذر الوصول للموقع الجغرافي في هذا المتصفح', 'error');
    return;
  }
  if (btn) btn.disabled = true;
  showToast('جاري تحديد موقعك لإرساله...', 'info');

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      userCoords = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy
      };

      // Also update scan record with coordinates
      await fetch('/api/scan/record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: publicCode,
          sessionId: userSessionId,
          latitude: userCoords.latitude,
          longitude: userCoords.longitude,
          accuracy: userCoords.accuracy
        })
      });

      await fetch(`/api/chat/${currentChatId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'تم إرسال موقعي الجغرافي الحالي للمساعدة',
          sessionId: userSessionId,
          lat: userCoords.latitude,
          lng: userCoords.longitude
        })
      });

      if (btn) {
        btn.innerHTML = '<i data-lucide="check"></i><span>تم إرسال الموقع</span>';
        btn.className = 'btn btn-soft btn-sm';
        refreshIcons(btn);
      }
      showToast('تم إرسال موقعك للمالك بنجاح', 'success');
    },
    () => {
      if (btn) btn.disabled = false;
      showToast('يرجى السماح بصلاحية الموقع من المتصفح', 'warning');
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

async function recordScanAndStartChat() {
  document.getElementById('quickReplies').style.display = 'flex';
  document.getElementById('chatForm').style.display = 'flex';
  refreshIcons();

  try {
    const payload = {
      code: publicCode,
      sessionId: userSessionId,
      latitude: userCoords ? userCoords.latitude : null,
      longitude: userCoords ? userCoords.longitude : null,
      accuracy: userCoords ? userCoords.accuracy : null
    };

    const res = await fetch('/api/scan/record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'فشل في تسجيل المسح');

    currentChatId = data.chatId;
    initSocketChat();
    await loadChatMessages();
  } catch (err) {
    console.error(err);
    showToast(err.message, 'error');
  }
}

function initSocketChat() {
  if (socket) return;
  socket = io();

  socket.on('connect', () => {
    socket.emit('join_chat', {
      chatId: currentChatId,
      sessionId: userSessionId
    });
  });

  socket.on('new_message', (msg) => {
    if (Number(msg.chat_id) === Number(currentChatId)) {
      document.getElementById('typingIndicator').style.display = 'none';
      appendChatMessage(msg);
    }
  });

  socket.on('user_typing', (data) => {
    if (data.role === 'owner') {
      document.getElementById('typingIndicator').style.display = 'block';
    }
  });

  socket.on('user_stop_typing', () => {
    document.getElementById('typingIndicator').style.display = 'none';
  });
}

function emitTyping() {
  if (!socket) return;
  socket.emit('typing');
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => socket.emit('stop_typing'), 1500);
}

async function loadChatMessages() {
  try {
    const res = await fetch(`/api/chat/${currentChatId}/messages?sessionId=${encodeURIComponent(userSessionId)}`);
    const data = await res.json();

    const box = document.getElementById('chatMessages');
    box.innerHTML = '';
    renderedMessageIds.clear();

    const messages = data.messages || [];
    if (messages.length === 0) {
      box.innerHTML = '<div style="text-align: center; color: var(--text-muted); margin: auto;">ابدأ المحادثة الآن بكتابة رسالة أدناه أو اختيار رد سريع.</div>';
      return;
    }

    messages.forEach(msg => appendChatMessage(msg, false));
    box.scrollTop = box.scrollHeight;
  } catch (err) {
    console.error(err);
  }
}

function appendChatMessage(msg, autoScroll = true) {
  if (msg.id && renderedMessageIds.has(msg.id)) return;
  if (msg.id) renderedMessageIds.add(msg.id);

  const box = document.getElementById('chatMessages');
  const div = document.createElement('div');

  let bubbleClass = 'msg-system';
  if (msg.sender_type === 'scanner') bubbleClass = 'msg-owner';
  else if (msg.sender_type === 'owner') bubbleClass = 'msg-scanner';

  let locationHtml = '';
  if (msg.lat && msg.lng) {
    const mapUrl = `https://www.google.com/maps?q=${msg.lat},${msg.lng}`;
    locationHtml = `
      <div class="msg-location-card">
        <i data-lucide="map-pin" style="width: 14px; height: 14px;"></i>
        <strong>الموقع:</strong>
        <a href="${mapUrl}" target="_blank" rel="noopener" style="text-decoration: underline; margin-right: 4px;">
          فتح الخريطة
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

async function handleSendMessage(e) {
  e.preventDefault();
  const input = document.getElementById('messageInput');
  const text = input.value.trim();
  if (!text || !currentChatId) return;

  input.value = '';
  if (socket) socket.emit('stop_typing');

  try {
    const payload = {
      message: text,
      sessionId: userSessionId,
      lat: userCoords ? userCoords.latitude : null,
      lng: userCoords ? userCoords.longitude : null
    };

    const res = await fetch(`/api/chat/${currentChatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      showToast('فشل في إرسال الرسالة، حاول مجدداً', 'error');
    }
  } catch (err) {
    console.error(err);
    showToast('تعذر الاتصال بالخادم', 'error');
  }
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
