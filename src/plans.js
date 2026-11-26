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
 * Returns the active plan for a user, falling back to free if a paid plan expired.
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
    if (!Number.isNaN(exp.getTime()) && exp.getTime() < Date.now()) {
      return PLANS.free;
    }
  }
  return getPlan(user.plan_id);
}

module.exports = { PLANS, getPlan, getEffectivePlan };
