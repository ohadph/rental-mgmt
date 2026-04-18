// src/AdminPanel.jsx
// Screen for managing user access:
//   - See pending requests
//   - Approve + set role (viewer / editor)
//   - Revoke access

import { useState, useEffect } from 'react'
import { getSupabase } from './useAuth.js'

const ROLES = ['pending', 'viewer', 'unit_viewer', 'editor', 'admin']
const ROLE_LABELS = {
  pending:     '⏳ ממתין לאישור',
  viewer:      '👁 צפייה — כל היחידות',
  unit_viewer: '🏠 צפייה — יחידה בלבד',
  editor:      '✏️ עריכה מלאה',
  admin:       '🔑 מנהל',
}
const ROLE_COLORS = {
  pending:     '#e8c547',
  viewer:      '#6bc5f8',
  unit_viewer: '#a78bfa',
  editor:      '#4caf88',
  admin:       '#e85c4a',
}

const S = {
  btn: (bg, col) => ({
    background: bg, color: col, border: 'none', borderRadius: 8,
    padding: '6px 14px', cursor: 'pointer', fontWeight: 700,
    fontSize: 12, fontFamily: 'inherit',
  }),
}

const Badge = ({ role }) => (
  <span style={{
    background: ROLE_COLORS[role] + '22',
    color: ROLE_COLORS[role],
    border: `1px solid ${ROLE_COLORS[role]}44`,
    borderRadius: 20, padding: '2px 10px', fontSize: 12, fontWeight: 700,
  }}>
    {ROLE_LABELS[role]}
  </span>
)

export default function AdminPanel({ currentEmail, onClose, units=[] }) {
  const [users,  setUsers]  = useState([])
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(null)
  const [unitAssign, setUnitAssign] = useState({}) // userId -> unitId

  const load = async () => {
    const sb = getSupabase()
    const { data } = await sb
      .from('app_users')
      .select('*')
      .order('created_at', { ascending: false })
    setUsers(data || [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const setRole = async (userId, role) => {
    setSaving(userId)
    const sb = getSupabase()
    const unitId = role === 'unit_viewer' ? (+unitAssign[userId] || null) : null
    await sb
      .from('app_users')
      .update({
        role,
        unit_id: unitId,
        approved_at: role !== 'pending' ? new Date().toISOString() : null,
        approved_by: currentEmail,
      })
      .eq('id', userId)
    await load()
    setSaving(null)
  }

  const pending = users.filter(u => u.role === 'pending')
  const active  = users.filter(u => u.role !== 'pending')

  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#000c', zIndex: 300,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: '#12122a', border: '1px solid #2a2a4a', borderRadius: 16,
        padding: 28, maxWidth: 580, width: '95%', maxHeight: '88vh', overflowY: 'auto',
        fontFamily: "'Segoe UI', Tahoma, sans-serif", direction: 'rtl',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <div style={{ fontWeight: 800, fontSize: 18, color: '#e8c547' }}>🔑 ניהול משתמשים</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#888', fontSize: 22, cursor: 'pointer' }}>✕</button>
        </div>

        {loading && <div style={{ color: '#555', textAlign: 'center', padding: 20 }}>טוען…</div>}

        {/* Pending approvals */}
        {pending.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontWeight: 700, color: '#e8c547', marginBottom: 12, fontSize: 14 }}>
              ⏳ ממתינים לאישור ({pending.length})
            </div>
            {pending.map(u => (
              <div key={u.id} style={{
                background: '#1a1a10', border: '1px solid #e8c54744',
                borderRadius: 10, padding: 14, marginBottom: 8,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10,
              }}>
                <div>
                  <div style={{ fontWeight: 700, color: '#ddd' }}>{u.display_name || u.email}</div>
                  <div style={{ fontSize: 12, color: '#666' }}>{u.email}</div>
                  <div style={{ fontSize: 11, color: '#444', marginTop: 2 }}>
                    נרשם: {new Date(u.created_at).toLocaleDateString('he-IL')}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => setRole(u.id, 'viewer')}
                    disabled={saving === u.id}
                    style={S.btn('#1a2a3a', '#6bc5f8')}
                  >
                    👁 צפייה כללית
                  </button>
                  <div style={{display:'flex',alignItems:'center',gap:4}}>
                    <button
                      onClick={() => setRole(u.id, 'unit_viewer')}
                      disabled={saving === u.id || !unitAssign[u.id]}
                      style={{...S.btn('#1a1230', '#a78bfa'), opacity: unitAssign[u.id]?1:0.4}}
                    >
                      🏠 צפייה יחידה
                    </button>
                    <select
                      value={unitAssign[u.id]||''}
                      onChange={e=>setUnitAssign(prev=>({...prev,[u.id]:e.target.value}))}
                      style={{background:'#1a1a2e',border:'1px solid #a78bfa44',color:'#a78bfa',padding:'4px 8px',borderRadius:6,fontSize:11,fontFamily:'inherit'}}
                    >
                      <option value=''>יחידה...</option>
                      {units.map(un=><option key={un.id} value={un.id}>{un.name}</option>)}
                    </select>
                  </div>
                  <button
                    onClick={() => setRole(u.id, 'editor')}
                    disabled={saving === u.id}
                    style={S.btn('#1a3a1a', '#4caf88')}
                  >
                    ✏️ עריכה מלאה
                  </button>
                  <button
                    onClick={() => setRole(u.id, 'pending')}
                    disabled={saving === u.id}
                    style={S.btn('#2a1010', '#e85c4a')}
                  >
                    ✕ דחה
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Active users */}
        <div>
          <div style={{ fontWeight: 700, color: '#aaa', marginBottom: 12, fontSize: 14 }}>
            משתמשים פעילים ({active.length})
          </div>
          {active.map(u => (
            <div key={u.id} style={{
              background: '#0e0e20', borderRadius: 10, padding: 12, marginBottom: 8,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8,
            }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 700, color: '#ddd', fontSize: 14 }}>{u.display_name || u.email}</span>
                  <Badge role={u.role} />
                  {u.email === currentEmail && <span style={{ fontSize: 10, color: '#555' }}>(אתה)</span>}
                </div>
                <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>{u.email}</div>
              </div>
              {u.email !== currentEmail && (
                <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                  <select
                    value={u.role}
                    disabled={saving === u.id}
                    onChange={e => { setRole(u.id, e.target.value); }}
                    style={{
                      background: '#1a1a2e', border: '1px solid #2a2a4a', color: '#ccc',
                      padding: '6px 10px', borderRadius: 8, fontSize: 12, fontFamily: 'inherit', cursor: 'pointer',
                    }}
                  >
                    {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                  {(u.role==='unit_viewer'||(unitAssign[u.id]!=null))&&(
                    <select
                      value={unitAssign[u.id]??u.unit_id??''}
                      onChange={e=>{
                        const uid=e.target.value;
                        setUnitAssign(prev=>({...prev,[u.id]:uid}));
                        if(u.role==='unit_viewer') setRole(u.id,'unit_viewer');
                      }}
                      style={{background:'#1a1a2e',border:'1px solid #a78bfa55',color:'#a78bfa',padding:'6px 10px',borderRadius:8,fontSize:12,fontFamily:'inherit',cursor:'pointer'}}
                    >
                      <option value=''>בחר יחידה</option>
                      {units.map(un=><option key={un.id} value={un.id}>{un.name}</option>)}
                    </select>
                  )}
                </div>
              )}
            </div>
          ))}
          {active.length === 0 && <div style={{ color: '#444', fontSize: 13 }}>אין משתמשים פעילים עדיין</div>}
        </div>
      </div>
    </div>
  )
}
