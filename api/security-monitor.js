// api/security-monitor.js
// Vercel Serverless Function — called every hour by Vercel Cron
// Checks for suspicious login activity and sends alerts

import nodemailer from 'nodemailer';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GMAIL_USER   = process.env.GMAIL_USER;
const GMAIL_PASS   = process.env.GMAIL_APP_PASSWORD;

export default async function handler(req, res) {
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
    const now = new Date();
    const oneHourAgo = new Date(now - 60*60*1000).toISOString();

    // Get login logs from last hour
    const { data: logs } = await sb
      .from('login_logs')
      .select('*')
      .gte('login_at', oneHourAgo)
      .order('login_at', { ascending: false });

    if(!logs?.length) return res.json({ alerts: 0 });

    const alerts = [];

    // 1. Multiple failed logins (brute force)
    const failedByEmail = {};
    for(const log of logs.filter(l=>!l.success)){
      failedByEmail[log.email] = (failedByEmail[log.email]||0) + 1;
    }
    for(const [email, count] of Object.entries(failedByEmail)){
      if(count >= 3){
        alerts.push(`🚨 ${count} ניסיונות כניסה כושלים לחשבון ${email} בשעה האחרונה`);
      }
    }

    // 2. Login at unusual hours (between 1am-5am Israel time)
    const israelHour = (now.getUTCHours() + 3) % 24;
    const suspiciousHour = israelHour >= 1 && israelHour <= 5;
    if(suspiciousHour){
      const recentLogins = logs.filter(l=>l.success);
      if(recentLogins.length > 0){
        alerts.push(`⚠️ כניסה בשעה חריגה (${israelHour}:00) — ${recentLogins.map(l=>l.email).join(', ')}`);
      }
    }

    // 3. New user agent / device not seen before
    const { data: recentLogs } = await sb
      .from('login_logs')
      .select('email, user_agent')
      .lt('login_at', oneHourAgo)
      .gte('login_at', new Date(now - 30*24*60*60*1000).toISOString());

    const knownAgents = new Set((recentLogs||[]).map(l=>`${l.email}:${l.user_agent}`));
    for(const log of logs.filter(l=>l.success)){
      const key = `${log.email}:${log.user_agent}`;
      if(!knownAgents.has(key)){
        alerts.push(`🔔 כניסה ממכשיר חדש — ${log.email}`);
      }
    }

    if(alerts.length === 0) return res.json({ alerts: 0 });

    // Send security alert email
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_PASS },
    });

    await transporter.sendMail({
      from: `"אבטחת מערכת נכסים" <${GMAIL_USER}>`,
      to: GMAIL_USER,
      subject: `🔐 התראת אבטחה — ${alerts.length} אירועים (${now.toLocaleTimeString('he-IL')})`,
      html: `
        <div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;">
          <h2 style="color:#e85c4a;background:#1a1a2e;padding:16px;border-radius:8px;">
            🔐 התראת אבטחה — מערכת ניהול נכסים
          </h2>
          <p style="color:#666;">${now.toLocaleString('he-IL')}</p>
          <ul style="padding-right:20px;">
            ${alerts.map(a=>`<li style="margin-bottom:12px;padding:10px;background:#fff0f0;border-radius:6px;border-right:3px solid #e85c4a;">${a}</li>`).join('')}
          </ul>
          <p style="color:#999;font-size:12px;border-top:1px solid #eee;padding-top:12px;">
            אם זו פעילות תקינה, אין צורך בפעולה.<br>
            אם לא, שנה סיסמאות מיד והסר גישה חשודה.
          </p>
          <a href="https://rental-mgmt-three.vercel.app" 
             style="background:#e85c4a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;">
            כנס למערכת
          </a>
        </div>
      `,
    });

    return res.json({ alerts: alerts.length, sent: true });

  } catch(err) {
    console.error('security-monitor error:', err);
    return res.status(500).json({ error: err.message });
  }
}
