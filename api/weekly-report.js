// api/weekly-report.js
// Vercel Serverless Function — called every Sunday at 7:00
// Sends a weekly health report about the rental properties

import nodemailer from 'nodemailer';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL  = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const WORKSPACE_ID  = process.env.VITE_WORKSPACE_ID || 'rental-mgmt';
const GMAIL_USER    = process.env.GMAIL_USER;
const GMAIL_PASS    = process.env.GMAIL_APP_PASSWORD;

const fmt = (n) => '₪' + Number(n||0).toLocaleString('he-IL');

export default async function handler(req, res) {
  try {
    // Load app data
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data: row } = await sb
      .from('app_data')
      .select('payload')
      .eq('workspace_id', WORKSPACE_ID)
      .single();

    if(!row?.payload) return res.json({error: 'No data'});

    const { units=[], bills={}, tariffs, reminders=[] } = row.payload;
    const today = new Date();
    const todayStr = today.toLocaleDateString('en-CA');

    // ── 1. Vacant units ─────────────────────────────────────────
    const vacantUnits = units.filter(u => u.vacant);

    // ── 2. Open bills older than 30 days ────────────────────────
    const oldOpenBills = [];
    for(const [key, bill] of Object.entries(bills)) {
      if(bill.paid) continue;
      const [uid, period] = key.split('_');
      const unit = units.find(u => u.id === +uid);
      if(!unit) continue;
      const periodDate = new Date(period + '-01');
      const ageDays = Math.ceil((today - periodDate) / (1000*60*60*24));
      if(ageDays > 30) {
        const tenant = unit.tenancies?.find(t=>t.active)?.tenants?.[0]?.name
          || unit.tenants?.find(t=>t.active)?.name || 'ללא שוכר';
        oldOpenBills.push({ unit: unit.name, tenant, period, ageDays });
      }
    }

    // ── 3. Units missing security details ───────────────────────
    const missingSecurityInfo = [];
    for(const unit of units) {
      if(unit.vacant) continue;
      const issues = [];
      if(!(unit.guarantees||[]).length) issues.push('אין בטחון מוגדר');
      else {
        for(const g of unit.guarantees) {
          if(!g.amount) issues.push('בטחון ללא סכום');
          if(!g.endDate && !g.checkDate && g.type !== 'deposit') issues.push('בטחון ללא תאריך פקיעה');
        }
      }
      if(!unit.contractEnd && !(unit.renewals||[]).some(r=>r.endDate)) issues.push('אין תאריך סיום חוזה');
      if(issues.length) missingSecurityInfo.push({ unit: unit.name, issues });
    }

    // ── 4. Units missing tenant details ─────────────────────────
    const missingTenantInfo = [];
    for(const unit of units) {
      if(unit.vacant) continue;
      const activeTenancy = unit.tenancies?.find(t=>t.active);
      const tenants = activeTenancy?.tenants || unit.tenants?.filter(t=>t.active) || [];
      const issues = [];
      if(!tenants.length) { issues.push('אין שוכר מוגדר'); }
      else {
        for(const t of tenants) {
          if(!t.phone) issues.push(`${t.name||'שוכר'}: חסר טלפון`);
          if(!t.idNum) issues.push(`${t.name||'שוכר'}: חסרה ת.ז.`);
        }
      }
      if(issues.length) missingTenantInfo.push({ unit: unit.name, issues });
    }

    // ── 5. Upcoming reminders this week ─────────────────────────
    const weekFromNow = new Date(today);
    weekFromNow.setDate(weekFromNow.getDate() + 7);
    const weekFromNowStr = weekFromNow.toLocaleDateString('en-CA');
    const upcomingReminders = reminders.filter(r =>
      !r.done && r.date >= todayStr && r.date <= weekFromNowStr
    );

    // ── 6. Monthly income summary ────────────────────────────────
    const paidThisMonth = Object.entries(bills)
      .filter(([, b]) => b.paid && b.paidDate && b.paidDate.startsWith(todayStr.substring(0,7)))
      .reduce((sum, [key, b]) => {
        const uid = key.split('_')[0];
        const unit = units.find(u => u.id === +uid);
        return sum + (b.lockedAmount || (unit?.rent*2||0));
      }, 0);

    // ── Build HTML report ────────────────────────────────────────
    const section = (title, icon, color, content) => content ? `
      <div style="margin-bottom:24px;">
        <h3 style="color:${color};border-bottom:2px solid ${color};padding-bottom:8px;">
          ${icon} ${title}
        </h3>
        ${content}
      </div>` : '';

    const listItem = (text, sub='') => `
      <li style="margin-bottom:8px;padding:8px;background:#f9f9f9;border-radius:4px;border-right:3px solid #e8c547;">
        ${text}${sub?`<br><span style="color:#666;font-size:12px;">${sub}</span>`:''}
      </li>`;

    const vacantHtml = vacantUnits.length
      ? `<ul style="padding-right:20px;">${vacantUnits.map(u=>listItem(`🏠 ${u.name}`, 'יחידה ריקה')).join('')}</ul>`
      : '<p style="color:#4caf88;">✅ כל היחידות מאוכלסות</p>';

    const openBillsHtml = oldOpenBills.length
      ? `<ul style="padding-right:20px;">${oldOpenBills.map(b=>listItem(`${b.unit}`, `שוכר: ${b.tenant} · תקופה: ${b.period} · ${b.ageDays} ימים פתוח`)).join('')}</ul>`
      : '<p style="color:#4caf88;">✅ אין חשבונות פתוחים ישנים</p>';

    const securityHtml = missingSecurityInfo.length
      ? `<ul style="padding-right:20px;">${missingSecurityInfo.map(m=>listItem(m.unit, m.issues.join(', '))).join('')}</ul>`
      : '<p style="color:#4caf88;">✅ כל הבטחונות מוגדרים</p>';

    const tenantHtml = missingTenantInfo.length
      ? `<ul style="padding-right:20px;">${missingTenantInfo.map(m=>listItem(m.unit, m.issues.join(', '))).join('')}</ul>`
      : '<p style="color:#4caf88;">✅ פרטי כל השוכרים מלאים</p>';

    const remindersHtml = upcomingReminders.length
      ? `<ul style="padding-right:20px;">${upcomingReminders.map(r=>listItem(`🔔 ${r.title}`, r.date)).join('')}</ul>`
      : '<p style="color:#888;">אין תזכורות לשבוע הקרוב</p>';

    const totalIssues = vacantUnits.length + oldOpenBills.length + missingSecurityInfo.length + missingTenantInfo.length;

    const html = `
      <div dir="rtl" style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#333;">
        <div style="background:#1a1a2e;padding:20px;border-radius:8px;margin-bottom:24px;text-align:center;">
          <h1 style="color:#e8c547;margin:0;">🏢 דוח שבועי — ניהול נכסים</h1>
          <p style="color:#888;margin:8px 0 0;">${today.toLocaleDateString('he-IL', {weekday:'long',year:'numeric',month:'long',day:'numeric'})}</p>
        </div>

        ${totalIssues===0
          ? '<div style="background:#1a3a1a;border:1px solid #4caf88;border-radius:8px;padding:16px;text-align:center;margin-bottom:24px;"><p style="color:#4caf88;font-size:18px;margin:0;">✅ הכל תקין — אין פריטים הדורשים טיפול</p></div>'
          : `<div style="background:#2a1a0a;border:1px solid #e8c547;border-radius:8px;padding:16px;text-align:center;margin-bottom:24px;"><p style="color:#e8c547;font-size:16px;margin:0;">⚠️ ${totalIssues} פריטים הדורשים תשומת לב</p></div>`
        }

        <div style="background:#f0f8ff;border-radius:8px;padding:16px;margin-bottom:24px;text-align:center;">
          <h3 style="color:#1a1a2e;margin:0 0 8px;">💰 הכנסות שגויתגו החודש</h3>
          <p style="font-size:28px;color:#4caf88;font-weight:bold;margin:0;">${fmt(paidThisMonth)}</p>
        </div>

        ${section('דירות ריקות', '🏠', '#e85c4a', vacantHtml)}
        ${section('חשבונות פתוחים (מעל 30 יום)', '⏳', '#e8c547', openBillsHtml)}
        ${section('פרטי בטחונות חסרים', '🔐', '#a78bfa', securityHtml)}
        ${section('פרטי שוכרים חסרים', '👥', '#6bc5f8', tenantHtml)}
        ${section('תזכורות לשבוע הקרוב', '🔔', '#4caf88', remindersHtml)}

        <div style="border-top:1px solid #eee;padding-top:16px;text-align:center;">
          <a href="https://rental-mgmt-three.vercel.app" 
             style="background:#e8c547;color:#1a1a2e;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
            כנס למערכת
          </a>
          <p style="color:#aaa;font-size:11px;margin-top:16px;">
            דוח זה נשלח אוטומטית כל יום ראשון בשעה 7:00
          </p>
        </div>
      </div>
    `;

    // Send email
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_PASS },
    });

    await transporter.sendMail({
      from: `"מערכת ניהול נכסים" <${GMAIL_USER}>`,
      to: GMAIL_USER,
      subject: `🏢 דוח שבועי — ${totalIssues ? totalIssues+' פריטים לטיפול' : 'הכל תקין'} · ${today.toLocaleDateString('he-IL')}`,
      html,
    });

    return res.json({ sent: true, issues: totalIssues });

  } catch(err) {
    console.error('weekly-report error:', err);
    return res.status(500).json({ error: err.message });
  }
}
