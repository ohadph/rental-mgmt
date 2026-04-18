// src/useAuth.js
// Handles: magic-link login, role checking, session management
// Uses Supabase Auth (magic link = email only, no password needed)

import { createClient } from '@supabase/supabase-js'
import { useState, useEffect } from 'react'

const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY

// Detect Claude Artifact environment (window.storage exists)
const IS_CLAUDE = typeof window !== "undefined" && typeof window.storage === "object"

let _sb = null
export const getSupabase = () => {
  if (!_sb) _sb = createClient(SUPABASE_URL, SUPABASE_ANON)
  return _sb
}

// role hierarchy
export const canEdit      = (role) => ['editor','admin'].includes(role)
export const canView      = (role) => ['viewer','editor','admin','unit_viewer'].includes(role)
export const isAdmin      = (role) => role === 'admin'
export const isPending    = (role) => role === 'pending'
export const isUnitViewer = (role) => role === 'unit_viewer'

export function useAuth() {
  const [session,  setSession]  = useState(undefined) // undefined = loading
  const [userRole, setUserRole] = useState(null)
  const [unitId,   setUnitId]   = useState(null)   // non-null for unit_viewer
  const [authStep, setAuthStep] = useState('idle')    // idle | sent | checking
  const [error,    setError]    = useState(null)

  // ── Load session on mount ─────────────────────────────────────────────────
  useEffect(() => {
    // In Claude Artifact env, skip Supabase entirely
    if(IS_CLAUDE || !SUPABASE_URL || !SUPABASE_ANON){
      setSession(null)   // not loading
      setUserRole('editor')
      return
    }
    const sb = getSupabase()

    sb.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) fetchRole(session.user.email)
    })

    const { data: { subscription } } = sb.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session) fetchRole(session.user.email)
      else { setUserRole(null) }
    })

    return () => subscription.unsubscribe()
  }, [])

  // ── Fetch role from app_users ─────────────────────────────────────────────
  const fetchRole = async (email) => {
    if(IS_CLAUDE || !SUPABASE_URL) return
    const sb = getSupabase()
    const { data } = await sb
      .from('app_users')
      .select('role, unit_id')
      .eq('email', email)
      .single()

    setUserRole(data?.role || null)
    setUnitId(data?.unit_id || null)
  }

  // ── Send magic link ───────────────────────────────────────────────────────
  const sendMagicLink = async (email) => {
    if(IS_CLAUDE){ return false }
    setError(null)
    setAuthStep('sent')
    const sb = getSupabase()

    // Ensure user row exists (creates pending record on first login)
    const { error: upsertErr } = await sb
      .from('app_users')
      .upsert({ email: email.trim().toLowerCase() }, { onConflict: 'email', ignoreDuplicates: true })

    if (upsertErr && upsertErr.code !== '23505') {
      setError('שגיאה ברישום. נסה שוב.')
      setAuthStep('idle')
      return false
    }

    const { error: linkErr } = await sb.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { shouldCreateUser: true },
    })

    if (linkErr) {
      setError('שגיאה בשליחת הקישור. בדוק את כתובת המייל.')
      setAuthStep('idle')
      return false
    }

    setAuthStep('sent')
    return true
  }

  // ── Sign out ──────────────────────────────────────────────────────────────
  const signInWithPassword = async (email, password) => {
    if(IS_CLAUDE || !SUPABASE_URL){ return false }
    setError(null)
    const sb = getSupabase()
    const { error } = await sb.auth.signInWithPassword({ email: email.trim().toLowerCase(), password })
    if(error){ setError('מייל או סיסמה שגויים.'); return false }
    return true
  }

  const signOut = async () => {
    await getSupabase().auth.signOut()
    setSession(null)
    setUserRole(null)
    setAuthStep('idle')
  }

  return {
    session,
    userRole,
    unitId,
    authStep,
    error,
    sendMagicLink,
    signInWithPassword,
    signOut,
    isLoading: session === undefined,
    isLoggedIn: !!session,
    email: session?.user?.email,
  }
}
