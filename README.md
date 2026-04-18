# 🏢 מערכת ניהול נכסים — עם הרשאות משתמשים

---

## 🚀 הפעלה (20 דקות)

### שלב 1 — Supabase

1. היכנס ל-[supabase.com](https://supabase.com) → **New Project**
2. **SQL Editor** → הדבק את `supabase-setup.sql` ולחץ Run
   - **חשוב:** שנה `YOUR_ADMIN_EMAIL@example.com` למייל שלך לפני ריצה!
3. **Authentication → Providers → Email** → וודא שמופעל, בטל "Confirm email" (כדי שמגיק-לינק יעבוד)
4. **Project Settings → API** → רשום:
   - Project URL
   - anon public key


> ⚠️ **חשוב מאוד — Email Rate Limit:**
> Supabase מגביל את שירות המייל המובנה ל-**2 מיילים בשעה בלבד**.
> לפני שמשתמשים ב-production, חייבים להגדיר SMTP חיצוני:
>
> **אפשרות מומלצת — Resend (חינם עד 3000 מייל/חודש):**
> 1. הרשם ב-[resend.com](https://resend.com)
> 2. צור API Key
> 3. ב-Supabase → **Authentication → SMTP Settings** → Enable Custom SMTP
> 4. Host: `smtp.resend.com`, Port: `465`, User: `resend`, Password: `[API Key שלך]`
> 5. ב-**Authentication → Rate Limits** → הגדל ל-100+ מייל/שעה

---

### שלב 2 — Anthropic

1. [console.anthropic.com](https://console.anthropic.com) → צור API Key

---

### שלב 3 — GitHub

```bash
git init && git add . && git commit -m "init"
git remote add origin https://github.com/YOUR_USER/rental-app.git
git push -u origin main
```

---

### שלב 4 — Vercel

1. [vercel.com](https://vercel.com) → **Add New Project** → בחר repo
2. **Environment Variables** → הוסף:

| שם | ערך |
|---|---|
| `VITE_SUPABASE_URL` | מ-Supabase |
| `VITE_SUPABASE_ANON_KEY` | מ-Supabase |
| `VITE_WORKSPACE_ID` | שם ייחודי לבניין שלך |
| `ANTHROPIC_API_KEY` | מ-Anthropic |

3. **Deploy** → תקבל קישור כמו `https://rental-app.vercel.app`

---

## 👥 מערכת ההרשאות

### איך זה עובד:

1. **משתמש נכנס** → מזין מייל → מקבל קישור כניסה
2. **מצב ממתין** → המשתמש רואה "ממתין לאישור"
3. **אתה (מנהל) מאשר** → נכנס לאפליקציה → לוחץ 🔑 **ניהול משתמשים**
4. **בוחר הרשאה**: צפייה בלבד / עריכה מלאה

### סוגי הרשאות:

| תפקיד | צפייה | עריכה | ניהול משתמשים |
|---|---|---|---|
| **⏳ ממתין** | ❌ | ❌ | ❌ |
| **👁 צפייה** | ✅ | ❌ | ❌ |
| **✏️ עריכה** | ✅ | ✅ | ❌ |
| **🔑 מנהל** | ✅ | ✅ | ✅ |

### למי מתאים כל תפקיד:
- **צפייה** — שוכר שרוצה לראות את החשבונות שלו, רואה חשבון
- **עריכה** — שותף עסקי, עוזר שמנהל את הנכסים
- **מנהל** — אתה

---

## 📁 קבצים חשובים

```
src/
├── App.jsx            # האפליקציה הראשית
├── useAuth.js         # ניהול כניסה + הרשאות
├── LoginScreen.jsx    # מסך כניסה + ממתין
├── AdminPanel.jsx     # פאנל ניהול משתמשים
└── useSupabaseData.js # סנכרון נתונים
api/
└── claude.js          # proxy ל-Anthropic (API key בשרת)
supabase-setup.sql     # הגדרות DB (חד-פעמי)
```

---

## 🔄 עדכון הקוד

כל `git push` → Vercel מפרוס אוטומטית תוך 30 שניות.

---

## ❓ שאלות נפוצות

**האם הנתונים מסונכרנים בזמן אמת?**
כן — כל שינוי מסונכרן תוך ~5 שניות לכל המשתמשים.

**האם ה-API key בטוח?**
כן — הוא נמצא רק ב-Vercel (שרת), לעולם לא מגיע לדפדפן.

**כמה זה עולה?**
בחינם לגמרי עד שימוש גדול (Supabase + Vercel בחינם, Anthropic כמה שקלים לחודש).

---

## 🔧 פתרון בעיות נפוצות

**קישור המגיק לינק לא עובד?**
- וודא שב-Supabase → Authentication → Email → "Confirm email" מופעל
- הגדר Custom SMTP (ראה שלב 1)
- הקישור תקף 60 דקות בלבד

**"Pending" אחרי כניסה?**
- המנהל צריך לאשר את המשתמש דרך "ניהול משתמשים" 🔑

**שגיאת 429 (rate limit)?**
- הגדר Custom SMTP כמתואר בשלב 1

**נתונים לא מסתנכרנים?**
- בדוק שה-VITE_WORKSPACE_ID זהה בכל המשתמשים
- בדוק חיבור לאינטרנט
