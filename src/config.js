module.exports = {
  INSTAPAY_NUMBER: process.env.INSTAPAY_NUMBER || '01557527365',
  INSTAPAY_ACCOUNT_NAME: process.env.INSTAPAY_ACCOUNT_NAME || 'منصة واجد - Waged',
  VERIFICATION_SLA_HOURS: 24,
  SUPER_ADMIN_EMAIL: (process.env.SUPER_ADMIN_EMAIL || 'admin@waged.app').toLowerCase().trim(),
  SUPER_ADMIN_PASSWORD: process.env.SUPER_ADMIN_PASSWORD || 'WagedAdmin@2026!',
  SUPER_ADMIN_NAME: process.env.SUPER_ADMIN_NAME || 'مدير النظام الرئيسي'
};
