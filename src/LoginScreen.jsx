// src/LoginScreen.jsx
// Shows login form, pending message, or "access denied" screen

import { useState } from 'react'

export default function LoginScreen({ authStep, error, onSendLink, onSignInPassword, onGoogleLogin, email }) {
  const [inputEmail, setInputEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState('password') // 'magic' | 'password'

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
      <div style={{ color: '#555', fontSize: 13, marginBottom: 24 }}>
        הכנס את המייל שלך כדי להיכנס
      </div>

      <div style={{ width: '100%', maxWidth: 340 }}>

        {/* Google Sign-In Button */}
        <button
          onClick={onGoogleLogin}
          style={{
            width: '100%', padding: '12px', marginBottom: 16,
            background: '#fff', color: '#333', border: '1px solid #ddd',
            borderRadius: 10, cursor: 'pointer', fontWeight: 700,
            fontSize: 14, fontFamily: 'inherit',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
          }}
        >
          <svg width="18" height="18" viewBox="0 0 48 48">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
          </svg>
          כניסה עם Google
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <div style={{ flex: 1, height: 1, background: '#2a2a4a' }}/>
          <div style={{ color: '#444', fontSize: 12 }}>או</div>
          <div style={{ flex: 1, height: 1, background: '#2a2a4a' }}/>
        </div>

        <input
          type="email"
          placeholder="כתובת מייל"
          value={inputEmail}
          onChange={e => setInputEmail(e.target.value)}
          style={{
            width: '100%', background: '#0e0e20', border: '1px solid #2a2a4a',
            color: '#ddd', padding: '12px 16px', borderRadius: 10,
            fontSize: 15, fontFamily: 'inherit', marginBottom: 12,
            outline: 'none', boxSizing: 'border-box', direction: 'ltr',
          }}
        />
        {mode === 'password' && (
          <input
            type="password"
            placeholder="סיסמה"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && onSignInPassword(inputEmail, password)}
            style={{
              width: '100%', background: '#0e0e20', border: '1px solid #2a2a4a',
              color: '#ddd', padding: '12px 16px', borderRadius: 10,
              fontSize: 15, fontFamily: 'inherit', marginBottom: 12,
              outline: 'none', boxSizing: 'border-box', direction: 'ltr',
            }}
          />
        )}
        {error && (
          <div style={{ color: '#e85c4a', fontSize: 13, marginBottom: 10, padding: '8px 12px', background: '#2a0a0a', borderRadius: 8 }}>
            ⚠️ {error}
          </div>
        )}
        {mode === 'magic' ? (
          <button
            onClick={() => onSendLink(inputEmail)}
            disabled={!inputEmail.includes('@')}
            style={{ ...btnStyle('#e8c547', '#1a1a2e'), width: '100%', padding: '12px', opacity: !inputEmail.includes('@') ? 0.4 : 1 }}
          >
            שלח קישור כניסה →
          </button>
        ) : (
          <button
            onClick={() => onSignInPassword(inputEmail, password)}
            disabled={!inputEmail.includes('@') || !password}
            style={{ ...btnStyle('#e8c547', '#1a1a2e'), width: '100%', padding: '12px', opacity: (!inputEmail.includes('@') || !password) ? 0.4 : 1 }}
          >
            כניסה עם סיסמה →
          </button>
        )}
        <button
          onClick={() => setMode(m => m === 'magic' ? 'password' : 'magic')}
          style={{ ...btnStyle('transparent', '#555'), width: '100%', marginTop: 8, fontSize: 12 }}
        >
          {mode === 'magic' ? 'כניסה עם סיסמה' : 'כניסה עם קישור למייל'}
        </button>
        <div style={{ color: '#444', fontSize: 11, marginTop: 8, textAlign: 'center', lineHeight: 1.6 }}>
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
