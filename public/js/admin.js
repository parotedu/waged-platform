let currentAdmin = null;
let currentFilter = 'pending';
let currentSubFilter = 'all';
let socket = null;
let searchTimer = null;
let subSearchTimer = null;

function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

document.addEventListener('DOMContentLoaded', () => {
  initAdminConsole();
});

async function initAdminConsole() {
  try {
    const res = await fetch('/api/admin/overview');
    if (res.status === 401) {
      showLoginGate();
      return;
    }
    if (res.status === 403) {
      showLoginGate('هذا الحساب لا يملك صلاحية الدخول للوحة تفعيل الحسابات. سجّل دخولك بالحساب الرئيسي أو حساب مسؤول معتمد.');
      return;
    }
    const data = await res.json();
    currentAdmin = data.admin;

    document.getElementById('adminLoginGate').style.display = 'none';
    document.getElementById('adminConsoleBody').style.display = 'block';
    document.getElementById('adminLogoutBtn').style.display = 'inline-flex';

    document.getElementById('adminRoleBadge').textContent = currentAdmin.isSuperAdmin ? 'الحساب الرئيسي' : 'مسؤول تفعيل';
    document.getElementById('adminWelcomeSub').textContent = `مرحباً ${currentAdmin.name} (${currentAdmin.email})`;

    if (currentAdmin.isSuperAdmin) {
      document.getElementById('tabAdminsBtn').style.display = 'inline-flex';
    }

    updateStats(data.stats);
    await loadRequests('pending');
    initAdminSocket();
    refreshIcons();
  } catch (err) {
    console.error(err);
    showLoginGate('تعذر الاتصال بالخادم');
  }
}

function showLoginGate(errorMsg = '') {
  document.getElementById('adminConsoleBody').style.display = 'none';
  document.getElementById('adminLoginGate').style.display = 'block';
  const errEl = document.getElementById('adminGateError');
  if (errorMsg) {
    errEl.textContent = errorMsg;
    errEl.style.display = 'block';
  } else {
    errEl.style.display = 'none';
  }
  refreshIcons();
}

async function handleAdminLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('adminLoginSubmitBtn');
  const errEl = document.getElementById('adminGateError');
  errEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'جاري التحقق...';

  try {
    const email = document.getElementById('adminEmailInput').value.trim();
    const password = document.getElementById('adminPassInput').value;

    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'بيانات الدخول غير صحيحة');

    await initAdminConsole();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'دخول لوحة التفعيل';
  }
}

async function handleAdminLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.reload();
}

function initAdminSocket() {
  if (socket) return;
  socket = io();
  socket.on('admin_payment_request', (reqData) => {
    showToast(`طلب تفعيل جديد من ${reqData.userName} (${reqData.amount} ج.م)`, 'info');
    refreshOverview();
    loadRequests(currentFilter);
  });
}

async function refreshOverview() {
  try {
    const res = await fetch('/api/admin/overview');
    if (res.ok) {
      const data = await res.json();
      updateStats(data.stats);
    }
  } catch (e) {}
}

function updateStats(stats) {
  document.getElementById('statPending').textContent = stats.pendingRequests;
  document.getElementById('pendingCountTab').textContent = stats.pendingRequests;
  document.getElementById('statPaidUsers').textContent = stats.activePaidUsers;
  document.getElementById('statExpiringSoon').textContent = stats.expiringSoonUsers || 0;
  document.getElementById('statExpired').textContent = stats.expiredUsers || 0;
  document.getElementById('expiredCountTab').textContent = stats.expiredUsers || 0;
  document.getElementById('statTotalUsers').textContent = stats.totalUsers;
}

function showAdminTab(tab) {
  const map = {
    requests: ['requestsSection', 'tabReqBtn'],
    subscriptions: ['subscriptionsSection', 'tabSubsBtn'],
    users: ['usersSection', 'tabUsersBtn'],
    admins: ['adminsSection', 'tabAdminsBtn']
  };
  Object.entries(map).forEach(([key, [secId, btnId]]) => {
    const sec = document.getElementById(secId);
    const btn = document.getElementById(btnId);
    if (sec) sec.style.display = key === tab ? 'block' : 'none';
    if (btn) btn.classList.toggle('active', key === tab);
  });

  if (tab === 'requests') loadRequests(currentFilter);
  else if (tab === 'subscriptions') loadSubscriptions(currentSubFilter);
  else if (tab === 'users') loadUsers();
  else if (tab === 'admins') loadAdmins();
}

