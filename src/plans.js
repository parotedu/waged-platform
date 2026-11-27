const PLANS = {
  free: {
    id: 'free',
    name: 'الباقة المجانية',
    badge: 'مجانية للأبد',
    priceMonthly: 0,
    priceYearly: 0,
    currency: 'ج.م',
    maxItems: 2,
    maxScansView: 15,
    features: [
      'حتى رمزي QR نشطين',
      'محادثة فورية مشفرة ومجهولة',
      'التقاط الموقع الجغرافي (GPS)',
      'تنبيهات تليجرام الفورية',
      'قوالب طباعة الملصقات الأساسية'
    ],
    capabilities: {
      webhookAlerts: false,
      printStudioPro: false,
      lostMode: true
    }
  },
  pro: {
    id: 'pro',
    name: 'الباقة الاحترافية',
    badge: 'الأكثر طلباً',
    priceMonthly: 49,
    priceYearly: 470,
    currency: 'ج.م',
    maxItems: 15,
    maxScansView: 500,
    features: [
      'حتى 15 رمز QR للسيارات والمقتنيات',
      'استوديو الطباعة المتقدم بكل القوالب',
      'وضع الطوارئ والمفقودات الفوري',
      'تنبيهات تليجرام + إشعارات صوتية لحظية',
      'ربط Webhook مخصص (واتساب / الأتمتة)',
      'سجل مواقع جغرافية موسّع'
    ],
    capabilities: {
      webhookAlerts: true,
      printStudioPro: true,
      lostMode: true
    }
  },
  business: {
    id: 'business',
    name: 'باقة الأعمال والأساطيل',
    badge: 'للشركات',
    priceMonthly: 199,
    priceYearly: 1900,
    currency: 'ج.م',
    maxItems: 10000,
    maxScansView: 10000,
    features: [
      'رموز QR غير محدودة للأساطيل والموظفين',
      'جميع مميزات الباقة الاحترافية',
      'طباعة مجمّعة حتى 6 ملصقات بالصفحة',
      'تكامل كامل عبر Webhooks للأنظمة',
      'أولوية قصوى ودعم فني مخصص'
    ],
    capabilities: {
      webhookAlerts: true,
      printStudioPro: true,
      lostMode: true
    }
  }
};

function getPlan(planId) {
  return PLANS[planId] || PLANS.free;
}

/**
 * Returns the effective active plan for a user, falling back to free if expired or locked.
 */
function getEffectivePlan(user) {
  if (!user || !user.plan_id || user.plan_id === 'free') {
    return PLANS.free;
  }
  if (user.subscription_status && user.subscription_status !== 'active') {
    return PLANS.free;
  }
  if (user.subscription_expires_at) {
    const exp = new Date(user.subscription_expires_at);
    if (!Number.isNaN(exp.getTime()) && exp.getTime() <= Date.now()) {
      return PLANS.free;
    }
  }
  return getPlan(user.plan_id);
}

/**
 * Computes exact remaining time and status classification for admin & user dashboards.
 */
function getSubscriptionTiming(user) {
  const planId = user?.plan_id || 'free';
  const assignedPlan = getPlan(planId);

  if (planId === 'free') {
    return {
      state: 'free',
      isPaid: false,
      isExpired: false,
      isExpiringSoon: false,
      remainingMs: null,
      remainingDays: null,
      remainingHours: null,
      remainingLabel: 'دائم بدون انتهاء',
      assignedPlan
    };
  }

  const now = Date.now();
  const expTime = user.subscription_expires_at ? new Date(user.subscription_expires_at).getTime() : null;
  const statusExpired = user.subscription_status === 'expired';

  if (statusExpired || (expTime !== null && expTime <= now)) {
    const elapsedMs = expTime ? Math.max(0, now - expTime) : 0;
    const elapsedDays = Math.floor(elapsedMs / (24 * 60 * 60 * 1000));
    const elapsedHours = Math.floor((elapsedMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));

    let label = 'انتهى الاشتراك';
    if (expTime) {
      if (elapsedDays >= 1) label = `منتهي منذ ${elapsedDays} يوم`;
      else if (elapsedHours >= 1) label = `منتهي منذ ${elapsedHours} ساعة`;
      else label = 'انتهى للتو';
    }

    return {
      state: 'expired',
      isPaid: true,
      isExpired: true,
      isExpiringSoon: false,
      remainingMs: 0,
      remainingDays: 0,
      remainingHours: 0,
      remainingLabel: label,
      assignedPlan
    };
  }

  if (expTime === null) {
    return {
      state: 'active',
      isPaid: true,
      isExpired: false,
      isExpiringSoon: false,
      remainingMs: null,
      remainingDays: null,
      remainingHours: null,
      remainingLabel: 'مفتوح المدة',
      assignedPlan
    };
  }

  const remainingMs = expTime - now;
  const remainingDays = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
  const remainingHours = Math.floor((remainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
  const isExpiringSoon = remainingMs <= threeDaysMs;

  let remainingLabel = '';
  if (remainingDays >= 1) {
    remainingLabel = remainingHours > 0
      ? `متبقي ${remainingDays} يوم و ${remainingHours} ساعة`
      : `متبقي ${remainingDays} يوم`;
  } else if (remainingHours >= 1) {
    remainingLabel = `متبقي ${remainingHours} ساعة`;
  } else {
    const mins = Math.max(1, Math.floor(remainingMs / 60000));
    remainingLabel = `متبقي ${mins} دقيقة`;
  }

  return {
    state: isExpiringSoon ? 'expiring_soon' : 'active',
    isPaid: true,
    isExpired: false,
    isExpiringSoon,
    remainingMs,
    remainingDays,
    remainingHours,
    remainingLabel,
    assignedPlan
  };
}

module.exports = { PLANS, getPlan, getEffectivePlan, getSubscriptionTiming };
