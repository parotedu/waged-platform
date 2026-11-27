let currentAdmin = null;
let currentFilter = 'pending';
let socket = null;
let searchTimer = null;

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
  document.getElementById('statApproved').textContent = stats.approvedRequests;
  document.getElementById('statTotalUsers').textContent = stats.totalUsers;
  document.getElementById('statPaidUsers').textContent = stats.activePaidUsers;
}

function showAdminTab(tab) {
  const map = {
    requests: ['requestsSection', 'tabReqBtn'],
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

    list.innerHTML = users.map(u => `
      <div class="card" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; padding: 16px 20px;">
        <div>
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <strong>${escapeHtml(u.name)}</strong>
            <span class="badge ${u.plan_id === 'free' ? 'badge-neutral' : 'badge-success'}">${escapeHtml((u.plan_id || 'free').toUpperCase())}</span>
            ${u.role === 'super_admin' ? '<span class="badge badge-primary">الحساب الرئيسي</span>' : ''}
            ${u.role === 'admin' ? '<span class="badge badge-primary">مسؤول تفعيل</span>' : ''}
          </div>
          <div style="font-size: 12.5px; color: var(--text-muted); margin-top: 4px;">
            <span class="mono">${escapeHtml(u.email)}</span>
            ${u.phone ? ` — <span class="mono">${escapeHtml(u.phone)}</span>` : ''}
            — رموز QR: ${u.items_count}
          </div>
        </div>
        <button type="button" class="btn btn-outline btn-sm" onclick="openManualPlanModal(${u.id}, '${escapeHtml(u.name)}', '${escapeHtml(u.plan_id || 'free')}')">
          <i data-lucide="pencil"></i>
          <span>تعديل الباقة</span>
        </button>
      </div>
    `).join('');
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

// Super Admin: Manage Activation Admins
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