async function loadRequests(status = 'pending') {
  currentFilter = status;
  ['Pending', 'Approved', 'Rejected', 'All'].forEach(name => {
    const btn = document.getElementById(`filter${name}`);
    if (btn) {
      btn.className = name.toLowerCase() === status ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm';
    }
  });

  const list = document.getElementById('requestsList');
  list.innerHTML = '<div class="card" style="text-align: center; color: var(--text-muted);">جاري التحميل...</div>';

  try {
    const res = await fetch(`/api/admin/requests?status=${encodeURIComponent(status)}`);
    const data = await res.json();
    const requests = data.requests || [];

    if (!requests.length) {
      list.innerHTML = '<div class="card" style="text-align: center; color: var(--text-muted); padding: 36px;">لا توجد طلبات في هذا التصنيف.</div>';
      return;
    }

    const planNames = { free: 'المجانية', pro: 'الاحترافية (Pro)', business: 'الأعمال (Business)' };
    const statusBadge = {
      pending: '<span class="badge badge-warning">قيد المراجعة</span>',
      approved: '<span class="badge badge-success">تم التفعيل</span>',
      rejected: '<span class="badge badge-danger">مرفوض</span>'
    };

    list.innerHTML = requests.map(r => `
      <div class="card" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px;">
        <div style="flex: 1; min-width: 260px;">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap;">
            <strong style="font-size: 16px;">${escapeHtml(r.user_name)}</strong>
            <span class="badge badge-primary">${planNames[r.plan_id] || r.plan_id} (${r.billing_cycle === 'yearly' ? 'سنوي' : 'شهري'})</span>
            ${statusBadge[r.status] || ''}
          </div>
          <div style="font-size: 13px; color: var(--text-secondary); display: flex; gap: 14px; flex-wrap: wrap;">
            <span>البريد: <span class="mono">${escapeHtml(r.user_email)}</span></span>
            <span>المبلغ: <strong>${r.amount} ${escapeHtml(r.currency)}</strong></span>
            <span>حساب/رقم المحول: <strong class="mono">${escapeHtml(r.sender_account)}</strong></span>
          </div>
          ${r.reference_note ? `<div style="font-size: 12.5px; color: var(--text-muted); margin-top: 4px;">ملاحظة المستخدم: ${escapeHtml(r.reference_note)}</div>` : ''}
          ${r.admin_note ? `<div style="font-size: 12.5px; color: var(--text-muted); margin-top: 4px;">ملاحظة الإدارة: ${escapeHtml(r.admin_note)} ${r.reviewer_name ? `(${escapeHtml(r.reviewer_name)})` : ''}</div>` : ''}
          <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 6px;">${new Date(r.created_at).toLocaleString('ar-EG')}</div>
        </div>

        <div style="display: flex; gap: 8px; align-items: center;">
          ${r.status === 'pending' ? `
            <button type="button" class="btn btn-primary btn-sm" onclick="openReviewModal(${r.id}, 'approve', '${escapeHtml(r.user_name)}', '${escapeHtml(planNames[r.plan_id] || r.plan_id)}')">
              <i data-lucide="check-circle-2"></i>
              <span>تفعيل الاشتراك</span>
            </button>
            <button type="button" class="btn btn-outline btn-sm" style="color: var(--danger);" onclick="openReviewModal(${r.id}, 'reject', '${escapeHtml(r.user_name)}', '${escapeHtml(planNames[r.plan_id] || r.plan_id)}')">
              <i data-lucide="x"></i>
              <span>رفض</span>
            </button>
          ` : ''}
        </div>
      </div>
    `).join('');
    refreshIcons(list);
  } catch (err) {
    list.innerHTML = '<div class="card" style="color: var(--danger);">فشل تحميل الطلبات</div>';
  }
}

// ============================================================
// Subscriptions Tracking, Countdown, Extension & Lock
// ============================================================

function debouncedSubSearch() {
  clearTimeout(subSearchTimer);
  subSearchTimer = setTimeout(() => loadSubscriptions(currentSubFilter), 250);
}

