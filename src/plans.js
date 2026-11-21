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
      'حتى رمزي QR نشطين (2 QR)',
      'محادثات فورية ومشفرة بالكامل',
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
    badge: 'الأكثر طلباً ⭐',
    priceMonthly: 49,
    priceYearly: 470,
    currency: 'ج.م',
    maxItems: 15,
    maxScansView: 500,
    features: [
      'حتى 15 رمز QR للسيارات والمقتنيات',
      'استوديو الطباعة المتقدم (كل القوالب والألوان)',
      'وضع الطوارئ والمفقودات (Lost Mode Alert)',
      'تنبيهات تليجرام + إشعارات صوتية لحظية',
      'ربط Webhook مخصص (واتساب / Zapier)',
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
    badge: 'للشركات 🏢',
    priceMonthly: 199,
    priceYearly: 1900,
    currency: 'ج.م',
    maxItems: 10000,
    maxScansView: 10000,
    features: [
      'رموز QR غير محدودة للأساطيل والموظفين',
      'كل مميزات الباقة الاحترافية',
      'طباعة مجمّعة حتى 6 ملصقات بالصفحة',
      'تكامل كامل عبر Webhooks للأنظمة',
      'دعم فني مخصص وأولوية قصوى'
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

module.exports = { PLANS, getPlan };
