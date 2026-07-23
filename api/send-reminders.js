// api/send-reminders.js
// Vercel Serverless Function — called daily by Vercel Cron
// Checks for upcoming reminders and sends emails via Gmail SMTP

import nodemailer from 'nodemailer';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL  = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY; // service role key for server-side
const WORKSPACE_ID  = process.env.VITE_WORKSPACE_ID || 'rental-mgmt';
const GMAIL_USER    = process.env.GMAIL_USER;
const GMAIL_PASS    = process.env.GMAIL_APP_PASSWORD;
const ADMIN_EMAIL   = process.env.GMAIL_USER;

export default async function handler(req, res) {
  // Security: only allow Vercel Cron or manual trigger with secret
  const authHeader = req.headers.authorization;
  if(req.method !== 'GET' && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({error: 'Unauthorized'});
  }

  try {
    // 1. Load app data from Supabase
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data: row } = await sb
      .from('app_data')
      .select('payload')
      .eq('workspace_id', WORKSPACE_ID)
      .single();

    if(!row?.payload) return res.json({sent: 0, message: 'No data found'});

    // Get reminder recipients — admin always included
    const emailSettings = row.payload.emailSettings || {};
    const recipients = [...new Set([ADMIN_EMAIL, ...(emailSettings.reminderRecipients||[])])];

    const appData = row.payload;
    const units   = appData.units || [];
    const reminders = appData.reminders || [];
    const today   = new Date();
    const todayStr = today.toLocaleDateString('en-CA');

    const alerts = [];

    // 2. Check unit-level contract/guarantee dates
    for(const unit of units) {
      // Contract
      if(unit.contractEnd) {
        const diff = Math.ceil((new Date(unit.contractEnd) - today) / (1000*60*60*24));
        const alertDays = unit.contractAlertDays || 60;
        if(diff >= 0 && diff <= alertDays) {
          alerts.push(`⚠️ ${unit.name}: חוזה שכירות פוקע ב-${unit.contractEnd} (עוד ${diff} ימים)`);
        }
      }
      // Renewals
      for(const [i, r] of (unit.renewals||[]).entries()) {
        if(!r.endDate) continue;
        const diff = Math.ceil((new Date(r.endDate) - today) / (1000*60*60*24));
        if(diff >= 0 && diff <= (r.alertDays||60)) {
          alerts.push(`⚠️ ${unit.name}: הארכת חוזה ${i+1} פוקעת ב-${r.endDate} (עוד ${diff} ימים)`);
        }
      }
      // Guarantees
      for(const [i, g] of (unit.guarantees||[]).entries()) {
        if(!g.endDate) continue;
        const diff = Math.ceil((new Date(g.endDate) - today) / (1000*60*60*24));
        const label = i===0 ? 'ערבות בנקאית' : `הארכת ערבות ${i}`;
        if(diff >= 0 && diff <= (g.alertDays||30)) {
          alerts.push(`⚠️ ${unit.name}: ${label}${g.number?` מס' ${g.number}`:''} פוקעת ב-${g.endDate} (עוד ${diff} ימים)`);
        }
      }
      // Tenancy documents
      const activeTenancy = unit.tenancies?.find(t=>t.active);
      if(activeTenancy) {
        if(activeTenancy.contract?.expiryDate) {
          const diff = Math.ceil((new Date(activeTenancy.contract.expiryDate) - today) / (1000*60*60*24));
          if(diff >= 0 && diff <= (unit.contractAlertDays||60)) {
            alerts.push(`⚠️ ${unit.name}: חוזה שכירות (מסמך) פוקע ב-${activeTenancy.contract.expiryDate} (עוד ${diff} ימים)`);
          }
        }
        for(const [i, g] of (activeTenancy.guarantees||[]).entries()) {
          if(!g?.expiryDate) continue;
          const diff = Math.ceil((new Date(g.expiryDate) - today) / (1000*60*60*24));
          if(diff >= 0 && diff <= 30) {
            alerts.push(`⚠️ ${unit.name}: ערבות ${i+1} (מסמך) פוקעת ב-${g.expiryDate} (עוד ${diff} ימים)`);
          }
        }
      }
    }

    // 3. Check meter reading reminder (7 days before period end)
    const currentMonth = today.getMonth() + 1;
    const periodEndMonths = [1, 3, 5, 7, 9, 11];
    const nextEnd = periodEndMonths.find(m => m > currentMonth) || (periodEndMonths[0] + 12);
    const endYear = today.getFullYear() + (nextEnd > 12 ? 1 : 0);
    const endDate = new Date(endYear, (nextEnd > 12 ? nextEnd - 12 : nextEnd) - 1, 1);
    const daysToEnd = Math.ceil((endDate - today) / (1000*60*60*24));
    if(daysToEnd <= 7 && daysToEnd >= 0) {
      alerts.push(`📷 תזכורת: יש לצלם מוני מים וחשמל — סוף התקופה בעוד ${daysToEnd} ימים (${endDate.toLocaleDateString('he-IL')})`);
    }

    // 4. Check manual reminders due today or overdue
    for(const r of reminders) {
      if(r.done) continue;
      if(r.date <= todayStr) {
        const unit = units.find(u => u.id === +r.unitId);
        alerts.push(`🔔 תזכורת: ${r.title}${unit ? ` — ${unit.name}` : ''} (${r.date})`);
      }
    }

    if(alerts.length === 0) {
      return res.json({sent: 0, message: 'No alerts today'});
    }

    // 5. Send email via Gmail SMTP
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: GMAIL_USER,
        pass: GMAIL_PASS,
      },
    });

    const htmlBody = `
      <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #e8c547; background: #1a1a2e; padding: 16px; border-radius: 8px;">
          🏢 מערכת ניהול נכסים — תזכורות יומיות
        </h2>
        <p style="color: #666;">תאריך: ${today.toLocaleDateString('he-IL')}</p>
        <ul style="padding-right: 20px;">
          ${alerts.map(a => `<li style="margin-bottom: 12px; padding: 8px; background: #f9f9f9; border-radius: 4px;">${a}</li>`).join('')}
        </ul>
        <p style="color: #999; font-size: 12px; border-top: 1px solid #eee; padding-top: 12px;">
          <a href="https://rental-mgmt-three.vercel.app">כנס למערכת</a>
        </p>
      </div>
    `;

    await transporter.sendMail({
      from: `"מערכת ניהול נכסים" <${GMAIL_USER}>`,
      to: recipients.join(', '),
      subject: `🏢 תזכורות נכסים — ${alerts.length} התראות (${today.toLocaleDateString('he-IL')})`,
      html: htmlBody,
    });

    return res.json({sent: 1, alerts: alerts.length, message: 'Email sent successfully'});

  } catch(error) {
    console.error('send-reminders error:', error);
    return res.status(500).json({error: error.message});
  }
}
