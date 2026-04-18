// src/LoginScreen.jsx
// Shows login form, pending message, or "access denied" screen

import { useState } from 'react'

export default function LoginScreen({ authStep, error, onSendLink, email }) {
  const [inputEmail, setInputEmail] = useState('')

  if (authStep === 'sent') {
    return (
      <Screen>
        <div style={{ fontSize: 48, marginBottom: 16 }}>📧</div>
        <div style={{ fontWeight: 800, fontSize: 22, color: '#e8c547', marginBottom: 12 }}>
          בדוק את המייל שלך
        </div>
        <div style={{ color: '#888', fontSize: 14, lineHeight: 1.7, maxWidth: 360, textAlign: 'center' }}>
          שלחנו קישור כניסה לכתובת<br />
          <strong style={{ color: '#ddd' }}>{inputEmail}</strong>
          <br /><br />
          לחץ על הקישור במייל כדי להיכנס.<br />
          הקישור תקף ל-10 דקות.
        </div>
        <button
          onClick={() => window.location.reload()}
          style={btnStyle('#2a2a4a', '#888')}
        >
          חזור
        </button>
      </Screen>
    )
  }

  return (
    <Screen>
      <div style={{ fontSize: 48, marginBottom: 12 }}>🏢</div>
      <div style={{ fontWeight: 900, fontSize: 24, color: '#e8c547', marginBottom: 4 }}>
        מערכת ניהול נכסים
      </div>
      <div style={{ color: '#555', fontSize: 13, marginBottom: 32 }}>
        הכנס את המייל שלך כדי להיכנס
      </div>

      <div style={{ width: '100%', maxWidth: 340 }}>
        <input
          type="email"
          placeholder="כתובת מייל"
          value={inputEmail}
          onChange={e => setInputEmail(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onSendLink(inputEmail)}
          style={{
            width: '100%', background: '#0e0e20', border: '1px solid #2a2a4a',
            color: '#ddd', padding: '12px 16px', borderRadius: 10,
            fontSize: 15, fontFamily: 'inherit', marginBottom: 12,
            outline: 'none', boxSizing: 'border-box', direction: 'ltr',
          }}
          autoFocus
        />
        {error && (
          <div style={{ color: '#e85c4a', fontSize: 13, marginBottom: 10, padding: '8px 12px', background: '#2a0a0a', borderRadius: 8 }}>
            ⚠️ {error}
          </div>
        )}
        <button
          onClick={() => onSendLink(inputEmail)}
          disabled={!inputEmail.includes('@')}
          style={{
            ...btnStyle('#e8c547', '#1a1a2e'),
            width: '100%', padding: '12px',
            opacity: !inputEmail.includes('@') ? 0.4 : 1,
          }}
        >
          שלח קישור כניסה →
        </button>
        <div style={{ color: '#444', fontSize: 11, marginTop: 12, textAlign: 'center', lineHeight: 1.6 }}>
          אין סיסמה — תקבל קישור ישירות למייל.<br />
          הגישה טעונה אישור של המנהל.
        </div>
      </div>
    </Screen>
  )
}

export function PendingScreen({ email, onSignOut }) {
  return (
    <Screen>
      <div style={{ fontSize: 48, marginBottom: 16 }}>⏳</div>
      <div style={{ fontWeight: 800, fontSize: 22, color: '#e8c547', marginBottom: 12 }}>
        ממתין לאישור
      </div>
      <div style={{ color: '#888', fontSize: 14, lineHeight: 1.7, maxWidth: 360, textAlign: 'center', marginBottom: 24 }}>
        נרשמת בהצלחה עם<br />
        <strong style={{ color: '#ddd' }}>{email}</strong>
        <br /><br />
        הגישה שלך ממתינה לאישור המנהל.<br />
        תקבל מייל כשהגישה תאושר.
      </div>
      <button onClick={onSignOut} style={btnStyle('#2a2a4a', '#888')}>
        התנתק
      </button>
    </Screen>
  )
}

function Screen({ children }) {
  return (
    <div style={{
      minHeight: '100vh', background: '#0a0a1a',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Segoe UI', Tahoma, sans-serif",
      color: '#ddd', direction: 'rtl', padding: 24, gap: 16,
    }}>
      {children}
    </div>
  )
}

const btnStyle = (bg, col) => ({
  background: bg, color: col, border: 'none', borderRadius: 10,
  padding: '10px 24px', cursor: 'pointer', fontWeight: 700,
  fontSize: 14, fontFamily: 'inherit',
})