async function loadSubscriptions(filter = 'all') {
  currentSubFilter = filter;
  const filterBtnMap = {
    all: 'subFilterAll',
    active: 'subFilterActive',
    expiring_soon: 'subFilterExpiring',
    expired: 'subFilterExpired',
    free: 'subFilterFree'
  };
  Object.entries(filterBtnMap).forEach(([k, id]) => {
    const btn = document.getElementById(id);
    if (btn) btn.className = k === filter ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm';
  });

  const q = document.getElementById('subSearchInput').value.trim();
  const list = document.getElementById('subscriptionsList');
  list.innerHTML = '<div class="card" style="text-align: center; color: var(--text-muted);">جاري التحميل...</div>';

  try {
    const res = await fetch(`/api/admin/subscriptions?filter=${encodeURIComponent(filter)}&q=${encodeURIComponent(q)}`);
    const data = await res.json();
    const subs = data.subscriptions || [];

    if (!subs.length) {
      list.innerHTML = '<div class="card" style="text-align: center; color: var(--text-muted); padding: 36px;">لا توجد اشتراكات مطابقة.</div>';
      return;
    }

    const planNames = { free: 'المجانية', pro: 'الاحترافية (Pro)', business: 'الأعمال (Business)' };
    const stateBadges = {
      active: '<span class="badge badge-success">اشتراك نشط</span>',
      expiring_soon: '<span class="badge badge-warning">ينتهي قريباً</span>',
      expired: '<span class="badge badge-danger">منتهي ومقفول</span>',
      free: '<span class="badge badge-neutral">مجاني</span>'
    };

    list.innerHTML = subs.map(s => {
      const t = s.timing;
      const expDateText = s.subscription_expires_at
        ? new Date(s.subscription_expires_at).toLocaleString('ar-EG')
        : '—';

      return `
        <div class="card" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 14px; padding: 18px 20px;">
          <div style="flex: 1; min-width: 260px;">
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px;">
              <strong style="font-size: 15.5px;">${escapeHtml(s.name)}</strong>
              <span class="badge badge-primary">${planNames[s.plan_id] || s.plan_id}</span>
              ${stateBadges[t.state] || ''}
            </div>
            <div style="font-size: 13px; color: var(--text-secondary); display: flex; gap: 14px; flex-wrap: wrap;">
              <span>البريد: <span class="mono">${escapeHtml(s.email)}</span></span>
              ${s.phone ? `<span>الهاتف: <span class="mono">${escapeHtml(s.phone)}</span></span>` : ''}
              <span>رموز QR: <strong>${s.items_count}</strong></span>
            </div>
            <div style="font-size: 12.5px; margin-top: 6px; display: flex; gap: 14px; flex-wrap: wrap; color: ${t.isExpired ? 'var(--danger)' : (t.isExpiringSoon ? 'var(--warning)' : 'var(--text-muted)')};">
              <span style="display: inline-flex; align-items: center; gap: 5px; font-weight: 600;">
                <i data-lucide="clock" style="width: 13px; height: 13px;"></i>
                <span>${escapeHtml(t.remainingLabel)}</span>
              </span>
              ${s.subscription_expires_at ? `<span>تاريخ الانتهاء: ${expDateText}</span>` : ''}
            </div>
          </div>

          <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <button type="button" class="btn btn-primary btn-sm" onclick="quickExtendUser(${s.id}, 30, '${escapeHtml(s.plan_id)}')">
              <i data-lucide="plus"></i>
              <span>تمديد +30 يوم</span>
            </button>
            <button type="button" class="btn btn-outline btn-sm" onclick="openExtendModal(${s.id}, '${escapeHtml(s.name)}', '${escapeHtml(s.plan_id)}', '${escapeHtml(t.remainingLabel)}')">
              <i data-lucide="pencil"></i>
              <span>تمديد مخصص</span>
            </button>
            ${t.isPaid && !t.isExpired ? `
              <button type="button" class="btn btn-outline btn-sm" style="color: var(--danger);" onclick="expireUserNow(${s.id}, '${escapeHtml(s.name)}')">
                <i data-lucide="lock"></i>
                <span>قفل الآن</span>
              </button>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');
    refreshIcons(list);
  } catch (err) {
    list.innerHTML = '<div class="card" style="color: var(--danger);">فشل تحميل الاشتراكات</div>';
  }
}

async function quickExtendUser(userId, days, currentPlanId) {
  const planId = (currentPlanId && currentPlanId !== 'free') ? currentPlanId : 'pro';
  try {
    const res = await fetch(`/api/admin/users/${userId}/extend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days, planId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast(data.message, 'success');
    await Promise.all([refreshOverview(), loadSubscriptions(currentSubFilter)]);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openExtendModal(id, name, currentPlanId, remainingLabel) {
  document.getElementById('extendUserId').value = id;
  document.getElementById('extendModalTitle').textContent = `تمديد اشتراك: ${name}`;
  document.getElementById('extendUserSubInfo').textContent = `الحالة الحالية: ${remainingLabel}`;
  document.getElementById('extendPlanSelect').value = (currentPlanId && currentPlanId !== 'free') ? currentPlanId : 'pro';
  document.getElementById('extendDaysInput').value = 30;
  document.getElementById('extendModal').classList.add('active');
}

function closeExtendModal() {
  document.getElementById('extendModal').classList.remove('active');
}

function setExtendDays(d) {
  document.getElementById('extendDaysInput').value = d;
}

async function submitExtendSubscription(e) {
  e.preventDefault();
  const id = document.getElementById('extendUserId').value;
  const planId = document.getElementById('extendPlanSelect').value;
  const days = Number(document.getElementById('extendDaysInput').value);

  try {
    const res = await fetch(`/api/admin/users/${id}/extend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId, days })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    closeExtendModal();
    showToast(data.message, 'success');
    await Promise.all([refreshOverview(), loadSubscriptions(currentSubFilter)]);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function expireUserNow(userId, name) {
  try {
    const res = await fetch(`/api/admin/users/${userId}/expire`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast(`تم قفل اشتراك (${name})`, 'info');
    await Promise.all([refreshOverview(), loadSubscriptions(currentSubFilter)]);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openReviewModal(id, type, userName, planName) {
  document.getElementById('reviewReqId').value = id;
  document.getElementById('reviewActionType').value = type;
  document.getElementById('reviewAdminNote').value = '';

  const btn = document.getElementById('reviewConfirmBtn');
  if (type === 'approve') {
    document.getElementById('reviewModalTitle').textContent = 'تأكيد تفعيل الاشتراك';
    document.getElementById('reviewModalDesc').textContent = `تفعيل (${planName}) لحساب المستخدم (${userName}) بعد التحقق من وصول مبلغ التحويل على إنستا باي.`;
    btn.className = 'btn btn-primary btn-sm';
    btn.textContent = 'تأكيد التفعيل';
  } else {
    document.getElementById('reviewModalTitle').textContent = 'رفض طلب التحويل';
    document.getElementById('reviewModalDesc').textContent = `رفض طلب الترقية الخاص بالمستخدم (${userName}). يمكنك كتابة السبب ليظهر له.`;
    btn.className = 'btn btn-danger btn-sm';
    btn.textContent = 'تأكيد الرفض';
  }
  document.getElementById('reviewModal').classList.add('active');
  refreshIcons(document.getElementById('reviewModal'));
}

function closeReviewModal() {
  document.getElementById('reviewModal').classList.remove('active');
}

async function submitReviewDecision(e) {
  e.preventDefault();
  const id = document.getElementById('reviewReqId').value;
  const type = document.getElementById('reviewActionType').value;
  const adminNote = document.getElementById('reviewAdminNote').value.trim();

  try {
    const res = await fetch(`/api/admin/requests/${id}/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminNote })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'تعذر تنفيذ الإجراء');

    closeReviewModal();
    showToast(data.message, type === 'approve' ? 'success' : 'info');
    await Promise.all([refreshOverview(), loadRequests(currentFilter)]);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function debouncedUserSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadUsers, 250);
}

async function loadUsers() {
  const q = document.getElementById('userSearchInput').value.trim();
  const list = document.getElementById('usersList');
  list.innerHTML = '<div class="card" style="text-align: center; color: var(--text-muted);">جاري التحميل...</div>';

  try {
    const res = await fetch(`/api/admin/users?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    const users = data.users || [];

    if (!users.length) {
      list.innerHTML = '<div class="card" style="text-align: center; color: var(--text-muted);">لا يوجد مستخدمون مطابقون للبحث.</div>';
      return;
    }

    list.innerHTML = users.map(u => {
      const t = u.timing || {};
      return `
        <div class="card" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; padding: 16px 20px;">
          <div>
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <strong>${escapeHtml(u.name)}</strong>
              <span class="badge ${t.isExpired ? 'badge-danger' : (u.plan_id === 'free' ? 'badge-neutral' : 'badge-success')}">${escapeHtml((u.plan_id || 'free').toUpperCase())}${t.isExpired ? ' (منتهي)' : ''}</span>
              ${u.role === 'super_admin' ? '<span class="badge badge-primary">الحساب الرئيسي</span>' : ''}
              ${u.role === 'admin' ? '<span class="badge badge-primary">مسؤول تفعيل</span>' : ''}
            </div>
            <div style="font-size: 12.5px; color: var(--text-muted); margin-top: 4px;">
              <span class="mono">${escapeHtml(u.email)}</span>
              ${u.phone ? ` — <span class="mono">${escapeHtml(u.phone)}</span>` : ''}
              — رموز QR: ${u.items_count}
              ${t.remainingLabel ? ` — <span>${escapeHtml(t.remainingLabel)}</span>` : ''}
            </div>
          </div>
          <button type="button" class="btn btn-outline btn-sm" onclick="openManualPlanModal(${u.id}, '${escapeHtml(u.name)}', '${escapeHtml(u.plan_id || 'free')}')">
            <i data-lucide="pencil"></i>
            <span>تعديل الباقة</span>
          </button>
        </div>
      `;
    }).join('');
    refreshIcons(list);
  } catch (err) {
    list.innerHTML = '<div class="card" style="color: var(--danger);">فشل تحميل المستخدمين</div>';
  }
}

function openManualPlanModal(id, name, currentPlan) {
  document.getElementById('manualPlanUserId').value = id;
  document.getElementById('manualPlanTitle').textContent = `تعديل باقة: ${name}`;
  document.getElementById('manualPlanSelect').value = currentPlan;
  document.getElementById('manualPlanModal').classList.add('active');
}
function closeManualPlanModal() {
  document.getElementById('manualPlanModal').classList.remove('active');
}

async function submitManualPlan(e) {
  e.preventDefault();
  const id = document.getElementById('manualPlanUserId').value;
  const planId = document.getElementById('manualPlanSelect').value;
  const days = document.getElementById('manualPlanDays').value;

  try {
    const res = await fetch(`/api/admin/users/${id}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId, days })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    closeManualPlanModal();
    showToast(data.message, 'success');
    await Promise.all([refreshOverview(), loadUsers()]);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadAdmins() {
  const list = document.getElementById('adminsList');
  list.innerHTML = '<div style="color: var(--text-muted); text-align: center;">جاري التحميل...</div>';

  try {
    const res = await fetch('/api/admin/admins');
    if (!res.ok) return;
    const data = await res.json();
    const admins = data.admins || [];

    list.innerHTML = admins.map(a => `
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; background: var(--bg-subtle); border: 1px solid var(--card-border); border-radius: var(--radius-sm); gap: 10px; flex-wrap: wrap;">
        <div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <strong style="font-size: 14px;">${escapeHtml(a.name)}</strong>
            <span class="badge ${a.role === 'super_admin' ? 'badge-primary' : 'badge-success'}">
              ${a.role === 'super_admin' ? 'الحساب الرئيسي' : 'مسؤول تفعيل'}
            </span>
          </div>
          <div class="mono" style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">${escapeHtml(a.email)}</div>
        </div>
        ${a.role !== 'super_admin' ? `
          <button type="button" class="btn btn-outline btn-sm" style="color: var(--danger);" onclick="revokeAdmin(${a.id}, '${escapeHtml(a.email)}')">
            <i data-lucide="trash-2"></i>
            <span>إزالة</span>
          </button>
        ` : ''}
      </div>
    `).join('');
    refreshIcons(list);
  } catch (err) {
    console.error(err);
  }
}

async function handleAddAdmin(e) {
  e.preventDefault();
  const btn = document.getElementById('addAdminBtn');
  btn.disabled = true;

  const payload = {
    email: document.getElementById('newAdminEmail').value.trim(),
    name: document.getElementById('newAdminName').value.trim(),
    password: document.getElementById('newAdminPass').value
  };

  try {
    const res = await fetch('/api/admin/admins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'فشل إضافة المسؤول');

    showToast(data.message, 'success');
    e.target.reset();
    await loadAdmins();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function revokeAdmin(id, email) {
  try {
    const res = await fetch(`/api/admin/admins/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast(`تمت إزالة صلاحية المسؤول عن ${email}`, 'info');
    await loadAdmins();
  } catch (err) {
    showToast(err.message, 'error');
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
