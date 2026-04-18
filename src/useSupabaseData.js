// src/useSupabaseData.js
// Drop-in replacement for the Claude window.storage sync hook.
// Uses Supabase to store all app data in a single JSON row per "workspace".
//
// Setup:
//   1. Create a free Supabase project at https://supabase.com
//   2. Run the SQL in supabase-setup.sql
//   3. Copy your project URL and anon key into .env.local

import { createClient } from '@supabase/supabase-js'
import { useState, useEffect, useRef, useCallback } from 'react'

const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY
const WORKSPACE_ID  = import.meta.env.VITE_WORKSPACE_ID || 'default'
const POLL_MS       = 5000

// Lazy singleton — only created once
let _supabase = null
const getClient = () => {
  if (!_supabase) _supabase = createClient(SUPABASE_URL, SUPABASE_ANON)
  return _supabase
}

export function useSupabaseData(DEFAULT_DATA) {
  const [data,     setData]     = useState(null)
  const [syncOk,   setSyncOk]   = useState(null)
  const [lastSync, setLastSync] = useState(null)
  const saving = useRef(false)
  const localVersion = useRef(0)  // monotonic counter to detect stale polls

  // ── helpers ────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    const sb = getClient()
    const { data: rows, error } = await sb
      .from('app_data')
      .select('payload, version')
      .eq('workspace_id', WORKSPACE_ID)
      .single()

    if (error && error.code !== 'PGRST116') throw error  // PGRST116 = no row

    if (rows) {
      localVersion.current = rows.version
      return rows.payload
    }

    // First run — seed with defaults
    const { error: insertErr } = await sb
      .from('app_data')
      .insert({ workspace_id: WORKSPACE_ID, payload: DEFAULT_DATA, version: 1 })
    if (insertErr) throw insertErr
    localVersion.current = 1
    return DEFAULT_DATA
  }, [DEFAULT_DATA])

  const persist = useCallback(async (payload) => {
    const sb = getClient()
    const newVersion = localVersion.current + 1
    const { error } = await sb
      .from('app_data')
      .upsert({
        workspace_id: WORKSPACE_ID,
        payload,
        version: newVersion,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'workspace_id' })
    if (error) throw error
    localVersion.current = newVersion
  }, [])

  // ── mount: load data ────────────────────────────────────────────────────────

  useEffect(() => {
    load()
      .then(d => { setData(d); setSyncOk(true); setLastSync(new Date()) })
      .catch(() => { setData(DEFAULT_DATA); setSyncOk(false) })
  }, [load, DEFAULT_DATA])

  // ── poll: pick up changes from other users ──────────────────────────────────

  useEffect(() => {
    if (!data) return
    const id = setInterval(async () => {
      if (saving.current) return
      try {
        const sb = getClient()
        const { data: row } = await sb
          .from('app_data')
          .select('payload, version')
          .eq('workspace_id', WORKSPACE_ID)
          .single()

        if (row && row.version > localVersion.current) {
          localVersion.current = row.version
          setData(row.payload)
          setLastSync(new Date())
        }
      } catch (_) {}
    }, POLL_MS)
    return () => clearInterval(id)
  }, [data])

  // ── save ────────────────────────────────────────────────────────────────────

  const save = useCallback((updater) => {
    setData(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      saving.current = true
      persist(next)
        .then(() => { setSyncOk(true); setLastSync(new Date()) })
        .catch(() => setSyncOk(false))
        .finally(() => { saving.current = false })
      return next
    })
  }, [persist])

  return { data, save, syncOk, lastSync }
}
