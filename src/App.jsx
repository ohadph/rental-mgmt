import React, { useState, useEffect, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import { useSupabaseData } from "./useSupabaseData.js";
import { useAuth, canEdit, canView, isAdmin, isPending, isUnitViewer } from "./useAuth.js";
import LoginScreen, { PendingScreen } from "./LoginScreen.jsx";
import AdminPanel from "./AdminPanel.jsx";

// ─── DEFAULTS (first-run seed) ────────────────────────────────────────────────

const DEFAULT_DATA = {
  units: [
    { id: 1, name: "דירה 1", rent: 4500, persons: 4, vacant: false, arnonaAmount: 0, waterMeterId:"12345678", electricMeterId:"87654321",
      tenantHistory:[
        {name:"משפחת כהן", phone:"050-1234567", startDate:"2024-01-01", endDate:null}
      ]
    },
    { id: 2, name: "דירה 2", rent: 3800, persons: 2, vacant: false, arnonaAmount: 0, waterMeterId:"22334455", electricMeterId:"55443322",
      tenantHistory:[
        {name:"ישראל לוי", phone:"052-9876543", startDate:"2023-06-01", endDate:null}
      ]
    },
  ],
  bills: {
    "1_2025-01": { paid: true,  paidDate: "2025-01-10", readings: { water:{prev:100,curr:112}, electricity:{prev:2000,curr:2180}, sewage:{prev:100,curr:112} } },
    "1_2025-02": { paid: false, paidDate: null,          readings: { water:{prev:112,curr:125}, electricity:{prev:2180,curr:2340}, sewage:{prev:112,curr:125} } },
    "2_2025-01": { paid: true,  paidDate: "2025-01-08", readings: { water:{prev:50,curr:61},   electricity:{prev:1500,curr:1640}, sewage:{prev:50,curr:61}   } },
    "2_2025-02": { paid: true,  paidDate: "2025-02-07", readings: { water:{prev:61,curr:75},   electricity:{prev:1640,curr:1800}, sewage:{prev:61,curr:75}   } },
  },
  transactions: [
    { id:1, date:"2025-01-01", type:"income",  category:"שכירות", unitId:1,    amount:4500, note:"שכירות ינואר - דירה 1" },
    { id:2, date:"2025-01-01", type:"income",  category:"שכירות", unitId:2,    amount:3800, note:"שכירות ינואר - דירה 2" },
    { id:3, date:"2025-01-15", type:"expense", category:"תחזוקה", unitId:1,    amount:800,  note:"תיקון ברז" },
    { id:4, date:"2025-02-01", type:"income",  category:"שכירות", unitId:1,    amount:4500, note:"שכירות פברואר - דירה 1" },
    { id:5, date:"2025-02-01", type:"income",  category:"שכירות", unitId:2,    amount:3800, note:"שכירות פברואר - דירה 2" },
    { id:6, date:"2025-02-10", type:"expense", category:"ביטוח",  unitId:null, amount:1200, note:"ביטוח רכוש" },
  ],
  buildingBills: {},   // { 'YYYY-MM': { periods:[{kwh,price,dateFrom,dateTo}], fixedCostTotal, fixedSplitMethod, date } }
  tariffs: {
    water: {
      name:"מים", unit:"מ״ק", tiered:true,
      perPersonQty:7,
      priceLow:8.5, priceHigh:13.5,
      billingMonths:2,
    },
    electricity: { name:"חשמל", unit:"קוט״ש", price:0.65, tiered:false, fixedCostTotal:0, fixedSplitMethod:"equal", billingMonths:2 },
    sewage:      { name:"ביוב", unit:"מ״ק",   price:4.2,  tiered:false, billingMonths:2, sewageMode:"manual", sewageRatePerCubic:6.9 },
  },
};

// Dynamic month/period generation — never expires
const HEB_MONTHS = [
  "ינואר","פברואר","מרץ","אפריל","מאי","יוני",
  "יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"
];

const monthLabel = (ym) => {
  const [y,m] = ym.split("-");
  return `${HEB_MONTHS[+m-1]} ${y}`;
};

// Generate periods: 2 years back to 2 years forward
const _genPeriods = () => {
  const now = new Date();
  const startYear = now.getFullYear() - 2;
  const endYear   = now.getFullYear() + 2;
  const periods = [];
  for(let y=startYear; y<=endYear; y++){
    for(let m=1; m<=12; m+=2){
      const k  = `${y}-${String(m).padStart(2,"0")}`;
      const m2 = String(m+1).padStart(2,"0");
      const l1 = HEB_MONTHS[m-1], l2 = HEB_MONTHS[m];
      periods.push({key:k, label:`${l1}–${l2} ${y}`, months:[k,`${y}-${m2}`]});
    }
  }
  return periods;
};

const BIMONTHLY_PERIODS = _genPeriods();
const periodLabel = (key) => {
  const bp = BIMONTHLY_PERIODS.find(p=>p.key===key);
  if(bp) return bp.label;
  // fallback for single month keys
  if(/^\d{4}-\d{2}$/.test(key)) return monthLabel(key);
  return key;
};

// ALL_MONTHS: all months covered by BIMONTHLY_PERIODS
const ALL_MONTHS = BIMONTHLY_PERIODS.flatMap(p=>p.months);
// Derived map for backwards compat (e.g. Excel import)
const MONTH_LABELS = Object.fromEntries(ALL_MONTHS.map(m=>[m,monthLabel(m)]));

const STORAGE_KEY = "rental-mgmt-v1";
const POLL_MS = 4000; // re-check cloud every 4 seconds

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const fmt = (n) =>
  new Intl.NumberFormat("he-IL",{style:"currency",currency:"ILS",maximumFractionDigits:0}).format(n??0);

// calcBill: buildingBill drives electricity rate & fixed costs
// readings.electricity = {prev, curr}  (internal meter)
// buildingBill = {periods:[{kwh,price},...], fixedCostTotal, fixedSplitMethod}
const calcBill = (readings, tariffs, unit, units, buildingBill, bills, periodKey, noWaterDiscount=false, extraData=null) => {
  let total=0; const lines={};

  for(const [key,t] of Object.entries(tariffs)){
    const r=readings?.[key];
    if(!r) continue;

    if(t.tiered && key==="water"){
      if(r.curr==null||r.prev==null) continue;
      const persons  = unit?.persons || 1;
      const allowance= persons * t.perPersonQty;
      const usage    = r.curr - r.prev;
      // noWaterDiscount: all at high price (tenant didn't provide residency docs)
      const lowUsage = noWaterDiscount ? 0 : Math.min(usage, allowance);
      const highUsage= noWaterDiscount ? usage : Math.max(0, usage - allowance);
      const amount   = lowUsage*t.priceLow + highUsage*t.priceHigh;
      lines[key]={usage,amount,name:t.name,unit:t.unit,tiered:true,allowance:noWaterDiscount?0:allowance,lowUsage,highUsage,perPersonQty:t.perPersonQty,priceLow:t.priceLow,priceHigh:t.priceHigh,persons,noWaterDiscount};
      total+=amount;

    } else if(key==="electricity"){
      if(r.curr==null||r.prev==null) continue;
      const unitKwh = r.curr - r.prev;

      // Determine effective price(s) from buildingBill or fall back to tariff
      let usageAmount=0; let calcPeriods=[];
      const bb = buildingBill;
      if(bb && bb.periods && bb.periods.length>0){
        const totalBuildingKwh = bb.periods.reduce((s,p)=>s+(p.kwh||0),0);
        if(totalBuildingKwh>0){
          // Distribute this unit's kwh proportionally across periods
          for(const p of bb.periods){
            const frac = (p.kwh||0)/totalBuildingKwh;
            const periodKwh = +(unitKwh*frac).toFixed(3);
            const a = periodKwh*(p.price||t.price);
            usageAmount+=a;
            calcPeriods.push({kwh:periodKwh,price:p.price||t.price,amount:a,dateFrom:p.dateFrom,dateTo:p.dateTo});
          }
        } else {
          usageAmount=unitKwh*t.price;
          calcPeriods=[{kwh:unitKwh,price:t.price,amount:usageAmount}];
        }
      } else {
        usageAmount=unitKwh*t.price;
        calcPeriods=[{kwh:unitKwh,price:t.price,amount:usageAmount}];
      }

      // Fixed cost share
      let fixedShare=0;
      const fc = bb?.fixedCostTotal || t.fixedCostTotal || 0;
      const splitMethod = bb?.fixedSplitMethod || t.fixedSplitMethod || "equal";
      // Only active (non-vacant) units share fixed costs
      const activeUnits = units ? units.filter(u=>!u.vacant) : units;
      const nActive = activeUnits?.length || 1;
      if(fc>0 && nActive>0){
        if(splitMethod==="byUsage" && bills && periodKey){
          const totalKwh = activeUnits.reduce((sum,u)=>{
            const r=bills[bKey(u.id,periodKey)]?.readings?.electricity;
            return sum + (r&&r.curr!=null&&r.prev!=null ? r.curr-r.prev : 0);
          },0);
          fixedShare = totalKwh>0 ? fc*(unitKwh/totalKwh) : fc/nActive;
        } else {
          fixedShare = unit?.vacant ? 0 : fc/nActive;
        }
      }

      const amount=usageAmount+fixedShare;
      lines[key]={usage:unitKwh,amount,name:t.name,unit:t.unit,tiered:false,periods:calcPeriods,fixedShare,usageAmount,multiRate:calcPeriods.length>1};
      total+=amount;

    } else if(key==="sewage" && t.sewageMode==="auto"){
      if(r.curr==null||r.prev==null) continue;
      const usage=r.curr-r.prev;
      const amount = extraData?.sewageAmount ?? +(usage*(t.sewageRatePerCubic||6.9)).toFixed(2);
      lines[key]={usage,amount,price:t.sewageRatePerCubic||6.9,name:t.name,unit:t.unit,tiered:false,auto:true};
      total+=amount;
    } else {
      if(r.curr==null||r.prev==null) continue;
      const usage=r.curr-r.prev, amount=usage*t.price;
      lines[key]={usage,amount,price:t.price,name:t.name,unit:t.unit,tiered:false};
      total+=amount;
    }
  }
  return {total,lines};
};


// ─── PER-ITEM PAYMENT HELPERS ─────────────────────────────────────────────────

// Default payment item
const defaultPayItem = () => ({paid:false, amount:null, date:null});

// Get payments object, with defaults for missing items
const getPayments = (bill, calcLines, unitRent) => {
  const p = bill.payments || {};
  const items = {};
  items.rent = p.rent || defaultPayItem();
  if(calcLines?.water)       items.water       = p.water       || defaultPayItem();
  if(calcLines?.electricity) items.electricity = p.electricity || defaultPayItem();
  if(calcLines?.sewage)      items.sewage      = p.sewage      || defaultPayItem();
  return items;
};

// Is the whole bill fully paid?
const isBillFullyPaid = (bill, calcLines) => {
  const p = bill.payments || {};
  const items = ['rent'];
  if(calcLines?.water)       items.push('water');
  if(calcLines?.electricity) items.push('electricity');
  if(calcLines?.sewage)      items.push('sewage');
  return items.every(k => p[k]?.paid);
};

const ITEM_LABELS = {
  rent:        {label:'שכירות',  icon:'🏠', color:'#4caf88'},
  water:       {label:'מים',     icon:'💧', color:'#6bc5f8'},
  electricity: {label:'חשמל',   icon:'⚡', color:'#e8c547'},
  sewage:      {label:'ביוב',    icon:'🚿', color:'#a78bfa'},
};

const bKey=(uid,month)=>`${uid}_${month}`;

// ─── SEWAGE AUTO-CALC (מטה יהודה מנגנון חורף/קיץ) ───────────────────────────
// periodKey: "YYYY-MM" (first month of bimonthly period)
// Winter periods: Dec-Jan, Feb-Mar → 100% × consumption × rate
// Summer periods: Apr-Nov → 100% × avg of winter periods × rate
// If no winter history → 100% × current consumption × rate

const calcSewageAuto = (periodKey, unitId, bills, waterUsage, sewageRatePerCubic=6.9) => {
  const [y, m] = periodKey.split("-").map(Number);
  const isWinterMonth = (mo) => mo === 12 || mo === 1 || mo === 2 || mo === 3;
  const isSummer = !isWinterMonth(m) && !isWinterMonth(m+1 > 12 ? 1 : m+1);

  if (!isSummer) {
    // Winter: 100% of actual consumption
    return +(waterUsage * sewageRatePerCubic).toFixed(2);
  }

  // Summer: use average of winter bimonthly periods
  // Winter season for summer Y: Dec(Y-1)-Jan(Y) and Feb-Mar(Y)
  const winterPeriod1 = `${y-1}-12`;
  const winterPeriod2 = `${y}-02`;

  const getWaterUsage = (pk) => {
    const b = bills[`${unitId}_${pk}`];
    if (!b?.readings?.water) return null;
    const { prev, curr } = b.readings.water;
    if (curr == null || prev == null) return null;
    return curr - prev;
  };

  const available = [getWaterUsage(winterPeriod1), getWaterUsage(winterPeriod2)].filter(x => x != null);
  if (available.length === 0) {
    // No winter history — use 100% of current consumption
    return +(waterUsage * sewageRatePerCubic).toFixed(2);
  }
  const winterAvg = available.reduce((s, x) => s + x, 0) / available.length;
  return +(winterAvg * sewageRatePerCubic).toFixed(2);
};



// Get the current active tenant for a unit
// Supports both old tenantHistory[] and new tenants[] structures
const currentTenant = (unit) => {
  // New structure: unit.tenants with active flag
  const newTenants = unit.tenants?.filter(t=>t.active);
  if(newTenants?.length) {
    const t = newTenants[0];
    return {name: newTenants.map(t=>t.name).filter(Boolean).join(" + "), phone:t.phone||"", email:t.email||""};
  }
  // Old structure: tenantHistory with endDate
  const h = unit.tenantHistory || [];
  const cur = h.find(t => !t.endDate) || h[h.length-1];
  return cur || {name:"ללא שוכר", phone:""};
};

// Get tenant active at a given month (YYYY-MM)
const tenantAtPeriod = (unit, monthKey) => {
  // New structure
  const newTenants = unit.tenants?.filter(t=>t.active);
  if(newTenants?.length){
    const t = newTenants[0];
    return {name: newTenants.map(t=>t.name).filter(Boolean).join(" + "), phone:t.phone||""};
  }
  // Old structure
  const h = unit.tenantHistory || [];
  const d = monthKey + "-01";
  return h.find(t => t.startDate <= d && (!t.endDate || t.endDate >= d))
      || currentTenant(unit);
};



// getPrevReading: auto-fill "prev" from last saved bill for this unit+utility
const getPrevReading = (bills, unitId, utilType) => {
  const keys = Object.keys(bills)
    .filter(k => k.startsWith(`${unitId}_`))
    .sort()   // chronological by month string
    .reverse();
  for(const k of keys){
    const r = bills[k]?.readings?.[utilType];
    if(r && r.curr != null) return r.curr;
  }
  return null;
};



// ─── CLOUD SYNC HOOK ──────────────────────────────────────────────────────────

function useCloudData() {
  const [data,    setData]    = useState(null);   // null = loading
  const [syncOk,  setSyncOk]  = useState(null);   // null|true|false
  const [lastSync,setLastSync]= useState(null);
  const saving = useRef(false);

  // Storage abstraction: stable ref (not recreated on every render)
  const storageRef = useRef({
    get: async (key) => {
      if(typeof window.storage?.get === "function"){
        const r = await window.storage.get(key, true);
        return r?.value ? JSON.parse(r.value) : null;
      }
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : null;
    },
    set: async (key, val) => {
      const str = JSON.stringify(val);
      if(typeof window.storage?.set === "function"){
        await window.storage.set(key, str, true);
      } else {
        localStorage.setItem(key, str);
      }
    }
  });
  const storage = storageRef.current;

  // Load on mount
  useEffect(()=>{
    (async()=>{
      try {
        const saved = await storage.get(STORAGE_KEY);
        setData(saved || DEFAULT_DATA);
        if(!saved) await storage.set(STORAGE_KEY, DEFAULT_DATA);
        setSyncOk(true);
        setLastSync(new Date());
      } catch(e){
        setData(DEFAULT_DATA);
        setSyncOk(false);
      }
    })();
  },[]);

  // Poll for remote changes (only in Claude Artifact mode)
  useEffect(()=>{
    if(!data) return;
    if(typeof window.storage?.get !== "function") return; // skip polling in localStorage mode
    const id = setInterval(async()=>{
      if(saving.current) return;
      try {
        const remote = await storage.get(STORAGE_KEY);
        if(remote && JSON.stringify(remote) !== JSON.stringify(data)){
          setData(remote);
          setLastSync(new Date());
        }
      } catch(_){}
    }, POLL_MS);
    return ()=>clearInterval(id);
  },[data]);

  // Save to storage
  const save = useCallback((updater)=>{
    setData(prev=>{
      const next = typeof updater==="function" ? updater(prev) : updater;
      saving.current = true;
      storage.set(STORAGE_KEY, next)
        .then(()=>{ setSyncOk(true); setLastSync(new Date()); })
        .catch(()=>setSyncOk(false))
        .finally(()=>{ saving.current=false; });
      return next;
    });
  },[]);

  return {data, save, syncOk, lastSync};
}

// ─── SHARED UI ───────────────────────────────────────────────────────────────

const Card=({children,style={}})=>(
  <div style={{background:"#12122a",border:"1px solid #2a2a4a",borderRadius:12,padding:20,...style}}>{children}</div>
);
const Badge=({children,color="#e8c547"})=>(
  <span style={{background:color+"22",color,border:`1px solid ${color}44`,borderRadius:20,padding:"2px 10px",fontSize:12,fontWeight:700}}>{children}</span>
);
const StatCard=({label,value,sub,color="#e8c547",icon})=>(
  <Card>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
      <div>
        <div style={{color:"#666",fontSize:11,marginBottom:6,textTransform:"uppercase",letterSpacing:1}}>{label}</div>
        <div style={{color,fontSize:26,fontWeight:800}}>{value}</div>
        {sub&&<div style={{color:"#555",fontSize:12,marginTop:4}}>{sub}</div>}
      </div>
      <div style={{fontSize:26,opacity:0.5}}>{icon}</div>
    </div>
  </Card>
);
const NavTab=({label,active,onClick,icon})=>(
  <button onClick={onClick} style={{
    display:"flex",alignItems:"center",gap:6,padding:"10px 18px",
    background:active?"#1a1a2e":"transparent",
    color:active?"#e8c547":"#888",
    border:"none",borderBottom:active?"2px solid #e8c547":"2px solid transparent",
    cursor:"pointer",fontSize:13,fontFamily:"inherit",fontWeight:active?700:400,whiteSpace:"nowrap",
  }}>{icon} {label}</button>
);
const S={
  sel:{background:"#12122a",border:"1px solid #2a2a4a",color:"#ccc",padding:"8px 12px",borderRadius:8,fontSize:13,fontFamily:"inherit",cursor:"pointer"},
  inp:{background:"#0e0e20",border:"1px solid #2a2a4a",color:"#ddd",padding:"7px 10px",borderRadius:6,fontSize:13,fontFamily:"inherit",width:"100%",boxSizing:"border-box",display:"block",marginTop:4},
  lbl:{color:"#777",fontSize:12,fontWeight:600,display:"block"},
  btn:(bg,col)=>({background:bg,color:col,border:"none",borderRadius:8,padding:"8px 16px",cursor:"pointer",fontWeight:700,fontSize:13,fontFamily:"inherit"}),
};

// ─── SYNC STATUS BAR ─────────────────────────────────────────────────────────

function SyncBar({syncOk, lastSync, isClaudeEnv=false}){
  const t = lastSync ? lastSync.toLocaleTimeString("he-IL",{hour:"2-digit",minute:"2-digit",second:"2-digit"}) : "—";
  return (
    <div style={{display:"flex",alignItems:"center",gap:8,padding:"5px 20px",background:"#08081a",borderBottom:"1px solid #1e1e3a",fontSize:11}}>
      <span style={{width:8,height:8,borderRadius:"50%",background:syncOk===null?"#888":syncOk?"#4caf88":"#e85c4a",display:"inline-block",flexShrink:0}}/>
      <span style={{color:"#555"}}>
        {syncOk===null ? "מתחבר לענן…" : syncOk ? `מסונכרן · עדכון אחרון: ${t}` : "שגיאת סנכרון — עובד במצב מקומי"}
      </span>
      <span style={{color:"#333",marginRight:"auto"}}>{isClaudeEnv?"🌐 נתונים משותפים":"☁️ Supabase"}</span>
    </div>
  );
}


// ─── CONFIRM MODAL ───────────────────────────────────────────────────────────
// Internal confirm dialog — works in all environments including webviews/iframes

function useConfirm(){
  const [state,setState] = useState(null); // {message,resolve}
  const confirm = (message) => new Promise(resolve=>{
    setState({message,resolve});
  });
  const ConfirmModal = state ? (
    <div style={{position:"fixed",inset:0,background:"#000b",zIndex:999,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{background:"#12122a",border:"1px solid #2a2a4a",borderRadius:14,padding:28,maxWidth:380,width:"90%",textAlign:"center"}}>
        <div style={{fontSize:18,marginBottom:8}}>⚠️</div>
        <div style={{color:"#ddd",fontSize:14,marginBottom:20,lineHeight:1.6}}>{state.message}</div>
        <div style={{display:"flex",gap:10,justifyContent:"center"}}>
          <button onClick={()=>{state.resolve(true);setState(null);}} style={{...S.btn("#e85c4a","#fff"),minWidth:80}}>אשר</button>
          <button onClick={()=>{state.resolve(false);setState(null);}} style={{...S.btn("#2a2a4a","#aaa"),minWidth:80}}>ביטול</button>
        </div>
      </div>
    </div>
  ) : null;
  return {confirm, ConfirmModal};
}


// ─── AI CALL ABSTRACTION ─────────────────────────────────────────────────────
// Works in two modes:
// 1. Claude Artifacts: window.ANTHROPIC_API_URL not set → call API directly
//    (Artifact environment injects auth automatically)
// 2. External deploy: set window.ANTHROPIC_API_URL = "/api/claude"
//    and implement a backend proxy at that endpoint

const callAI = async ({messages, max_tokens=1000, system}) => {
  // Outside Claude Artifacts → use our Vercel proxy (/api/claude)
  // Inside Claude Artifacts  → call Anthropic directly (runtime handles auth)
  const isClaudeArtifact = typeof window !== "undefined" && typeof window.storage === "object";
  const endpoint = isClaudeArtifact
    ? "https://api.anthropic.com/v1/messages"
    : (window.ANTHROPIC_API_URL || "/api/claude");

  const body = {
    model: "claude-sonnet-4-20250514",
    max_tokens,
    messages,
  };
  if(system) body.system = system;

  const headers = {"Content-Type":"application/json"};
  // When running externally with a backend proxy, the proxy adds the API key.
  // When running in a Claude Artifact, the runtime handles auth.

  const res  = await fetch(endpoint, {method:"POST", headers, body:JSON.stringify(body)});
  const data = await res.json();
  if(data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.content?.map(c=>c.text||"").join("").replace(/```json|```/g,"").trim();
};

// ─── PAYMENT DEMAND MODAL ────────────────────────────────────────────────────

// Unified line detail formatter (handles water tiered, electricity multi-rate, plain)
const lineDetail = (l) => {
  if(l.tiered){
    let d = `מוזל: ${l.lowUsage.toFixed(1)}×${l.priceLow}₪`;
    if(l.highUsage>0) d += ` + יקר: ${l.highUsage.toFixed(1)}×${l.priceHigh}₪`;
    d += ` (מכסה ${l.allowance.toFixed(0)} מ״ק / ${l.persons} נפשות)`;
    return d;
  }
  if(l.periods && l.periods.length>1){
    let d = l.periods.map(p=>`${(+p.kwh).toFixed(1)}×${p.price}₪`).join(" + ");
    if(l.fixedShare>0) d += ` + קבוע ${fmt(l.fixedShare)}`;
    return d;
  }
  let d = (l.price!=null)
    ? `${l.usage} ${l.unit} × ${l.price} ₪`
    : `${l.usage} ${l.unit}`;
  if(l.fixedShare>0) d += ` + קבוע ${fmt(l.fixedShare)}`;
  return d;
};

function PaymentDemandModal({unit,month,bill,onClose}){
  const today=new Date().toLocaleDateString("he-IL");
  const due=new Date(Date.now()+7*864e5).toLocaleDateString("he-IL");

  // ── item selection state ──
  const [inclRent, setInclRent] = useState(true);
  const [inclArnona, setInclArnona] = useState((unit.arnonaAmount||0)>0);
  const [inclLines, setInclLines] = useState(
    ()=>Object.fromEntries(Object.keys(bill.lines).map(k=>[k,true]))
  );

  const activeLines = Object.entries(bill.lines).filter(([k])=>inclLines[k]);
  const utilTotal   = activeLines.reduce((s,[,l])=>s+l.amount,0);
  const arnonaAmt  = (inclArnona&&(unit.arnonaAmount||0)>0) ? (unit.arnonaAmount||0) : 0;
  const grandTotal  = (inclRent?unit.rent:0) + utilTotal + arnonaAmt;

  // ── build HTML for print / share ──
  const buildHTML = ()=>`<html dir="rtl"><head><meta charset="utf-8"/><style>
    body{font-family:Arial,sans-serif;max-width:700px;margin:40px auto;color:#222;font-size:14px}
    h1{font-size:21px;border-bottom:3px solid #1a1a2e;padding-bottom:10px;margin-bottom:20px}
    .row{display:flex;justify-content:space-between;margin-bottom:18px}
    .meta{font-size:13px;color:#444;line-height:1.9}
    table{width:100%;border-collapse:collapse;margin:18px 0}
    th{background:#1a1a2e;color:#e8c547;padding:10px 14px;text-align:right;font-size:13px}
    td{padding:10px 14px;border-bottom:1px solid #eee;font-size:13px}
    .tot td{font-weight:bold;font-size:15px;background:#f5f5f5}
    .stamp{margin-top:36px;border:2px dashed #ccc;border-radius:8px;padding:14px;text-align:center;color:#aaa;font-size:12px}
    .foot{margin-top:24px;font-size:11px;color:#999;border-top:1px solid #ddd;padding-top:12px}
  </style></head><body>
  <h1>🏢 דרישת תשלום — ${periodLabel(month)}</h1>
  <div class="row">
    <div class="meta"><strong>לכבוד:</strong> ${currentTenant(unit).name}<br/><strong>יחידה:</strong> ${unit.name}<br/><strong>טלפון:</strong> ${currentTenant(unit).phone}</div>
    <div class="meta" style="text-align:left"><strong>תאריך הפקה:</strong> ${today}<br/><strong>לתשלום עד:</strong> ${due}</div>
  </div>
  <table><thead><tr><th>פריט</th><th>פירוט</th><th>סכום</th></tr></thead><tbody>
    ${inclRent?`<tr><td>שכירות חודשית</td><td>${periodLabel(month)}</td><td>${fmt(unit.rent)}</td></tr>`:""}
    ${arnonaAmt>0?`<tr><td>ארנונה + מיסי מושב</td><td>${periodLabel(month)}</td><td>${fmt(arnonaAmt)}</td></tr>`:""}
    ${activeLines.map(([,l])=>`<tr><td>${l.name}</td><td>${lineDetail(l)}</td><td>${fmt(l.amount)}</td></tr>`).join("")}
  </tbody><tfoot><tr class="tot"><td colspan="2">סה״כ לתשלום</td><td>${fmt(grandTotal)}</td></tr></tfoot></table>
  <div class="stamp">אישור תשלום / חתימה ___________________________ תאריך ___________</div>
  <div class="foot">מסמך זה הופק באמצעות מערכת ניהול נכסים · ${today}</div>
  </body></html>`;

  // ── WhatsApp text ──
  const buildWAText = ()=>{
    const lines=[];
    lines.push(`🏢 *דרישת תשלום — ${periodLabel(month)}*`);
    lines.push(`לכבוד: ${currentTenant(unit).name} | ${unit.name}`);
    lines.push(`לתשלום עד: ${due}`);
    lines.push("──────────────────");
    if(inclRent) lines.push(`🏠 שכירות חודשית: ${fmt(unit.rent)}`);
    if(arnonaAmt>0) lines.push(`🏛 ארנונה + מיסי מושב: ${fmt(arnonaAmt)}`);
    activeLines.forEach(([,l])=>{
      if(l.tiered){
        let detail=`מוזל: ${l.lowUsage.toFixed(1)}×${l.priceLow}₪`;
        if(l.highUsage>0) detail+=` + יקר: ${l.highUsage.toFixed(1)}×${l.priceHigh}₪`;
        lines.push(`• ${l.name}: ${detail} = ${fmt(l.amount)}`);
      } else {
        lines.push(`• ${l.name}: ${lineDetail(l)} = ${fmt(l.amount)}`);
      }
    });
    lines.push("──────────────────");
    lines.push(`💰 *סה״כ לתשלום: ${fmt(grandTotal)}*`);
    return lines.join("\n");
  };

  const buildEmailBody = ()=>{
    const lines=[];
    lines.push(`שלום ${currentTenant(unit).name},`);
    lines.push(`\nמצורפת דרישת התשלום לחודש ${periodLabel(month)}:\n`);
    if(inclRent) lines.push(`שכירות חודשית: ${fmt(unit.rent)}`);
    if(arnonaAmt>0) lines.push(`ארנונה + מיסי מושב: ${fmt(arnonaAmt)}`);
    activeLines.forEach(([,l])=>lines.push(`${l.name}: ${lineDetail(l)} = ${fmt(l.amount)}`));
    lines.push(`\nסה״כ לתשלום: ${fmt(grandTotal)}`);
    lines.push(`לתשלום עד: ${due}`);
    lines.push("\nבברכה");
    return lines.join("\n");
  };

  const print=()=>{const w=window.open("","_blank");w.document.write(buildHTML());w.document.close();w.focus();w.print();};

  const shareWhatsApp=()=>{
    const text=encodeURIComponent(buildWAText());
    // wa.me without phone opens contact picker on mobile, works on desktop too
    window.open(`https://wa.me/?text=${text}`,"_blank");
  };

  const shareEmail=()=>{
    const subject=encodeURIComponent(`דרישת תשלום — ${periodLabel(month)} — ${unit.name}`);
    const body=encodeURIComponent(buildEmailBody());
    window.open(`mailto:?subject=${subject}&body=${body}`,"_blank");
  };

  const [copied, setCopied] = useState(false);
  const copyWA=()=>{
    const text = buildWAText();
    // fallback that works inside iframes
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand("copy"); setCopied(true); setTimeout(()=>setCopied(false),2000); } catch(e){}
    document.body.removeChild(ta);
  };

  // checkbox — div+onClick avoids label/event bubbling issues
  const ChkRow=({label,checked,onChange,color="#e8c547"})=>(
    <div onClick={onChange} style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",padding:"7px 10px",borderRadius:8,background:checked?"#1a1a2e":"#0e0e20",border:`1px solid ${checked?color+"55":"#2a2a4a"}`,userSelect:"none"}}>
      <div style={{width:18,height:18,borderRadius:4,background:checked?color:"transparent",border:`2px solid ${checked?color:"#444"}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
        {checked&&<span style={{color:"#1a1a2e",fontSize:11,fontWeight:900,lineHeight:1}}>✓</span>}
      </div>
      <span style={{fontSize:13,color:checked?"#ddd":"#666"}}>{label}</span>
    </div>
  );

  return(
    <div style={{position:"fixed",inset:0,background:"#000c",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{background:"#12122a",border:"1px solid #2a2a4a",borderRadius:16,padding:24,maxWidth:620,width:"95%",maxHeight:"92vh",overflowY:"auto"}}>

        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div style={{fontWeight:800,fontSize:18,color:"#e8c547"}}>📄 דרישת תשלום</div>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#888",fontSize:22,cursor:"pointer"}}>✕</button>
        </div>

        {/* Item selector */}
        <div style={{marginBottom:18}}>
          <div style={{fontSize:12,color:"#666",fontWeight:600,marginBottom:8,textTransform:"uppercase",letterSpacing:1}}>בחר פריטים לכלול בחשבון</div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            <ChkRow label={`🏠 שכירות חודשית — ${fmt(unit.rent)}`} checked={inclRent} onChange={()=>setInclRent(v=>!v)} color="#4caf88"/>
            {(unit.arnonaAmount||0)>0&&<ChkRow label={`🏛 ארנונה + מיסי מושב — ${fmt(unit.arnonaAmount)}`} checked={inclArnona} onChange={()=>setInclArnona(v=>!v)} color="#e8c547"/>}
            {Object.entries(bill.lines).map(([k,l])=>(
              <ChkRow key={k} label={`${l.name} — ${l.usage} ${l.unit} = ${fmt(l.amount)}`} checked={!!inclLines[k]} onChange={()=>setInclLines(prev=>({...prev,[k]:!prev[k]}))} color="#6bc5f8"/>
            ))}
          </div>
          <div style={{marginTop:10,padding:"8px 12px",background:"#1a1a2e",borderRadius:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{color:"#888",fontSize:13}}>סה״כ נבחר לתשלום</span>
            <span style={{fontWeight:900,fontSize:20,color:"#e8c547"}}>{fmt(grandTotal)}</span>
          </div>
        </div>

        {/* Preview */}
        <div style={{background:"#fff",color:"#222",borderRadius:10,padding:18,fontSize:12,lineHeight:1.7,direction:"rtl",marginBottom:18}}>
          <div style={{fontWeight:800,fontSize:15,borderBottom:"3px solid #1a1a2e",paddingBottom:6,marginBottom:12}}>🏢 דרישת תשלום — {periodLabel(month)}</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:12,fontSize:11,color:"#555"}}>
            <div><strong style={{color:"#222"}}>לכבוד:</strong> {currentTenant(unit).name}<br/><strong style={{color:"#222"}}>יחידה:</strong> {unit.name}</div>
            <div style={{textAlign:"left"}}><strong style={{color:"#222"}}>תאריך:</strong> {today}<br/><strong style={{color:"#222"}}>לתשלום עד:</strong> {due}</div>
          </div>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
            <thead><tr style={{background:"#1a1a2e",color:"#e8c547"}}>
              <th style={{padding:"6px 8px",textAlign:"right"}}>פריט</th>
              <th style={{padding:"6px 8px",textAlign:"right"}}>פירוט</th>
              <th style={{padding:"6px 8px",textAlign:"right"}}>סכום</th>
            </tr></thead>
            <tbody>
              {inclRent&&<tr><td style={{padding:"6px 8px",borderBottom:"1px solid #eee"}}>שכירות חודשית</td><td style={{padding:"6px 8px",borderBottom:"1px solid #eee",color:"#777"}}>{periodLabel(month)}</td><td style={{padding:"6px 8px",borderBottom:"1px solid #eee",fontWeight:700}}>{fmt(unit.rent)}</td></tr>}
              {arnonaAmt>0&&<tr><td style={{padding:"6px 8px",borderBottom:"1px solid #eee"}}>ארנונה + מיסי מושב</td><td style={{padding:"6px 8px",borderBottom:"1px solid #eee",color:"#777"}}>{periodLabel(month)}</td><td style={{padding:"6px 8px",borderBottom:"1px solid #eee",fontWeight:700}}>{fmt(arnonaAmt)}</td></tr>}
              {activeLines.map(([k,l])=>(
                <tr key={k}>
                  <td style={{padding:"6px 8px",borderBottom:"1px solid #eee"}}>{l.name}</td>
                  <td style={{padding:"6px 8px",borderBottom:"1px solid #eee",color:"#777",fontSize:10}}>
                    {l.tiered
                      ? <>מוזל: {l.lowUsage.toFixed(1)}×{l.priceLow}₪{l.highUsage>0&&<> + יקר: {l.highUsage.toFixed(1)}×{l.priceHigh}₪</>}<br/><span style={{color:"#aaa"}}>{l.persons} נפשות × {l.perPersonQty} = {l.allowance.toFixed(0)} מ״ק מוזל</span></>
                      : <>{lineDetail(l)}</>
                    }
                  </td>
                  <td style={{padding:"6px 8px",borderBottom:"1px solid #eee"}}>{fmt(l.amount)}</td>
                </tr>
              ))}
              <tr style={{background:"#f5f5f5"}}><td colSpan={2} style={{padding:"8px",fontWeight:800}}>סה״כ לתשלום</td><td style={{padding:"8px",fontWeight:900,fontSize:14,color:"#1a1a2e"}}>{fmt(grandTotal)}</td></tr>
            </tbody>
          </table>
        </div>

        {/* Actions */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
          <button onClick={shareWhatsApp} style={{...S.btn("#25d366","#fff"),display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            <span style={{fontSize:18}}>📱</span> שלח WhatsApp
          </button>
          <button onClick={shareEmail} style={{...S.btn("#2563eb","#fff"),display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            <span style={{fontSize:18}}>✉️</span> שלח אימייל
          </button>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <button onClick={print} style={{...S.btn("#e8c547","#1a1a2e"),display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            🖨️ הדפסה
          </button>
          <button onClick={copyWA} style={{...S.btn(copied?"#1a3a1a":"#2a2a4a",copied?"#4caf88":"#aaa"),display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            {copied?"✓ הועתק!":"📋 העתק טקסט"}
          </button>
        </div>
        <button onClick={onClose} style={{...S.btn("transparent","#555"),width:"100%",marginTop:10,fontSize:12}}>סגור</button>
      </div>
    </div>
  );
}


// ─── TARIFF EDITOR ───────────────────────────────────────────────────────────

function TariffEditor({tariffs, save, unitsCount=1}){
  const [open, setOpen] = useState(false);
  const t = tariffs;
  const upT = (key,field,val) => save(d=>({...d, tariffs:{...d.tariffs,[key]:{...d.tariffs[key],[field]:parseFloat(val)||0}}}));

  return(
    <Card style={{marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}} onClick={()=>setOpen(o=>!o)}>
        <div style={{fontWeight:700,color:"#e8c547"}}>⚙️ הגדרות תעריפים</div>
        <span style={{color:"#666",fontSize:18}}>{open?"▲":"▼"}</span>
      </div>
      {open&&(
        <div style={{marginTop:16,display:"flex",flexDirection:"column",gap:14}}>

          {/* Water tiered */}
          <div style={{background:"#0e0e20",borderRadius:10,padding:14}}>
            <div style={{fontWeight:700,color:"#6bc5f8",marginBottom:10}}>💧 מים — תמחור מדורג לפי נפשות</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:10}}>
              <label style={S.lbl}>כמות מוזלת לנפש (מ״ק)
                <input type="number" step="0.5" value={t.water.perPersonQty} onChange={e=>upT("water","perPersonQty",e.target.value)} style={S.inp}/>
              </label>
              <label style={S.lbl}>תדירות חיוב
                <select value={t.water.billingMonths||2} onChange={e=>upT("water","billingMonths",e.target.value)} style={S.inp}>
                  <option value={1}>חודשי</option>
                  <option value={2}>דו-חודשי</option>
                </select>
              </label>
              <label style={S.lbl}>מחיר מדרגה 1 — מוזל (₪/מ״ק)
                <input type="number" step="0.01" value={t.water.priceLow} onChange={e=>upT("water","priceLow",e.target.value)} style={{...S.inp,borderColor:"#4caf8855"}}/>
              </label>
              <label style={S.lbl}>מחיר מדרגה 2 — יקר (₪/מ״ק)
                <input type="number" step="0.01" value={t.water.priceHigh} onChange={e=>upT("water","priceHigh",e.target.value)} style={{...S.inp,borderColor:"#e85c4a55"}}/>
              </label>
            </div>
            <div style={{marginTop:10,fontSize:11,color:"#555"}}>
              דוגמה: דירה עם 3 נפשות → מכסה מוזלת = {(3*t.water.perPersonQty).toFixed(0)} מ״ק · מעל = {t.water.priceHigh} ₪/מ״ק
            </div>
          </div>

          {/* Electricity */}
          <div style={{background:"#0e0e20",borderRadius:10,padding:14}}>
            <div style={{fontWeight:700,color:"#e8c547",marginBottom:10}}>⚡ חשמל</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:10}}>
              <label style={S.lbl}>מחיר ברירת מחדל (₪/קוט״ש)
                <input type="number" step="0.001" value={t.electricity.price} onChange={e=>upT("electricity","price",e.target.value)} style={S.inp}/>
              </label>
              <label style={S.lbl}>עלויות קבועות בחשבון (₪)
                <input type="number" step="1" value={t.electricity.fixedCostTotal||0} onChange={e=>upT("electricity","fixedCostTotal",e.target.value)} style={{...S.inp,borderColor:"#e8c54755"}}/>
              </label>
              <label style={S.lbl}>חלוקת עלויות קבועות
                <select value={t.electricity.fixedSplitMethod||"equal"} onChange={e=>save(d=>({...d,tariffs:{...d.tariffs,electricity:{...d.tariffs.electricity,fixedSplitMethod:e.target.value}}}))} style={{...S.inp}}>
                  <option value="equal">שווה בין כל הדירות</option>
                  <option value="byUsage">יחסית לצריכה</option>
                </select>
              </label>
            </div>
            {(t.electricity.fixedCostTotal||0)>0&&(
              <div style={{marginTop:8,fontSize:11,color:"#888"}}>
                חלק לדירה (חלוקה שווה): {fmt((t.electricity.fixedCostTotal||0)/Math.max(1,unitsCount))} · {unitsCount} דירות פעילות
              </div>
            )}
          </div>

          {/* Sewage */}
          <div style={{background:"#0e0e20",borderRadius:10,padding:14}}>
            <div style={{fontWeight:700,color:"#a78bfa",marginBottom:10,fontSize:13}}>🚿 ביוב — מטה יהודה</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
              <div onClick={()=>save(d=>({...d,tariffs:{...d.tariffs,sewage:{...d.tariffs.sewage,sewageMode:"manual"}}}))}
                style={{cursor:"pointer",padding:"10px 14px",borderRadius:8,border:`2px solid ${(t.sewage.sewageMode||"manual")==="manual"?"#a78bfa":"#2a2a4a"}`,background:(t.sewage.sewageMode||"manual")==="manual"?"#1a1230":"#0e0e20"}}>
                <div style={{color:"#a78bfa",fontWeight:700,fontSize:12,marginBottom:4}}>✏️ הזנה ידנית</div>
                <div style={{color:"#555",fontSize:11}}>תזין סכום ביוב ידנית בכל חשבון</div>
              </div>
              <div onClick={()=>save(d=>({...d,tariffs:{...d.tariffs,sewage:{...d.tariffs.sewage,sewageMode:"auto"}}}))}
                style={{cursor:"pointer",padding:"10px 14px",borderRadius:8,border:`2px solid ${t.sewage.sewageMode==="auto"?"#a78bfa":"#2a2a4a"}`,background:t.sewage.sewageMode==="auto"?"#1a1230":"#0e0e20"}}>
                <div style={{color:"#a78bfa",fontWeight:700,fontSize:12,marginBottom:4}}>🤖 אוטומטי</div>
                <div style={{color:"#555",fontSize:11}}>חישוב לפי מנגנון חורף/קיץ מטה יהודה</div>
              </div>
            </div>
            {t.sewage.sewageMode==="auto"&&(
              <div style={{background:"#12122a",borderRadius:8,padding:12,fontSize:12,color:"#888",marginBottom:10}}>
                <div style={{color:"#a78bfa",fontWeight:700,marginBottom:6}}>מנגנון חישוב — מטה יהודה</div>
                <div>חורף (דצ׳–מרץ): 100% × צריכה × {t.sewage.sewageRatePerCubic||6.9} ₪/מ״ק</div>
                <div style={{marginTop:4}}>קיץ (אפר׳–נוב׳): 100% × ממוצע חורף × {t.sewage.sewageRatePerCubic||6.9} ₪/מ״ק</div>
                <div style={{marginTop:4,color:"#555",fontSize:11}}>⚠️ דורש היסטוריית קריאות של 4 חודשי חורף</div>
              </div>
            )}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <label style={S.lbl}>תעריף ביוב (₪/מ״ק)
                <input type="number" step="0.01" value={t.sewage.sewageRatePerCubic||6.9} onChange={e=>save(d=>({...d,tariffs:{...d.tariffs,sewage:{...d.tariffs.sewage,sewageRatePerCubic:+e.target.value||0}}}))} style={S.inp}/>
              </label>
              <label style={S.lbl}>מחיר ברירת מחדל (₪/מ״ק) — שימוש בחישוב ישן
                <input type="number" step="0.01" value={t.sewage.price} onChange={e=>upT("sewage","price",e.target.value)} style={S.inp}/>
              </label>
            </div>
          </div>

        </div>
      )}
    </Card>
  );
}


// ─── ELECTRICITY BILL UPLOAD MODAL ───────────────────────────────────────────

function ElectricityUploadModal({tariffs, buildingBills, onSave, onClose}){
  const [selPeriod, setSelPeriod] = useState(BIMONTHLY_PERIODS[0].key);
  const currentBuildingBill = (buildingBills||{})[selPeriod] || null;
  const [loading, setLoading] = useState(false);
  const [result,  setResult]  = useState(null); // parsed data from Claude
  const [error,   setError]   = useState(null);
  const [preview, setPreview] = useState(null); // base64 for display
  // editForm: {periods:[{kwh,price}], fixedCosts}
  const [form, setForm] = useState({periods:[{kwh:"",price:tariffs.electricity.price,dateFrom:"",dateTo:""}], fixedCosts:""});

  // Re-seed form whenever selected period changes and has an existing bill
  useEffect(()=>{
    if(currentBuildingBill){
      setForm({periods:currentBuildingBill.periods.map(p=>({...p})), fixedCosts:currentBuildingBill.fixedCostTotal||""});
    } else {
      setForm({periods:[{kwh:"",price:tariffs.electricity.price,dateFrom:"",dateTo:""}], fixedCosts:""});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[selPeriod]);

  const handleFile = async(e)=>{
    const file = e.target.files?.[0];
    if(!file) return;
    setError(null); setResult(null);
    // Convert to base64
    const b64 = await new Promise((res,rej)=>{
      const r=new FileReader();
      r.onload=()=>res(r.result.split(",")[1]);
      r.onerror=rej;
      r.readAsDataURL(file);
    });
    const isPDF = file.type==="application/pdf";
    setPreview(isPDF ? null : `data:${file.type};base64,${b64}`);
    setLoading(true);
    try {
      const mediaType = isPDF ? "application/pdf" : file.type;
      const prompt = `אתה מנתח חשבון חשמל ישראלי.
חלץ מהמסמך הבא את הנתונים הבאים ב-JSON בלבד (ללא טקסט נוסף):
{
  "periods": [ { "kwh": <מספר קוט״ש>, "price": <מחיר לקוט״ש>, "dateFrom": "<מ>", "dateTo": "<עד>" } ],
  "fixedCosts": <סה״כ עלויות קבועות בשקלים (דמי שירות, הוצאות קבועות, כל מה שלא תלוי בצריכה)>,
  "totalKwh": <סה״כ קוט״ש>,
  "totalAmount": <סה״כ חשבון בשקלים>
}
אם יש תקופה אחת בלבד — periods יכיל איבר אחד.
אם המחיר השתנה באמצע התקופה — periods יכיל מספר איברים.
החזר JSON בלבד.`;
      const msgContent = isPDF
        ? [{type:"document",source:{type:"base64",media_type:mediaType,data:b64}},{type:"text",text:prompt}]
        : [{type:"image",source:{type:"base64",media_type:mediaType,data:b64}},{type:"text",text:prompt}];

      const text = await callAI({messages:[{role:"user",content:msgContent}], max_tokens:1000});
      const parsed = JSON.parse(text);
      setResult(parsed);
      setForm({
        periods: parsed.periods.map(p=>({kwh:p.kwh,price:p.price,dateFrom:p.dateFrom||"",dateTo:p.dateTo||""})),
        fixedCosts: parsed.fixedCosts||0,
      });
    } catch(e){
      setError("לא הצלחתי לקרוא את החשבון. נסה תמונה ברורה יותר, או הכנס נתונים ידנית.");
      setForm({periods:[{kwh:"",price:tariffs.electricity.price,dateFrom:"",dateTo:""}],fixedCosts:""});
    }
    setLoading(false);
  };

  const addPeriod=()=>setForm(f=>({...f,periods:[...f.periods,{kwh:"",price:tariffs.electricity.price,dateFrom:"",dateTo:""}]}));
  const remPeriod=(i)=>setForm(f=>({...f,periods:f.periods.filter((_,j)=>j!==i)}));
  const upPeriod=(i,field,val)=>setForm(f=>({...f,periods:f.periods.map((p,j)=>j===i?{...p,[field]:val}:p)}));

  const totalKwh  = form.periods.reduce((s,p)=>s+(+p.kwh||0),0);
  const totalElec = form.periods.reduce((s,p)=>s+(+p.kwh||0)*(+p.price||0),0) + (+form.fixedCosts||0);

  const [splitMethod,setSplitMethod]=useState((currentBuildingBill?.fixedSplitMethod)||"equal");
  const handleSave=()=>{
    const periods = form.periods.map(p=>({kwh:+p.kwh||0,price:+p.price||0,dateFrom:p.dateFrom,dateTo:p.dateTo}));
    onSave({periods, fixedCosts:+form.fixedCosts||0, fixedSplitMethod:splitMethod, periodKey:selPeriod});
  };

  return(
    <div style={{position:"fixed",inset:0,background:"#000c",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{background:"#12122a",border:"1px solid #2a2a4a",borderRadius:16,padding:24,maxWidth:580,width:"95%",maxHeight:"92vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div style={{fontWeight:800,fontSize:17,color:"#e8c547"}}>⚡ חשבון חשמל ראשי — הבניין</div>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#888",fontSize:22,cursor:"pointer"}}>✕</button>
        </div>

        {/* File upload */}
        <div style={{marginBottom:16}}>
          <label style={{display:"block",border:"2px dashed #2a2a4a",borderRadius:10,padding:20,textAlign:"center",cursor:"pointer",background:"#0e0e20"}}>
            <div style={{fontSize:28,marginBottom:6}}>📎</div>
            <div style={{color:"#888",fontSize:13}}>לחץ להעלאת חשבון חשמל (PDF או תמונה)</div>
            <input type="file" accept="image/*,application/pdf" onChange={handleFile} style={{display:"none"}}/>
          </label>
        </div>

        {loading&&(
          <div style={{textAlign:"center",padding:20,color:"#e8c547"}}>
            <div style={{fontSize:24,marginBottom:8}}>🤖</div>
            <div>Claude קורא את החשבון…</div>
          </div>
        )}

        {preview&&<img src={preview} alt="חשבון" style={{width:"100%",borderRadius:8,marginBottom:12,maxHeight:180,objectFit:"contain",background:"#fff"}}/>}
        {error&&<div style={{color:"#e85c4a",fontSize:12,marginBottom:12,padding:"8px 12px",background:"#2a1010",borderRadius:8}}>⚠️ {error}</div>}
        {result&&<div style={{color:"#4caf88",fontSize:12,marginBottom:12,padding:"8px 12px",background:"#0a2a1a",borderRadius:8}}>✓ נקרא בהצלחה — בדוק את הנתונים ותקן אם צריך</div>}

        {/* Periods editor */}
        <div style={{marginBottom:14}}>
          <div style={{fontWeight:700,color:"#aaa",fontSize:13,marginBottom:8}}>תקופות צריכה</div>
          {form.periods.map((p,i)=>(
            <div key={i} style={{background:"#0e0e20",borderRadius:8,padding:12,marginBottom:8}}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr auto",gap:8,alignItems:"end"}}>
                <label style={S.lbl}>קוט״ש<input type="number" value={p.kwh} onChange={e=>upPeriod(i,"kwh",e.target.value)} style={S.inp}/></label>
                <label style={S.lbl}>מחיר/קוט״ש<input type="number" step="0.001" value={p.price} onChange={e=>upPeriod(i,"price",e.target.value)} style={S.inp}/></label>
                <label style={S.lbl}>מתאריך<input type="date" value={p.dateFrom||""} onChange={e=>upPeriod(i,"dateFrom",e.target.value)} style={S.inp}/></label>
                <label style={S.lbl}>עד<input type="date" value={p.dateTo||""} onChange={e=>upPeriod(i,"dateTo",e.target.value)} style={S.inp}/></label>
                {form.periods.length>1&&<button onClick={()=>remPeriod(i)} style={{...S.btn("#2a1010","#e85c4a"),padding:"4px 8px",alignSelf:"flex-end",marginTop:4}}>✕</button>}
              </div>
              <div style={{fontSize:11,color:"#555",marginTop:4}}>סה״כ: {fmt((+p.kwh||0)*(+p.price||0))}</div>
            </div>
          ))}
          <button onClick={addPeriod} style={{...S.btn("#1a1a2e","#6bc5f8"),fontSize:12}}>+ הוסף תקופה</button>
        </div>

        {/* Fixed costs */}
        <div style={{marginBottom:16,display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <label style={S.lbl}>עלויות קבועות (₪) — דמי שירות, מנוי וכד׳
            <input type="number" step="1" value={form.fixedCosts} onChange={e=>setForm(f=>({...f,fixedCosts:e.target.value}))} style={S.inp}/>
          </label>
          <label style={S.lbl}>חלוקת עלויות קבועות
            <select value={splitMethod} onChange={e=>setSplitMethod(e.target.value)} style={S.inp}>
              <option value="equal">שווה בין כל הדירות</option>
              <option value="byUsage">יחסית לצריכה</option>
            </select>
          </label>
        </div>

        {/* Summary */}
        <div style={{background:"#1a1a2e",borderRadius:8,padding:12,marginBottom:16,display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,textAlign:"center"}}>
          <div><div style={{color:"#666",fontSize:11}}>סה״כ קוט״ש</div><div style={{color:"#ddd",fontWeight:700}}>{totalKwh.toFixed(0)}</div></div>
          <div><div style={{color:"#666",fontSize:11}}>עלויות קבועות</div><div style={{color:"#ddd",fontWeight:700}}>{fmt(+form.fixedCosts||0)}</div></div>
          <div><div style={{color:"#666",fontSize:11}}>סה״כ חשמל</div><div style={{color:"#e8c547",fontWeight:900}}>{fmt(totalElec)}</div></div>
        </div>

        <div style={{display:"flex",gap:10}}>
          <button onClick={handleSave} style={{...S.btn("#e8c547","#1a1a2e"),flex:1}}>💾 שמור נתוני חשמל</button>
          <button onClick={onClose} style={S.btn("#2a2a4a","#888")}>ביטול</button>
        </div>
      </div>
    </div>
  );
}


// ─── METER SCAN MODAL ────────────────────────────────────────────────────────

function MeterScanModal({units, utilType, selectedPeriod, onSave, onClose}){
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null); // [{meterId, reading}]
  const [error,   setError]   = useState(null);
  const [preview, setPreview] = useState(null);
  const [edits,   setEdits]   = useState({});   // {unitId: reading}

  const meterIdField = utilType==="water" ? "waterMeterId" : "electricMeterId";
  const unitLabel    = utilType==="water" ? "מים" : "חשמל";

  // Build lookup: meterId → unit
  const meterMap = {};
  for(const u of units){
    const mid = u[meterIdField];
    if(mid) meterMap[mid.trim()] = u;
  }

  const handleFile = async(e)=>{
    const file = e.target.files?.[0];
    if(!file) return;
    setError(null); setResults(null);
    const b64 = await new Promise((res,rej)=>{
      const r=new FileReader(); r.onload=()=>res(r.result.split(",")[1]); r.onerror=rej; r.readAsDataURL(file);
    });
    setPreview(`data:${file.type};base64,${b64}`);
    setLoading(true);

    const meterIds = units.map(u=>u[meterIdField]).filter(Boolean);
    const prompt = `אתה מנתח תמונה של מוני ${unitLabel}.
זהה את כל המונים הנראים בתמונה.
לכל מונה שאתה מזהה, החזר את מספר המונה ואת הקריאה הנוכחית (המספר המוצג).
מספרי המונים שאנחנו מחפשים: ${meterIds.join(", ")}
החזר JSON בלבד (ללא טקסט נוסף):
{
  "meters": [
    {"meterId": "<מספר מונה>", "reading": <קריאה מספרית>, "confidence": "high"|"medium"|"low"}
  ]
}
אם לא מצאת מונה מסוים, אל תכלול אותו.`;

    try {
      const text = await callAI({
        messages:[{role:"user",content:[
          {type:"image",source:{type:"base64",media_type:file.type,data:b64}},
          {type:"text",text:prompt}
        ]}],
        max_tokens:500
      });
      const parsed = JSON.parse(text);
      const meters = parsed.meters || [];

      // Match to units
      const matched = [];
      const initEdits = {};
      for(const m of meters){
        const unit = meterMap[m.meterId?.trim()];
        if(unit){
          matched.push({...m, unit});
          initEdits[unit.id] = m.reading;
        }
      }
      setResults(matched);
      setEdits(initEdits);
      if(matched.length===0) setError("לא זוהו מונים מוכרים בתמונה. בדוק שמספרי המונים מוזנים נכון בפרטי הדירות.");
    } catch(e){
      setError("שגיאה בקריאת התמונה. נסה תמונה ברורה יותר.");
    }
    setLoading(false);
  };

  const confidenceColor = c => c==="high"?"#4caf88":c==="medium"?"#e8c547":"#e85c4a";

  return(
    <div style={{position:"fixed",inset:0,background:"#000c",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{background:"#12122a",border:"1px solid #2a2a4a",borderRadius:16,padding:24,maxWidth:560,width:"95%",maxHeight:"92vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
          <div style={{fontWeight:800,fontSize:17,color:"#e8c547"}}>📷 סריקת מוני {unitLabel}</div>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#888",fontSize:22,cursor:"pointer"}}>✕</button>
        </div>
        <div style={{marginBottom:12,padding:"6px 12px",background:"#1a1a10",borderRadius:8,fontSize:12,color:"#e8c547"}}>📅 תקופה: {periodLabel(selectedPeriod)}</div>

        <label style={{display:"block",border:"2px dashed #2a2a4a",borderRadius:10,padding:18,textAlign:"center",cursor:"pointer",background:"#0e0e20",marginBottom:14}}>
          <div style={{fontSize:28,marginBottom:4}}>📷</div>
          <div style={{color:"#888",fontSize:13}}>צלם ועלה תמונה של המונים</div>
          <div style={{color:"#555",fontSize:11,marginTop:2}}>ניתן לצלם כמה מונים יחד באותה תמונה</div>
          <input type="file" accept="image/*" capture="environment" onChange={handleFile} style={{display:"none"}}/>
        </label>

        {preview&&<img src={preview} alt="מונים" style={{width:"100%",borderRadius:8,marginBottom:12,maxHeight:200,objectFit:"contain",background:"#111"}}/>}

        {loading&&<div style={{textAlign:"center",padding:16,color:"#e8c547"}}>
          <div style={{fontSize:22,marginBottom:6}}>🤖</div>
          <div style={{fontSize:13}}>Claude מזהה מספרי מונים וקריאות…</div>
        </div>}

        {error&&<div style={{color:"#e85c4a",fontSize:12,marginBottom:12,padding:"8px 12px",background:"#2a1010",borderRadius:8}}>⚠️ {error}</div>}

        {results&&results.length>0&&(
          <div style={{marginBottom:16}}>
            <div style={{fontWeight:700,color:"#4caf88",fontSize:13,marginBottom:10}}>✓ זוהו {results.length} מונים — אשר קריאות:</div>
            {results.map(m=>(
              <div key={m.unit.id} style={{background:"#0e0e20",borderRadius:8,padding:12,marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                  <div>
                    <span style={{fontWeight:700,color:"#e8c547"}}>{m.unit.name}</span>
                    <span style={{color:"#555",margin:"0 6px"}}>·</span>
                    <span style={{color:"#888",fontSize:12}}>מונה {m.meterId}</span>
                  </div>
                  <span style={{fontSize:11,color:confidenceColor(m.confidence),border:`1px solid ${confidenceColor(m.confidence)}44`,borderRadius:10,padding:"1px 8px"}}>
                    {m.confidence==="high"?"ודאי":m.confidence==="medium"?"בינוני":"נמוך"}
                  </span>
                </div>
                <label style={S.lbl}>קריאה נוכחית ({utilType==="water"?"מ״ק":"קוט״ש"})
                  <input type="number" value={edits[m.unit.id]??""} onChange={e=>setEdits(prev=>({...prev,[m.unit.id]:+e.target.value}))} style={S.inp}/>
                </label>
              </div>
            ))}
          </div>
        )}

        {/* Units without a match */}
        {results&&units.filter(u=>!results.find(m=>m.unit.id===u.id)).map(u=>(
          <div key={u.id} style={{background:"#1a1010",borderRadius:8,padding:10,marginBottom:6,fontSize:12}}>
            <span style={{color:"#666"}}>לא זוהה: </span>
            <span style={{color:"#888"}}>{u.name}</span>
            <span style={{color:"#555",fontSize:11}}> (מונה {u[meterIdField]||"לא הוגדר"})</span>
          </div>
        ))}

        <div style={{display:"flex",gap:10,marginTop:8}}>
          {results&&results.length>0&&(
            <button onClick={()=>onSave({edits,periodKey:selectedPeriod})} style={{...S.btn("#e8c547","#1a1a2e"),flex:1}}>💾 שמור קריאות</button>
          )}
          <button onClick={onClose} style={S.btn("#2a2a4a","#888")}>סגור</button>
        </div>
      </div>
    </div>
  );
}


// ─── PER-ITEM PAYMENT MODAL ───────────────────────────────────────────────────

function PaymentItemsModal({bill, calc, unit, monthKey, onSave, onClose}){
  const items = getPayments(bill, calc.lines, unit.rent);
  const [form, setForm] = React.useState(()=>{
    // Initialize from existing payments — only show items with actual calc data
    const f = {};
    for(const [k, meta] of Object.entries(ITEM_LABELS)){
      if(items[k] !== undefined && (k==='rent' || calc.lines[k])){
        f[k] = {
          paid:    items[k].paid || false,
          amount:  items[k].amount ?? (k==='rent' ? unit.rent : calc.lines[k]?.amount ?? 0),
          partial: items[k].amount !== null && items[k].amount < (k==='rent' ? unit.rent : calc.lines[k]?.amount ?? 0),
        };
      }
    }
    return f;
  });

  const expectedAmounts = {
    rent:        unit.rent,
    water:       calc.lines.water?.amount || 0,
    electricity: calc.lines.electricity?.amount || 0,
    sewage:      calc.lines.sewage?.amount || 0,
  };

  const handleSave = () => {
    const payments = {};
    for(const [k, v] of Object.entries(form)){
      payments[k] = {
        paid: v.paid,
        amount: v.paid ? (+v.amount || expectedAmounts[k]) : null,
        date: v.paid ? new Date().toLocaleDateString("en-CA") : null,
      };
    }
    // bill is fully paid when all items paid
    const allPaid = Object.values(payments).every(p => p.paid);
    onSave({payments, paid: allPaid, paidDate: allPaid ? new Date().toLocaleDateString("en-CA") : null});
  };

  const toggleItem = (k) => setForm(f => ({...f, [k]: {...f[k], paid: !f[k].paid}}));
  const setAmount = (k, v) => setForm(f => ({...f, [k]: {...f[k], amount: v}}));

  return(
    <div style={{position:"fixed",inset:0,background:"#000c",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{background:"#12122a",border:"1px solid #2a2a4a",borderRadius:16,padding:24,maxWidth:460,width:"95%",maxHeight:"90vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div style={{fontWeight:800,fontSize:17,color:"#e8c547"}}>💳 עדכון תשלומים</div>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#888",fontSize:22,cursor:"pointer"}}>✕</button>
        </div>
        <div style={{color:"#666",fontSize:12,marginBottom:16}}>{unit.name} · {periodLabel(monthKey)}</div>

        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          {Object.entries(form).map(([k, v]) => {
            const meta = ITEM_LABELS[k];
            const expected = expectedAmounts[k];
            const isPartial = v.paid && +v.amount < expected;
            return (
              <div key={k} style={{background:"#0e0e20",borderRadius:10,padding:14,border:`1px solid ${v.paid ? meta.color+"44" : "#2a2a4a"}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:v.paid?10:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer"}} onClick={()=>toggleItem(k)}>
                    <div style={{width:22,height:22,borderRadius:6,background:v.paid?meta.color:"transparent",border:`2px solid ${v.paid?meta.color:"#444"}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                      {v.paid&&<span style={{color:"#1a1a2e",fontSize:13,fontWeight:900}}>✓</span>}
                    </div>
                    <span style={{fontSize:15}}>{meta.icon}</span>
                    <span style={{color:v.paid?"#ddd":"#888",fontWeight:600}}>{meta.label}</span>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{color:v.paid?meta.color:"#555",fontSize:12}}>{fmt(expected)}</div>
                    {isPartial&&<div style={{color:"#a78bfa",fontSize:10}}>חלקי</div>}
                  </div>
                </div>
                {v.paid&&(
                  <div style={{marginTop:8}}>
                    <label style={{color:"#666",fontSize:11,display:"block",marginBottom:4}}>סכום ששולם (₪)</label>
                    <input
                      type="number"
                      value={v.amount}
                      onChange={e=>setAmount(k, e.target.value)}
                      style={{background:"#12122a",border:`1px solid ${meta.color}44`,color:"#ddd",padding:"6px 10px",borderRadius:6,fontSize:13,fontFamily:"inherit",width:"100%",boxSizing:"border-box"}}
                    />
                    {+v.amount < expected && +v.amount > 0 && (
                      <div style={{color:"#a78bfa",fontSize:11,marginTop:3}}>
                        תשלום חלקי · נותר: {fmt(expected - +v.amount)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{display:"flex",gap:10,marginTop:20}}>
          <button onClick={handleSave} style={{...S.btn("#e8c547","#1a1a2e"),flex:1}}>💾 שמור</button>
          <button onClick={onClose} style={S.btn("#2a2a4a","#888")}>ביטול</button>
        </div>
      </div>
    </div>
  );
}

// ─── BILLS TAB ───────────────────────────────────────────────────────────────

function AddBillForm({units,bills,onAdd}){
  const [uid,setUid]=useState(units[0]?.id||"");
  // Default to the closest past period (most recent one before or equal to today)
  const defaultPeriod = (() => {
    const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD
    const past = BIMONTHLY_PERIODS.filter(p=>p.key<=today.slice(0,7));
    return past.length>0 ? past[past.length-1].key : BIMONTHLY_PERIODS[0]?.key || "";
  })();
  const [period,setPeriod]=useState(defaultPeriod);
  const exists=!!bills[bKey(uid,period)];
  return(
    <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end"}}>
      <label style={S.lbl}>יחידה<select value={uid} onChange={e=>setUid(+e.target.value)} style={{...S.sel,display:"block",marginTop:4}}>{units.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
      <label style={S.lbl}>תקופה<select value={period} onChange={e=>setPeriod(e.target.value)} style={{...S.sel,display:"block",marginTop:4}}>{BIMONTHLY_PERIODS.map(p=><option key={p.key} value={p.key}>{p.label}</option>)}</select></label>
      {exists?<div style={{color:"#e85c4a",fontSize:12,padding:"8px 0"}}>⚠ חשבון קיים כבר</div>:<button onClick={()=>onAdd(uid,period)} style={S.btn("#e8c547","#1a1a2e")}>➕ צור חשבון</button>}
    </div>
  );
}

function BillsTab({data,save,readonly=false,unitFilter=null}){
  const {units,bills,tariffs}=data;
  const [demand,setDemand]=useState(null);
  const [editKey,setEditKey]=useState(null);
  const [editForm,setEditForm]=useState({});
  const [editError,setEditError]=useState(null);
  const [partialKey,setPartialKey]=useState(null);
  const [partialAmount,setPartialAmount]=useState("");
  const [paymentModal,setPaymentModal]=useState(null); // {k,unit,month,b,calc}
  const [filterUnit,setFilterUnit]=useState("all");
  const [filterPaid,setFilterPaid]=useState("all");
  const [elecUpload,setElecUpload]=useState(null); // {k, unit, month}
  const [meterScan,setMeterScan]=useState(null); // 'water'|'electricity'
  const [meterScanPeriod,setMeterScanPeriod]=useState(BIMONTHLY_PERIODS[0]?.key||'');

  const rows=[];
  for(const unit of units){
    if(unitFilter!=null && unit.id!==+unitFilter) continue; // unit_viewer filter
    for(const month of ALL_MONTHS){
      const k=bKey(unit.id,month),b=bills[k];
      if(b){
      const _wUsage = (b.readings?.water?.curr??0)-(b.readings?.water?.prev??0);
      const _sewAmt = tariffs.sewage?.sewageMode==="auto" && b.readings?.water
        ? calcSewageAuto(month, unit.id, data.bills, _wUsage, tariffs.sewage?.sewageRatePerCubic||6.9)
        : null;
      rows.push({k,unit,month,b,calc:calcBill(b.readings,tariffs,unit,units,(data.buildingBills||{})[month],data.bills,month,b.noWaterDiscount||false,_sewAmt!=null?{sewageAmount:_sewAmt}:null)});
    }
    }
  }
  const visible=rows
    .filter(r=>filterUnit==="all"||r.unit.id===+filterUnit)
    .filter(r=>filterPaid==="all"||(filterPaid==="paid"?r.b.paid:!r.b.paid));

  const togglePaid=(k)=>save(d=>{
    const b=d.bills[k];
    const nowPaid=!b.paid;
    return{...d,bills:{...d.bills,[k]:{
      ...b,
      paid:nowPaid,
      locked:nowPaid,
      paidDate:nowPaid?new Date().toLocaleDateString("en-CA"):null,
      payments:nowPaid?b.payments:null,   // clear payments when reverting
      partialPaid:nowPaid?b.partialPaid:false,
      partialAmount:nowPaid?b.partialAmount:null,
      lockedAmount:nowPaid?(()=>{
        const unit=d.units.find(u=>u.id===+k.split("_")[0]);
        const month=k.split("_")[1];
        const calc=calcBill(b.readings,d.tariffs,unit,d.units,(d.buildingBills||{})[month],d.bills,month,b.noWaterDiscount||false);
        return unit.rent+calc.total;
      })():null,
    }}};
  });

  const startEdit=(row)=>{
    if(row.b.locked){
      setEditError("החשבון נעול ולא ניתן לעריכה. כדי לערוך בטל תחילה את סימון התשלום.");
      return;
    }
    setEditKey(row.k);
    const f={};
    for(const tk of Object.keys(tariffs)) f[tk]={prev:row.b.readings?.[tk]?.prev??"",curr:row.b.readings?.[tk]?.curr??""};
    setEditForm(f);
  };

  const saveEdit=()=>{
    // Validate: curr must be >= prev
    for(const tk of Object.keys(tariffs)){
      const prev=+editForm[tk].prev, curr=+editForm[tk].curr;
      if(curr!=null && prev!=null && curr<prev){
        setEditError(`${tariffs[tk].name}: הקריאה הנוכחית (${curr}) קטנה מהקודמת (${prev})`); return;
      }
    }
    save(d=>{
      const readings={};
      const ts=new Date().toLocaleDateString("en-CA");
      for(const tk of Object.keys(tariffs)){
        const prev=+editForm[tk].prev;
        const curr=editForm[tk].curr===""||editForm[tk].curr==null?null:+editForm[tk].curr;
        readings[tk]={prev,curr,source:"manual",lastUpdated:ts};
      }
      return{...d,bills:{...d.bills,[editKey]:{...d.bills[editKey],readings}}};
    });
    setEditError(null);
    setEditKey(null);
  };

  const savePartial=()=>{
    const amt=+partialAmount||0;
    save(d=>({...d,bills:{...d.bills,[partialKey]:{...d.bills[partialKey],
      partialPaid:true,
      partialAmount:amt,
      paidDate:new Date().toLocaleDateString("en-CA"),
    }}}));
    setPartialKey(null);
    setPartialAmount("");
  };

  const savePayments=({payments, paid, paidDate})=>{
    save(d=>{
      const b = d.bills[paymentModal.k];
      // Also update lockedAmount if now fully paid
      let lockedAmount = b.lockedAmount;
      if(paid && !b.locked){
        const unit=d.units.find(u=>u.id===+paymentModal.k.split("_")[0]);
        const month=paymentModal.k.split("_")[1];
        const calc=calcBill(b.readings,d.tariffs,unit,d.units,(d.buildingBills||{})[month],d.bills,month,b.noWaterDiscount||false);
        lockedAmount = unit.rent + calc.total;
      }
      return {...d, bills:{...d.bills,[paymentModal.k]:{
        ...b,
        payments,
        paid,
        paidDate,
        locked: paid,
        lockedAmount: paid ? lockedAmount : null,
      }}};
    });
    setPaymentModal(null);
  };

  const addBill=(uid,month)=>{
    const k=bKey(uid,month);
    if(bills[k]) return;
    save(d=>{
      const prevW = getPrevReading(d.bills, uid, "water");
      const prevE = getPrevReading(d.bills, uid, "electricity");
      const prevS = getPrevReading(d.bills, uid, "sewage");
      return {...d,bills:{...d.bills,[k]:{
        paid:false,paidDate:null,readings:{
          water:      {prev:prevW??0, curr:null},
          electricity:{prev:prevE??0, curr:null},
          sewage:     {prev:prevS??0, curr:null},
        }
      }}};
    });
  };

  const unpaidCount=rows.filter(r=>!r.b.paid).length;
  const unpaidTotal=rows.filter(r=>!r.b.paid&&!r.unit.vacant).reduce((s,r)=>{
    const full=r.b.locked&&r.b.lockedAmount!=null?r.b.lockedAmount:r.unit.rent+r.calc.total;
    const paidSoFar=r.b.payments?Object.values(r.b.payments).reduce((a,p)=>a+(p?.paid&&p?.amount?+p.amount:0),0):0;
    return s+Math.max(0,full-paidSoFar);
  },0);
  const demandRow=demand?rows.find(r=>r.k===bKey(demand.unit.id,demand.month)):null;

  const saveElecUpload=({periods,fixedCosts,fixedSplitMethod,periodKey})=>{
    save(d=>({...d, buildingBills:{...(d.buildingBills||{}), [periodKey]:{periods,fixedCostTotal:fixedCosts,fixedSplitMethod:fixedSplitMethod||"equal",date:new Date().toLocaleDateString("en-CA"),source:"upload"}}}));
    setElecUpload(null);
  };

  const handleMeterScan=({edits, periodKey})=>{
    // edits = {unitId: reading}, periodKey = target period
    save(d=>{
      let newBills={...d.bills};
      for(const [uid,curr] of Object.entries(edits)){
        const k=bKey(+uid, periodKey);
        if(newBills[k]){
          const util = meterScan;
          newBills={...newBills,[k]:{...newBills[k],readings:{...newBills[k].readings,[util]:{...newBills[k].readings?.[util],curr:+curr,source:"scan",lastUpdated:new Date().toLocaleDateString("en-CA")}}}};
        }
      }
      return {...d,bills:newBills};
    });
    setMeterScan(null);
  };

  const getBB=(month)=>(data.buildingBills||{})[month];
  const allBBCount=Object.keys(data.buildingBills||{}).length;

  return(
    <div>
      {editError&&!editKey&&<div style={{position:"fixed",top:20,right:20,zIndex:300,background:"#2a0a0a",border:"1px solid #e85c4a",borderRadius:10,padding:"12px 18px",color:"#e85c4a",fontSize:13,maxWidth:340,boxShadow:"0 4px 20px #000a"}} onClick={()=>setEditError(null)}>⚠️ {editError} <span style={{color:"#666",fontSize:11,display:"block",marginTop:4}}>לחץ לסגירה</span></div>}
      {paymentModal&&<PaymentItemsModal
        bill={paymentModal.b}
        calc={paymentModal.calc}
        unit={paymentModal.unit}
        monthKey={paymentModal.month}
        onSave={savePayments}
        onClose={()=>setPaymentModal(null)}
      />}
      {partialKey&&(
        <div style={{position:"fixed",inset:0,background:"#000c",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{background:"#12122a",border:"1px solid #2a2a4a",borderRadius:14,padding:24,maxWidth:360,width:"90%"}}>
            <div style={{fontWeight:800,fontSize:16,color:"#a78bfa",marginBottom:16}}>💵 תשלום חלקי</div>
            <label style={S.lbl}>סכום ששולם (₪)
              <input type="number" value={partialAmount} onChange={e=>setPartialAmount(e.target.value)} style={S.inp} autoFocus placeholder="0"/>
            </label>
            <div style={{display:"flex",gap:10,marginTop:16}}>
              <button onClick={savePartial} style={{...S.btn("#a78bfa","#fff"),flex:1}}>💾 שמור</button>
              <button onClick={()=>setPartialKey(null)} style={S.btn("#2a2a4a","#888")}>ביטול</button>
            </div>
          </div>
        </div>
      )}
      {demandRow&&<PaymentDemandModal unit={demandRow.unit} month={demandRow.month} bill={demandRow.calc} onClose={()=>setDemand(null)}/>}
      {elecUpload&&<ElectricityUploadModal tariffs={tariffs} buildingBills={data.buildingBills||{}} onSave={saveElecUpload} onClose={()=>setElecUpload(null)}/>}
      {meterScan&&<MeterScanModal units={units} utilType={meterScan} selectedPeriod={meterScanPeriod} onSave={handleMeterScan} onClose={()=>setMeterScan(null)}/>}

      {unitFilter==null&&<>
      {/* Building electricity bills banner */}
      <Card style={{marginBottom:16,borderRight:"4px solid #e8c547"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:10}}>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,color:"#e8c547",marginBottom:8}}>⚡ חשבונות חשמל ראשיים — כל הבניין</div>
            {allBBCount===0 ? (
              <div style={{fontSize:12,color:"#e85c4a"}}>לא הועלו חשבונות חשמל — החישוב יתבסס על תעריף ברירת המחדל</div>
            ) : (
              <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                {BIMONTHLY_PERIODS.map(p=>{
                  const bb=getBB(p.key);
                  if(!bb) return null;
                  return(
                    <div key={p.key} style={{background:"#1a1a0a",border:"1px solid #e8c54744",borderRadius:6,padding:"4px 10px",fontSize:11}}>
                      <span style={{color:"#e8c547",fontWeight:700}}>{p.label}</span>
                      <span style={{color:"#666",margin:"0 6px"}}>·</span>
                      <span style={{color:"#888"}}>{bb.periods?.reduce((s,p)=>s+(p.kwh||0),0).toFixed(0)} קוט״ש</span>
                      {bb.periods?.length>1&&<span style={{color:"#6bc5f8",marginRight:4}}> · {bb.periods.length} תעריפים</span>}
                      <span style={{color:"#555",marginRight:4}}>· {bb.date}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <button onClick={()=>setElecUpload(true)} style={S.btn("#1a1a10","#e8c547")}>⚡ העלה / עדכן חשבון</button>
        </div>
      </Card>

      {/* Meter scan buttons */}
      <Card style={{marginBottom:16,background:"#0e1a2e",border:"1px solid #1e3a5a"}}>
        <div style={{fontWeight:700,color:"#6bc5f8",marginBottom:10,fontSize:14}}>📷 סריקת מונים מתמונה</div>
        <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
          <label style={{...S.lbl,marginBottom:0}}>תקופה
            <select value={meterScanPeriod} onChange={e=>setMeterScanPeriod(e.target.value)} style={{...S.sel,display:"block",marginTop:4}}>
              {BIMONTHLY_PERIODS.map(p=><option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </label>
          <button onClick={()=>setMeterScan("water")} style={{...S.btn("#0a2a3a","#6bc5f8"),display:"flex",alignItems:"center",gap:6}}>
            📷 סרוק מוני מים
          </button>
          <button onClick={()=>setMeterScan("electricity")} style={{...S.btn("#1a1a0a","#e8c547"),display:"flex",alignItems:"center",gap:6}}>
            📷 סרוק מוני חשמל
          </button>
          <span style={{color:"#444",fontSize:11}}>העלה תמונה עם מספר מונים — הקריאות יוזנו אוטומטית לפי מספר מונה</span>
        </div>
      </Card>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:14,marginBottom:20}}>
        <StatCard label="חשבונות פתוחים" value={unpaidCount} icon="⏳" color="#e85c4a" sub="לא שולמו"/>
        <StatCard label="שולמו" value={rows.filter(r=>r.b.paid).length} icon="✅" color="#4caf88"/>
        <StatCard label="סה״כ חוב פתוח" value={fmt(unpaidTotal)} icon="💸" color="#e85c4a"/>
      </div>
      </>
      }
      {unitFilter==null&&<>
      <TariffEditor tariffs={tariffs} save={save} unitsCount={units.filter(u=>!u.vacant).length}/>
      <Card style={{marginBottom:16}}>
        <div style={{fontWeight:700,color:"#e8c547",marginBottom:12}}>➕ הוסף חשבון חדש</div>
        <AddBillForm units={units} bills={bills} onAdd={addBill}/>
      </Card>
      </>
      }
      <div style={{display:"flex",gap:10,marginBottom:14,flexWrap:"wrap"}}>
        <select value={filterUnit} onChange={e=>setFilterUnit(e.target.value)} style={S.sel}>
          <option value="all">כל היחידות</option>
          {units.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <div style={{display:"flex",gap:6}}>
          {[["all","הכל"],["unpaid","לא שולם"],["paid","שולם"]].map(([v,l])=>(
            <button key={v} onClick={()=>setFilterPaid(v)} style={S.btn(filterPaid===v?"#e8c547":"#1e1e3a",filterPaid===v?"#1a1a2e":"#888")}>{l}</button>
          ))}
        </div>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        {visible.length===0&&<div style={{color:"#555",textAlign:"center",padding:40}}>אין חשבונות להצגה</div>}
        {visible.map(row=>{
          const{k,unit,month,b,calc}=row;
          return(
            <Card key={k} style={{borderRight:`4px solid ${b.paid?"#4caf88":"#e85c4a"}`}}>
              {editKey===k?(
                <div>
                  <div style={{fontWeight:700,color:"#e8c547",marginBottom:14}}>✏️ עריכת קריאות — {unit.name} · {periodLabel(month)}</div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))",gap:12}}>
                    {Object.entries(tariffs).map(([tk,t])=>(
                      <div key={tk} style={{background:"#0e0e20",borderRadius:8,padding:12}}>
                        <div style={{fontWeight:700,color:"#aaa",marginBottom:8,fontSize:13}}>{t.name} ({t.unit})</div>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                          <label style={S.lbl}>קריאה קודמת<input type="number" value={editForm[tk]?.prev} onChange={e=>setEditForm(f=>({...f,[tk]:{...f[tk],prev:e.target.value}}))} style={S.inp}/></label>
                          <label style={S.lbl}>קריאה נוכחית<input type="number" value={editForm[tk]?.curr} onChange={e=>setEditForm(f=>({...f,[tk]:{...f[tk],curr:e.target.value}}))} style={S.inp}/></label>
                        </div>
                      </div>
                    ))}
                  </div>
                  {editError&&<div style={{color:"#e85c4a",fontSize:12,padding:"6px 10px",background:"#2a0a0a",borderRadius:6,marginBottom:8}}>⚠️ {editError}</div>}
                  <div style={{display:"flex",gap:8,marginTop:14}}>
                    <button onClick={saveEdit} style={S.btn("#4caf88","#fff")}>💾 שמור</button>
                    <button onClick={()=>setEditKey(null)} style={S.btn("#444","#aaa")}>ביטול</button>
                  </div>
                </div>
              ):(
                <div>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12,flexWrap:"wrap",gap:8}}>
                    <div>
                      <span style={{fontWeight:800,fontSize:16,color:"#e8c547"}}>{unit.name}</span>
                      <span style={{color:"#555",margin:"0 8px"}}>·</span>
                      <span style={{color:"#aaa",fontSize:14}}>{currentTenant(unit).name}</span>
                      <span style={{color:"#555",margin:"0 8px"}}>·</span>
                      <span style={{color:"#6bc5f8",fontSize:14}}>{periodLabel(month)}</span>
                    </div>
                    <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
                      {b.paid
                        ? <Badge color="#4caf88">✓ שולם{b.paidDate?` · ${b.paidDate}`:""}</Badge>
                        : (() => {
                            const pItems = b.payments ? Object.entries(b.payments).filter(([,v])=>v?.paid) : [];
                            return pItems.length > 0
                              ? <Badge color="#a78bfa">💳 חלקי ({pItems.length}/{Object.keys(getPayments(b, calc.lines, unit.rent)).length})</Badge>
                              : <Badge color="#e85c4a">⏳ ממתין לתשלום</Badge>;
                          })()
                      }
                      {b.locked&&<Badge color="#e8c547">🔒 נעול</Badge>}
                      {b.locked&&b.lockedAmount!=null&&<span style={{fontSize:11,color:"#e8c547",fontWeight:700}}>{fmt(b.lockedAmount)}</span>}
                    </div>
                  </div>
                  <div style={{display:"flex",gap:10,marginBottom:14,flexWrap:"wrap"}}>
                    {Object.entries(calc.lines).map(([tk,l])=>(
                      <div key={tk} style={{background:"#0e0e20",borderRadius:8,padding:"8px 14px",fontSize:12,minWidth:100}}>
                        <div style={{color:"#666",marginBottom:2}}>{l.name}</div>
                        {l.tiered ? (
                          <div>
                            {l.noWaterDiscount&&<div style={{color:"#e85c4a",fontSize:10,marginBottom:2}}>⚠️ ללא הנחת מים</div>}
                            {!l.noWaterDiscount&&<div style={{color:"#4caf88",fontSize:11}}>מוזל: {l.lowUsage.toFixed(1)} {l.unit}</div>}
                            {l.highUsage>0&&<div style={{color:"#e85c4a",fontSize:11}}>יקר: {l.highUsage.toFixed(1)} {l.unit}</div>}
                            {!l.noWaterDiscount&&<div style={{color:"#888",fontSize:10}}>מכסה: {l.persons}×{l.perPersonQty}={l.allowance.toFixed(0)} מ״ק</div>}
                          </div>
                        ):tk==="electricity"&&l.periods?.length>1?(
                          <div>
                            {l.periods.map((p,i)=><div key={i} style={{color:"#ccc",fontSize:10}}>{p.kwh} קוט״ש × {p.price}₪</div>)}
                            {l.fixedShare>0&&<div style={{color:"#888",fontSize:10}}>קבוע: {fmt(l.fixedShare)}</div>}
                          </div>
                        ):(
                          <div>
                            <div style={{color:"#ccc"}}>{l.usage} {l.unit}</div>
                            {l.fixedShare>0&&<div style={{color:"#888",fontSize:10}}>+קבוע: {fmt(l.fixedShare)}</div>}
                          </div>
                        )}
                        {b.readings?.[tk]?.source&&<div style={{color:"#3a3a5a",fontSize:9,marginTop:2}}>{b.readings[tk].source==="scan"?"📷":b.readings[tk].source==="manual"?"✏️":"📤"} {b.readings[tk].lastUpdated||""}</div>}
                        <div style={{color:"#e8c547",fontWeight:700}}>{fmt(l.amount)}</div>
                      </div>
                    ))}
                    <div style={{background:"#0e0e20",borderRadius:8,padding:"8px 14px",fontSize:12,minWidth:100}}>
                      <div style={{color:"#666",marginBottom:2}}>שכירות</div>
                      <div style={{color:"#ccc"}}>&nbsp;</div>
                      <div style={{color:"#e8c547",fontWeight:700}}>{fmt(unit.rent)}</div>
                    </div>
                    <div style={{background:"#1a1a2e",border:"1px solid #e8c54766",borderRadius:8,padding:"8px 14px",fontSize:12,minWidth:120}}>
                      <div style={{color:"#888",marginBottom:2}}>סה״כ לתשלום</div>
                      {(()=>{
                        const fullTotal = b.locked&&b.lockedAmount!=null ? b.lockedAmount : unit.rent+calc.total;
                        // Sum already paid amounts from payments object
                        const paidSoFar = b.payments
                          ? Object.values(b.payments).reduce((s,p)=>s+(p?.paid&&p?.amount?+p.amount:0),0)
                          : 0;
                        const remaining = Math.max(0, fullTotal - paidSoFar);
                        return b.paid
                          ? <div style={{color:"#4caf88",fontWeight:900,fontSize:16}}>✓ שולם במלואו</div>
                          : paidSoFar>0
                            ? <>
                                <div style={{color:"#e8c547",fontWeight:900,fontSize:18}}>{fmt(remaining)}</div>
                                <div style={{color:"#a78bfa",fontSize:10,marginTop:2}}>שולם: {fmt(paidSoFar)} · מתוך {fmt(fullTotal)}</div>
                              </>
                            : <div style={{color:"#e8c547",fontWeight:900,fontSize:20}}>{fmt(fullTotal)}</div>;
                      })()}
                    </div>
                  </div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    <button onClick={()=>setPaymentModal({k,unit,month,b,calc})} style={{...S.btn("#1a2a3a","#4caf88"),fontSize:12}}>💳 תשלומים</button>
                    {b.paid&&<button onClick={()=>togglePaid(k)} style={{...S.btn("#2a1a1a","#e85c4a"),fontSize:11}}>↩ בטל הכל</button>}
                    {!b.paid&&<button onClick={()=>{setPartialKey(k);setPartialAmount(b.partialAmount||"");}} style={{...S.btn("#1a1a3a","#a78bfa"),fontSize:12}}>💵 תשלום חלקי</button>}
                    <button onClick={()=>save(d=>({...d,bills:{...d.bills,[k]:{...d.bills[k],noWaterDiscount:!d.bills[k].noWaterDiscount}}}))} style={{...S.btn(b.noWaterDiscount?"#2a1a0a":"#0e1a2e",b.noWaterDiscount?"#e85c4a":"#6bc5f8"),fontSize:12}} title="מים מוזלים / ללא הנחה">{b.noWaterDiscount?"💧 ללא הנחת מים":"💧 מים מוזלים"}</button>
                    <button onClick={()=>startEdit(row)} style={{...S.btn(b.locked?"#181818":"#1e1e3a",b.locked?"#444":"#888"),cursor:b.locked?"not-allowed":"pointer"}} title={b.locked?"נעול — בטל תשלום כדי לערוך":""}>✏️ עריכת קריאות{b.locked?" 🔒":""}</button>
                    <button onClick={()=>setDemand({unit,month})} style={S.btn("#1e2a3a","#6bc5f8")}>📄 דרישת תשלום</button>
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

function DashboardTab({data}){
  const{units,bills,transactions,tariffs}=data;
  const totalRent=units.reduce((s,u)=>s+u.rent,0);
  const totalIncome=transactions.filter(t=>t.type==="income").reduce((s,t)=>s+t.amount,0);
  const totalExpense=transactions.filter(t=>t.type==="expense").reduce((s,t)=>s+t.amount,0);
  const unpaid=Object.entries(bills).filter(([,b])=>!b.paid);
  return(
    <div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))",gap:14,marginBottom:22}}>
        <StatCard label="שכירות חודשית" value={fmt(totalRent)} sub={`${units.length} יחידות`} icon="🏠" color="#e8c547"/>
        <StatCard label="סה״כ הכנסות" value={fmt(totalIncome)} sub="כל הזמנים" icon="💰" color="#4caf88"/>
        <StatCard label="סה״כ הוצאות" value={fmt(totalExpense)} sub="כל הזמנים" icon="📤" color="#e85c4a"/>
        <StatCard label="חשבונות פתוחים" value={unpaid.length} sub="לא שולמו" icon="⏳" color={unpaid.length>0?"#e85c4a":"#4caf88"}/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        <Card>
          <div style={{fontWeight:700,marginBottom:14,color:"#e8c547"}}>⏳ חשבונות שלא שולמו</div>
          {unpaid.length===0&&<div style={{color:"#555",fontSize:13}}>✅ כל החשבונות שולמו</div>}
          {unpaid.map(([k,b])=>{
            const[uid,month]=k.split("_"),unit=units.find(u=>u.id===+uid);
            if(!unit)return null;
            const unit2=units.find(u=>u.id===+uid); const c=calcBill(b.readings,tariffs,unit2,units,(data.buildingBills||{})[month],data.bills,month,b.noWaterDiscount||false);
            return(
              <div key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:"1px solid #1e1e3a"}}>
                <div>
                  <div style={{fontWeight:600,color:"#ddd",fontSize:13}}>{unit.name} — {periodLabel(month)}</div>
                  <div style={{color:"#666",fontSize:11}}>{currentTenant(unit).name}</div>
                </div>
                <Badge color="#e85c4a">{fmt(unit.rent+c.total)}</Badge>
              </div>
            );
          })}
        </Card>
        <Card>
          <div style={{fontWeight:700,marginBottom:14,color:"#e8c547"}}>📝 תנועות אחרונות</div>
          {transactions.slice(-5).reverse().map(t=>(
            <div key={t.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid #1e1e3a"}}>
              <div>
                <div style={{fontSize:13,color:"#ccc"}}>{t.note}</div>
                <div style={{fontSize:11,color:"#555"}}>{t.date} · {t.category}</div>
              </div>
              <span style={{fontWeight:700,color:t.type==="income"?"#4caf88":"#e85c4a"}}>{t.type==="income"?"+":"-"}{fmt(t.amount)}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

// ─── FINANCE TAB ──────────────────────────────────────────────────────────────

function FinanceTab({data,save,readonly=false}){
  const{units,transactions}=data;
  const[form,setForm]=useState({date:new Date().toLocaleDateString("en-CA"),type:"income",category:"שכירות",unitId:"",amount:"",note:""});
  const[filter,setFilter]=useState("all");
  const totalIncome=transactions.filter(t=>t.type==="income").reduce((s,t)=>s+t.amount,0);
  const totalExpense=transactions.filter(t=>t.type==="expense").reduce((s,t)=>s+t.amount,0);
  const filtered=transactions.filter(t=>filter==="all"||t.type===filter).sort((a,b)=>b.date.localeCompare(a.date));
  const add=()=>{
    if(!form.amount||!form.note)return;
    const tx={...form,id:Date.now(),amount:parseFloat(form.amount),unitId:form.unitId?+form.unitId:null};
    save(d=>({...d,transactions:[...d.transactions,tx]}));
    setForm(f=>({...f,amount:"",note:""}));
  };
  const del=(id)=>save(d=>({...d,transactions:d.transactions.filter(t=>t.id!==id)}));
  return(
    <div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:14,marginBottom:20}}>
        <StatCard label="הכנסות" value={fmt(totalIncome)} icon="💰" color="#4caf88"/>
        <StatCard label="הוצאות" value={fmt(totalExpense)} icon="📤" color="#e85c4a"/>
        <StatCard label="מאזן" value={fmt(totalIncome-totalExpense)} icon="⚖️" color={totalIncome>=totalExpense?"#4caf88":"#e85c4a"}/>
      </div>
      {!readonly&&<Card style={{marginBottom:18}}>
        <div style={{fontWeight:700,color:"#e8c547",marginBottom:12}}>➕ הוסף תנועה</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:10}}>
          <label style={S.lbl}>תאריך<input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} style={S.inp}/></label>
          <label style={S.lbl}>סוג<select value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value}))} style={S.inp}><option value="income">הכנסה</option><option value="expense">הוצאה</option></select></label>
          <label style={S.lbl}>קטגוריה<select value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))} style={S.inp}>{["שכירות","חשבונות","תחזוקה","ביטוח","ארנונה","אחר"].map(c=><option key={c}>{c}</option>)}</select></label>
          <label style={S.lbl}>יחידה<select value={form.unitId} onChange={e=>setForm(f=>({...f,unitId:e.target.value}))} style={S.inp}><option value="">כללי</option>{units.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
          <label style={S.lbl}>סכום<input type="number" placeholder="0" value={form.amount} onChange={e=>setForm(f=>({...f,amount:e.target.value}))} style={S.inp}/></label>
          <label style={S.lbl}>הערה<input type="text" placeholder="תיאור..." value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))} style={S.inp}/></label>
        </div>
        <button onClick={add} style={{...S.btn("#e8c547","#1a1a2e"),marginTop:12}}>💾 הוסף</button>
      </Card>}
      <div style={{display:"flex",gap:8,marginBottom:12}}>
        {[["all","הכל"],["income","הכנסות"],["expense","הוצאות"]].map(([v,l])=>(
          <button key={v} onClick={()=>setFilter(v)} style={S.btn(filter===v?"#e8c547":"#2a2a4a",filter===v?"#1a1a2e":"#888")}>{l}</button>
        ))}
      </div>
      <Card style={{padding:0,overflow:"hidden"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
          <thead><tr style={{background:"#0e0e20"}}>
            {["תאריך","קטגוריה","יחידה","הערה","סכום",""].map(h=>(
              <th key={h} style={{padding:"10px 14px",textAlign:"right",color:"#666",fontWeight:600,borderBottom:"1px solid #1e1e3a"}}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {filtered.map(t=>(
              <tr key={t.id} style={{borderBottom:"1px solid #1a1a30"}}>
                <td style={{padding:"9px 14px",color:"#888"}}>{t.date}</td>
                <td style={{padding:"9px 14px"}}><Badge color={t.type==="income"?"#4caf88":"#e85c4a"}>{t.category}</Badge></td>
                <td style={{padding:"9px 14px",color:"#888"}}>{units.find(u=>u.id===t.unitId)?.name||"כללי"}</td>
                <td style={{padding:"9px 14px",color:"#ccc"}}>{t.note}</td>
                <td style={{padding:"9px 14px",fontWeight:700,color:t.type==="income"?"#4caf88":"#e85c4a"}}>{t.type==="income"?"+":"-"}{fmt(t.amount)}</td>
                <td style={{padding:"9px 14px"}}>{!readonly&&<button onClick={()=>del(t.id)} style={{background:"none",border:"none",cursor:"pointer",color:"#e85c4a",fontSize:16}}>🗑</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}


// ─── TENANTS MODAL ────────────────────────────────────────────────────────────

function TenantsModal({unit, onSave, onClose}){
  const [tenants, setTenants] = React.useState(
    unit.tenants?.length ? unit.tenants.map(t=>({...t}))
    : [{id:Date.now(), name:"", idNum:"", phone:"", email:"", from:"", to:"", active:true}]
  );
  const [showHistory, setShowHistory] = React.useState(false);

  const active   = tenants.filter(t=>t.active);
  const inactive = tenants.filter(t=>!t.active);

  const addTenant = () => setTenants(prev=>[...prev, {id:Date.now(), name:"", idNum:"", phone:"", email:"", from:new Date().toLocaleDateString("en-CA"), to:"", active:true}]);

  const update = (id, field, val) => setTenants(prev=>prev.map(t=>t.id===id?{...t,[field]:val}:t));

  const deactivate = (id) => setTenants(prev=>prev.map(t=>t.id===id?{...t,active:false,to:t.to||new Date().toLocaleDateString("en-CA")}:t));

  const remove = (id) => setTenants(prev=>prev.filter(t=>t.id!==id));

  const TenantForm = ({t}) => (
    <div style={{background:"#0e0e20",borderRadius:10,padding:14,marginBottom:10,border:`1px solid ${t.active?"#2a4a2a":"#2a2a4a"}`}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <div style={{color:t.active?"#4caf88":"#555",fontSize:12,fontWeight:700}}>
          {t.active?"👤 שוכר פעיל":"📁 שוכר לשעבר"}
        </div>
        <div style={{display:"flex",gap:6}}>
          {t.active&&active.length>1&&<button onClick={()=>deactivate(t.id)} style={{...S.btn("#1a2a1a","#e8c547"),fontSize:11}}>סיים שכירות</button>}
          {!t.active&&<button onClick={()=>remove(t.id)} style={{background:"none",border:"none",color:"#e85c4a",cursor:"pointer",fontSize:12}}>🗑</button>}
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
        <label style={S.lbl}>שם מלא
          <input value={t.name} onChange={e=>update(t.id,"name",e.target.value)} style={S.inp} placeholder="ישראל ישראלי"/>
        </label>
        <label style={S.lbl}>ת.ז.
          <input value={t.idNum||""} onChange={e=>update(t.id,"idNum",e.target.value)} style={S.inp} placeholder="000000000"/>
        </label>
        <label style={S.lbl}>טלפון
          <input value={t.phone||""} onChange={e=>update(t.id,"phone",e.target.value)} style={S.inp} placeholder="050-0000000" dir="ltr"/>
        </label>
        <label style={S.lbl}>מייל
          <input value={t.email||""} onChange={e=>update(t.id,"email",e.target.value)} style={S.inp} placeholder="name@email.com" dir="ltr"/>
        </label>
        <label style={S.lbl}>תאריך כניסה
          <input type="date" value={t.from||""} onChange={e=>update(t.id,"from",e.target.value)} style={S.inp}/>
        </label>
        {!t.active&&<label style={S.lbl}>תאריך יציאה
          <input type="date" value={t.to||""} onChange={e=>update(t.id,"to",e.target.value)} style={S.inp}/>
        </label>}
      </div>
    </div>
  );

  return(
    <div style={{position:"fixed",inset:0,background:"#000c",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{background:"#12122a",border:"1px solid #2a2a4a",borderRadius:16,padding:24,maxWidth:520,width:"95%",maxHeight:"90vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontWeight:800,fontSize:17,color:"#e8c547"}}>👥 שוכרים — {unit.name}</div>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#888",fontSize:22,cursor:"pointer"}}>✕</button>
        </div>

        {/* Active tenants */}
        {active.map(t=><TenantForm key={t.id} t={t}/>)}

        <button onClick={addTenant} style={{...S.btn("#1a2a3a","#6bc5f8"),width:"100%",marginBottom:16,fontSize:13}}>+ הוסף שוכר</button>

        {/* History */}
        {inactive.length>0&&(
          <>
            <button onClick={()=>setShowHistory(v=>!v)} style={{...S.btn("#1a1a2e","#555"),width:"100%",marginBottom:10,fontSize:12}}>
              📁 היסטוריית שוכרים ({inactive.length}) {showHistory?"▲":"▼"}
            </button>
            {showHistory&&inactive.map(t=><TenantForm key={t.id} t={t}/>)}
          </>
        )}

        <div style={{display:"flex",gap:10,marginTop:8}}>
          <button onClick={()=>onSave(tenants)} style={{...S.btn("#e8c547","#1a1a2e"),flex:1}}>💾 שמור</button>
          <button onClick={onClose} style={S.btn("#2a2a4a","#888")}>ביטול</button>
        </div>
      </div>
    </div>
  );
}

// ─── UNITS TAB ────────────────────────────────────────────────────────────────

function UnitsTab({data,save,readonly=false}){
  const [tenantsModal, setTenantsModal] = useState(null);

  const saveTenants = (tenants) => {
    save(d=>({...d, units:d.units.map(u=>u.id===tenantsModal.id?{...u,tenants}:u)}));
    setTenantsModal(null);
  };

  const{units}=data;
  const{confirm:confirmDlg, ConfirmModal}=useConfirm();
  const[editingUnit,setEditingUnit]=useState(null);   // unit id for basic edit
  const[unitForm,setUnitForm]=useState({});
  const[changingTenant,setChangingTenant]=useState(null); // unit id for tenant change
  const[newTenantForm,setNewTenantForm]=useState({name:"",phone:"",startDate:"",endDate:""});
  const[viewHistory,setViewHistory]=useState(null);   // unit id for history modal

  const startEditUnit=(u)=>{
    setEditingUnit(u.id);
    setUnitForm({name:u.name,rent:u.rent,persons:u.persons||1,waterMeterId:u.waterMeterId||"",electricMeterId:u.electricMeterId||""});
  };
  const saveUnit=()=>{
    save(d=>({...d,units:d.units.map(u=>u.id===editingUnit?{...u,...unitForm,rent:+unitForm.rent,persons:+unitForm.persons,arnonaAmount:+unitForm.arnonaAmount||0}:u)}));
    setEditingUnit(null);
  };

  const startChangeTenant=(u)=>{
    const cur=currentTenant(u);
    setChangingTenant(u.id);
    setNewTenantForm({name:"",phone:"",startDate:new Date().toLocaleDateString("en-CA"),endDate:""});
  };
  const saveTenantChange=()=>{
    if(!newTenantForm.name||!newTenantForm.startDate) return;
    save(d=>({...d,units:d.units.map(u=>{
      if(u.id!==changingTenant) return u;
      // Close current tenant — end date is one day before new tenant starts
      const prevEnd = newTenantForm.startDate
        ? new Date(new Date(newTenantForm.startDate).getTime()-864e5).toLocaleDateString("en-CA")
        : newTenantForm.startDate;
      const history=(u.tenantHistory||[]).map(t=>
        !t.endDate ? {...t, endDate:prevEnd} : t
      );
      // Add new tenant
      history.push({name:newTenantForm.name,phone:newTenantForm.phone,startDate:newTenantForm.startDate,endDate:null});
      return {...u,tenantHistory:history};
    })}));
    setChangingTenant(null);
  };

  const deleteUnit=async(id)=>{
    const ok=await confirmDlg('האם אתה בטוח שברצונך למחוק את היחידה? כל החשבונות הקשורים אליה יימחקו ולא יחזרו.');
    if(!ok) return;
    save(d=>{
      const newBills={};
      for(const [k,v] of Object.entries(d.bills))
        if(!k.startsWith(`${id}_`)) newBills[k]=v;
      return {...d, units:d.units.filter(u=>u.id!==id), bills:newBills};
    });
  };

  const addUnit=()=>{
    const id=Date.now();
    save(d=>({...d,units:[...d.units,{id,name:`דירה ${d.units.length+1}`,rent:0,persons:1,vacant:false,arnonaAmount:0,waterMeterId:"",electricMeterId:"",
      tenantHistory:[{name:"",phone:"",startDate:new Date().toLocaleDateString("en-CA"),endDate:null}]
    }]}));
  };

  return(
    <div>
      {ConfirmModal}
      {/* Tenant change modal */}
      {changingTenant&&(()=>{
        const u=units.find(x=>x.id===changingTenant);
        const cur=currentTenant(u);
        return(
          <div style={{position:"fixed",inset:0,background:"#000c",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <div style={{background:"#12122a",border:"1px solid #2a2a4a",borderRadius:16,padding:24,maxWidth:440,width:"95%"}}>
              <div style={{fontWeight:800,fontSize:17,color:"#e8c547",marginBottom:16}}>🔄 החלפת דייר — {u.name}</div>
              <div style={{background:"#0e0e20",borderRadius:8,padding:12,marginBottom:16,fontSize:13}}>
                <div style={{color:"#666",marginBottom:4}}>דייר יוצא:</div>
                <div style={{color:"#ccc"}}>{cur.name}</div>
                <div style={{color:"#555",fontSize:12}}>{cur.phone}</div>
              </div>
              <div style={{fontWeight:700,color:"#aaa",fontSize:13,marginBottom:10}}>דייר נכנס:</div>
              <label style={S.lbl}>שם מלא<input value={newTenantForm.name} onChange={e=>setNewTenantForm(f=>({...f,name:e.target.value}))} style={S.inp} placeholder="שם הדייר החדש"/></label>
              <label style={S.lbl}>טלפון<input value={newTenantForm.phone} onChange={e=>setNewTenantForm(f=>({...f,phone:e.target.value}))} style={S.inp}/></label>
              <label style={S.lbl}>תאריך כניסה<input type="date" value={newTenantForm.startDate} onChange={e=>setNewTenantForm(f=>({...f,startDate:e.target.value}))} style={S.inp}/></label>
              <div style={{color:"#555",fontSize:11,marginTop:4,marginBottom:14}}>תאריך זה יהפוך גם לתאריך סיום של הדייר היוצא</div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={saveTenantChange} disabled={!newTenantForm.name||!newTenantForm.startDate} style={{...S.btn("#4caf88","#fff"),flex:1,opacity:(!newTenantForm.name||!newTenantForm.startDate)?0.4:1}}>✓ שמור החלפה</button>
                <button onClick={()=>setChangingTenant(null)} style={S.btn("#555","#fff")}>ביטול</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* History modal — with inline editing */}
      {viewHistory&&(()=>{
        const u=units.find(x=>x.id===viewHistory);
        const saveHistory=(newHistory)=>{
          save(d=>({...d,units:d.units.map(x=>x.id===u.id?{...x,tenantHistory:newHistory}:x)}));
        };
        const updateTenant=(idx,field,val)=>{
          const h=[...(u.tenantHistory||[])];
          h[idx]={...h[idx],[field]:val||null};
          saveHistory(h);
        };
        const deleteTenant=async(idx)=>{
          const ok=await confirmDlg('למחוק את רשומת הדייר הזה?'); if(!ok) return;
          const h=(u.tenantHistory||[]).filter((_,i)=>i!==idx);
          saveHistory(h);
        };
        const addTenant=()=>{
          const h=[...(u.tenantHistory||[]),{name:'',phone:'',startDate:new Date().toLocaleDateString("en-CA"),endDate:null}];
          saveHistory(h);
        };
        const history=[...(u.tenantHistory||[])].reverse();
        const origIdxOf=(t)=>(u.tenantHistory||[]).indexOf(t);
        return(
          <div style={{position:"fixed",inset:0,background:"#000c",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <div style={{background:"#12122a",border:"1px solid #2a2a4a",borderRadius:16,padding:24,maxWidth:520,width:"95%",maxHeight:"88vh",overflowY:"auto"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
                <div style={{fontWeight:800,fontSize:17,color:"#e8c547"}}>📋 היסטוריית דיירים — {u.name}</div>
                <button onClick={()=>setViewHistory(null)} style={{background:"none",border:"none",color:"#888",fontSize:22,cursor:"pointer"}}>✕</button>
              </div>
              {history.map((t)=>{
                const idx=origIdxOf(t);
                const isCurrent=!t.endDate;
                return(
                  <div key={idx} style={{background:"#0e0e20",borderRadius:10,padding:14,marginBottom:10,borderRight:`3px solid ${isCurrent?"#4caf88":"#333"}`}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                      {isCurrent&&<span style={{fontSize:11,color:"#4caf88",border:"1px solid #4caf8844",borderRadius:10,padding:"1px 8px"}}>נוכחי</span>}
                      {!isCurrent&&<span style={{fontSize:11,color:"#666"}}>לשעבר</span>}
                      <button onClick={()=>deleteTenant(idx)} style={{background:"none",border:"none",cursor:"pointer",color:"#e85c4a",fontSize:15,padding:"0 4px"}}>🗑</button>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                      <label style={S.lbl}>שם
                        <input value={t.name||''} onChange={e=>updateTenant(idx,'name',e.target.value)} style={S.inp}/>
                      </label>
                      <label style={S.lbl}>טלפון
                        <input value={t.phone||''} onChange={e=>updateTenant(idx,'phone',e.target.value)} style={S.inp}/>
                      </label>
                      <label style={S.lbl}>תאריך כניסה
                        <input type="date" value={t.startDate||''} onChange={e=>updateTenant(idx,'startDate',e.target.value)} style={S.inp}/>
                      </label>
                      <label style={S.lbl}>תאריך יציאה
                        <input type="date" value={t.endDate||''} onChange={e=>updateTenant(idx,'endDate',e.target.value||null)} style={S.inp}/>
                      </label>
                    </div>
                  </div>
                );
              })}
              <button onClick={addTenant} style={{...S.btn("#1a1a2e","#6bc5f8"),width:"100%",marginTop:4}}>+ הוסף דייר</button>
            </div>
          </div>
        );
      })()}

      <div style={{display:"flex",justifyContent:"space-between",marginBottom:16}}>
        <div style={{color:"#888"}}>{units.length} יחידות דיור</div>
{!readonly&&<button onClick={addUnit} style={S.btn("#e8c547","#1a1a2e")}>+ הוסף יחידה</button>}
      </div>
      {tenantsModal&&<TenantsModal unit={tenantsModal} onSave={saveTenants} onClose={()=>setTenantsModal(null)}/>}

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(300px,1fr))",gap:16}}>
        {units.map(u=>{
          const cur=currentTenant(u);
          return(
            <Card key={u.id}>
              {editingUnit===u.id?(
                <div>
                  <div style={{fontWeight:700,color:"#e8c547",marginBottom:12}}>✏️ עריכת יחידה</div>
                  <label style={S.lbl}>שם יחידה<input value={unitForm.name} onChange={e=>setUnitForm(p=>({...p,name:e.target.value}))} style={S.inp}/></label>
                  <label style={S.lbl}>שכירות (₪)<input type="number" value={unitForm.rent} onChange={e=>setUnitForm(p=>({...p,rent:e.target.value}))} style={S.inp}/></label>
                  <label style={S.lbl}>מספר נפשות<input type="number" min="1" max="20" value={unitForm.persons} onChange={e=>setUnitForm(p=>({...p,persons:e.target.value}))} style={S.inp}/></label>
                  <label style={S.lbl}>ארנונה + מיסי מושב (₪/חודש) — 0 אם כלול בשכירות<input type="number" min="0" value={unitForm.arnonaAmount||0} onChange={e=>setUnitForm(p=>({...p,arnonaAmount:e.target.value}))} style={S.inp}/></label>
                  <label style={S.lbl}>💧 מספר מונה מים<input value={unitForm.waterMeterId} onChange={e=>setUnitForm(p=>({...p,waterMeterId:e.target.value}))} style={S.inp} placeholder="12345678"/></label>
                  <label style={S.lbl}>⚡ מספר מונה חשמל<input value={unitForm.electricMeterId} onChange={e=>setUnitForm(p=>({...p,electricMeterId:e.target.value}))} style={S.inp} placeholder="87654321"/></label>
                  <div style={{display:"flex",gap:8,marginTop:12}}>
                    <button onClick={saveUnit} style={S.btn("#4caf88","#fff")}>שמור</button>
                    <button onClick={()=>setEditingUnit(null)} style={S.btn("#555","#fff")}>ביטול</button>
                  </div>
                </div>
              ):(
                <div>
                  {/* Header */}
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                    <div style={{fontWeight:800,fontSize:18,color:"#e8c547"}}>{u.name}</div>
                    <button onClick={()=>setTenantsModal(u)} style={{background:"none",border:"1px solid #2a4a2a",color:"#4caf88",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:12}}>👥 שוכרים</button>
                  {!readonly&&<button onClick={()=>startEditUnit(u)} style={{background:"none",border:"1px solid #2a2a4a",color:"#888",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:12}}>✏️</button>}
                  </div>

                  {/* Current tenant */}
                  <div style={{background:"#0e1a0e",border:"1px solid #1a3a1a",borderRadius:8,padding:10,marginBottom:10}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                      <span style={{fontSize:11,color:"#4caf88",fontWeight:700}}>דייר נוכחי</span>
                      <span style={{fontSize:10,color:"#555"}}>{cur.startDate} →</span>
                    </div>
                    <div style={{fontWeight:700,color:"#ddd",fontSize:14}}>{cur.name||"ללא שוכר"}</div>
                    <div style={{fontSize:12,color:"#888"}}>📞 {cur.phone||"—"}</div>
                  </div>

                  {/* Meta */}
                  {u.vacant&&<div style={{background:"#2a1a0a",border:"1px solid #e8c54744",borderRadius:6,padding:"4px 10px",fontSize:11,color:"#e8c547",marginBottom:8,display:"inline-block"}}>🚧 דירה ריקה / שיפוץ</div>}
                  <div style={{fontSize:12,color:"#666",marginBottom:6}}>
                    👥 {u.persons||1} נפשות
                    {u.waterMeterId&&<span style={{margin:"0 8px"}}>💧 {u.waterMeterId}</span>}
                    {u.electricMeterId&&<span>⚡ {u.electricMeterId}</span>}
                  </div>

                  {/* Rent */}
                  <div style={{borderTop:"1px solid #1e1e3a",paddingTop:10,marginBottom:12}}>
                    <div style={{display:"flex",justifyContent:"space-between"}}>
                      <span style={{color:"#666",fontSize:13}}>שכירות חודשית</span>
                      <span style={{fontWeight:800,color:"#4caf88"}}>{fmt(u.rent)}</span>
                    </div>
                    {(u.arnonaAmount||0)>0&&<div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
                      <span style={{color:"#666",fontSize:12}}>ארנונה + מיסי מושב</span>
                      <span style={{color:"#e8c547",fontSize:12,fontWeight:700}}>{fmt(u.arnonaAmount)}</span>
                    </div>}
                  </div>

                  {/* Actions — hidden for viewers */}
                  {!readonly&&<div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"space-between"}}>
                    <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                      <button onClick={()=>startChangeTenant(u)} style={{...S.btn("#1a2a1a","#4caf88"),fontSize:12}}>🔄 החלף דייר</button>
                      <button onClick={()=>setViewHistory(u.id)} style={{...S.btn("#1a1a2e","#6bc5f8"),fontSize:12}}>📋 היסטוריה ({(u.tenantHistory||[]).length})</button>
                    </div>
                    <button onClick={()=>save(d=>({...d,units:d.units.map(x=>x.id===u.id?{...x,vacant:!x.vacant}:x)}))} style={{...S.btn(u.vacant?"#2a1a0a":"#1a1a0a",u.vacant?"#e8c547":"#666"),fontSize:12}}>{u.vacant?"🟢 סמן כמאוכלסת":"🚧 ריקה/שיפוץ"}</button>
                    <button onClick={()=>deleteUnit(u.id)} style={{...S.btn("#2a0a0a","#e85c4a"),fontSize:12}}>🗑 מחק</button>
                  </div>}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}



// ─── EXCEL EXPORT / IMPORT ───────────────────────────────────────────────────

function ExcelPanel({data, save}){
  const {units, bills, tariffs, transactions} = data;
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);

  // ── EXPORT (split by type) ───────────────────────────────────────────────────────────
  const _td = new Date().toLocaleDateString("en-CA");

  const exportBills = () => {
    const wb = XLSX.utils.book_new();
    const rows = [["יחידה", "תקופה", "שוכר", "טלפון", "שכירות", "מים קודם", "מים נוכחי", "מים צריכה", "מים סכום", "חשמל קודם", "חשמל נוכחי", "חשמל צריכה", "חשמל סכום", "ביוב קודם", "ביוב נוכחי", "ביוב צריכה", "ביוב סכום", "סה״כ שירותים", "סה״כ לתשלום", "שולם", "תאריך תשלום", "הערות"]];
    for(const [k,b] of Object.entries(bills).sort()){
      const [uid,period]=k.split('_');
      const unit=units.find(u=>u.id===+uid); if(!unit) continue;
      const tenant=tenantAtPeriod(unit,period);
      const calc=calcBill(b.readings,tariffs,unit,units,(data.buildingBills||{})[period],data.bills,period,b.noWaterDiscount||false);
      const w=b.readings?.water||{},el=b.readings?.electricity||{},sv=b.readings?.sewage||{};
      const finalTotal = b.locked && b.lockedAmount!=null ? b.lockedAmount : unit.rent+calc.total;
      rows.push([unit.name,periodLabel(period),tenant.name,tenant.phone,unit.rent,
        w.prev??0,w.curr??0,(w.curr??0)-(w.prev??0),calc.lines.water?.amount??0,
        el.prev??0,el.curr??0,(el.curr??0)-(el.prev??0),calc.lines.electricity?.amount??0,
        sv.prev??0,sv.curr??0,(sv.curr??0)-(sv.prev??0),calc.lines.sewage?.amount??0,
        calc.total,finalTotal,b.paid?'כן':'לא',b.paidDate||'',b.locked?'🔒':'']);
    }
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),'חשבונות');
    XLSX.writeFile(wb,`חשבונות_${_td}.xlsx`);
  };

  const exportUnits = () => {
    const wb = XLSX.utils.book_new();
    const rows=[["שם יחידה", "שכירות", "נפשות", "מונה מים", "מונה חשמל", "שם דייר", "טלפון", "תאריך כניסה", "תאריך יציאה", "סטטוס"]];
    for(const u of units)
      for(const t of (u.tenantHistory||[]))
        rows.push([u.name,u.rent,u.persons||1,u.waterMeterId||'',u.electricMeterId||'',
          t.name,t.phone,t.startDate,t.endDate||'',t.endDate?'יצא':'נוכחי']);
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),'יחידות ודיירים');
    XLSX.writeFile(wb,`יחידות_ודיירים_${_td}.xlsx`);
  };

  const exportTransactions = () => {
    const wb = XLSX.utils.book_new();
    const rows=[["תאריך", "סוג", "קטגוריה", "יחידה", "סכום", "הערה"]];
    for(const t of [...transactions].sort((a,b)=>a.date.localeCompare(b.date))){
      const uName=units.find(u=>u.id===t.unitId)?.name||'כללי';
      rows.push([t.date,t.type==='income'?'הכנסה':'הוצאה',t.category,uName,t.amount,t.note]);
    }
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),'תנועות כספיות');
    XLSX.writeFile(wb,`תנועות_${_td}.xlsx`);
  };

  // ── IMPORT ────────────────────────────────────────────────────────────────
  const importFromExcel = async(e) => {
    const file = e.target.files?.[0];
    if(!file) return;
    setImporting(true); setImportResult(null);

    const buf = await file.arrayBuffer();
    const wb  = XLSX.read(buf);
    let imported = {bills:0, units:0, transactions:0, errors:[]};

    try {
      // Import bills
      const ws1 = wb.Sheets["חשבונות"];
      if(ws1){
        const rows = XLSX.utils.sheet_to_json(ws1, {header:1}).slice(1);
        const newBills = {...bills};
        for(const row of rows){
          if(!row[0]||!row[1]) continue;
          const unitName=String(row[0]).trim(), period=String(row[1]).trim();
          const unit = units.find(u=>u.name===unitName);
          if(!unit){ imported.errors.push(`יחידה לא נמצאה: ${unitName}`); continue; }
          // Find period key (first month)
          const periodKey = BIMONTHLY_PERIODS.find(p=>p.label===period||p.label.replace("–","-")===period)?.key
                         || ALL_MONTHS.find(m=>MONTH_LABELS[m]===period)
                         || period.slice(0,7);
          const k = bKey(unit.id, periodKey);
          newBills[k] = {
            paid: String(row[19]).trim()==="כן",
            paidDate: row[20]||null,
            readings:{
              water:      {prev:+row[5]||0, curr:+row[6]||0},
              electricity:{prev:+row[9]||0, curr:+row[10]||0},
              sewage:     {prev:+row[13]||0,curr:+row[14]||0},
            }
          };
          imported.bills++;
        }
        save(d=>({...d, bills:newBills}));
      }

      // Import units/tenants
      const ws2 = wb.Sheets["יחידות ודיירים"];
      if(ws2){
        const rows = XLSX.utils.sheet_to_json(ws2, {header:1}).slice(1);
        const unitMap = {};
        for(const row of rows){
          if(!row[0]) continue;
          const name=String(row[0]).trim();
          if(!unitMap[name]) unitMap[name]={name,rent:+row[1]||0,persons:+row[2]||1,waterMeterId:String(row[3]||""),electricMeterId:String(row[4]||""),tenantHistory:[]};
          unitMap[name].tenantHistory.push({name:String(row[5]||""),phone:String(row[6]||""),startDate:String(row[7]||""),endDate:row[8]?String(row[8]):null});
          imported.units++;
        }
        const newUnits = Object.values(unitMap).map((u,i)=>({...u,id:units.find(x=>x.name===u.name)?.id||(Date.now()+i)}));
        if(newUnits.length>0) save(d=>({...d, units:newUnits}));
      }

      // Import transactions
      const ws3 = wb.Sheets["תנועות כספיות"];
      if(ws3){
        const rows = XLSX.utils.sheet_to_json(ws3, {header:1}).slice(1);
        const newTx = [];
        for(const row of rows){
          if(!row[0]||!row[4]) continue;
          const unitName=String(row[3]||"כללי").trim();
          const unit = units.find(u=>u.name===unitName);
          newTx.push({id:Date.now()+Math.random(),date:String(row[0]).slice(0,10),type:row[1]==="הכנסה"?"income":"expense",category:String(row[2]||"אחר"),unitId:unit?.id||null,amount:+row[4]||0,note:String(row[5]||"")});
          imported.transactions++;
        }
        if(newTx.length>0) save(d=>({...d, transactions:[...d.transactions.filter(t=>!newTx.find(n=>n.date===t.date&&n.note===t.note&&n.amount===t.amount)), ...newTx]}));
      }

      setImportResult({...imported, ok:true});
    } catch(err){
      setImportResult({ok:false, error:String(err)});
    }
    setImporting(false);
    e.target.value="";
  };

  return(
    <Card>
      <div style={{fontWeight:700,color:"#e8c547",marginBottom:16,fontSize:15}}>📊 ייצוא / ייבוא Excel</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        {/* Export - 3 separate */}
        <div style={{background:"#0e0e20",borderRadius:10,padding:16}}>
          <div style={{fontWeight:700,color:"#4caf88",marginBottom:12}}>📤 ייצוא לאקסל</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <button onClick={exportBills} style={{...S.btn("#1a3a1a","#4caf88"),textAlign:"right",display:"flex",alignItems:"center",gap:8}}>
              <span>💧⚡</span><span>חשבונות שירותים</span>
            </button>
            <button onClick={exportUnits} style={{...S.btn("#1a1a3a","#6bc5f8"),textAlign:"right",display:"flex",alignItems:"center",gap:8}}>
              <span>🏠</span><span>יחידות ודיירים</span>
            </button>
            <button onClick={exportTransactions} style={{...S.btn("#2a1a0a","#e8c547"),textAlign:"right",display:"flex",alignItems:"center",gap:8}}>
              <span>💰</span><span>תנועות כספיות</span>
            </button>
          </div>
        </div>
        {/* Import */}
        <div style={{background:"#0e0e20",borderRadius:10,padding:16}}>
          <div style={{fontWeight:700,color:"#6bc5f8",marginBottom:8}}>📥 ייבוא מאקסל</div>
          <div style={{color:"#666",fontSize:12,marginBottom:12,lineHeight:1.6}}>
            קולט נתונים מקובץ xlsx בפורמט זהה.<br/>
            מיזוג עם הנתונים הקיימים.
          </div>
          <label style={{display:"block",textAlign:"center",padding:"10px",background:"#1a1a2e",border:"2px dashed #2a2a4a",borderRadius:8,cursor:"pointer",fontSize:13,color:"#6bc5f8"}}>
            {importing ? "⏳ מייבא…" : "⬆️ בחר קובץ Excel"}
            <input type="file" accept=".xlsx,.xls" onChange={importFromExcel} style={{display:"none"}}/>
          </label>
        </div>
      </div>
      {importResult&&(
        <div style={{marginTop:14,padding:"10px 14px",borderRadius:8,background:importResult.ok?"#0a2a0a":"#2a0a0a",fontSize:13}}>
          {importResult.ok ? (
            <>
              <div style={{color:"#4caf88",fontWeight:700,marginBottom:4}}>✓ ייבוא הושלם</div>
              <div style={{color:"#888"}}>חשבונות: {importResult.bills} · יחידות/דיירים: {importResult.units} · תנועות: {importResult.transactions}</div>
              {importResult.errors?.length>0&&<div style={{color:"#e85c4a",marginTop:6}}>⚠️ {importResult.errors.join(" · ")}</div>}
            </>
          ):(
            <div style={{color:"#e85c4a"}}>❌ שגיאה בייבוא: {importResult.error}</div>
          )}
        </div>
      )}
    </Card>
  );
}

// ─── REPORTS TAB ─────────────────────────────────────────────────────────────

function ReportsTab({data, unitFilter=null}){
  const {units, bills, tariffs} = data;
  const [selUnit, setSelUnit] = useState("all");
  const [selTenant, setSelTenant] = useState("current"); // "current" | tenant startDate key

  // Build report rows: one per bill, enriched with tenant info
  const rows = [];
  for(const unit of units){
    const history = unit.tenantHistory || [];
    for(const [k, b] of Object.entries(bills)){
      if(!k.startsWith(`${unit.id}_`)) continue;
      const periodKey = k.split("_")[1];
      const periodDate = periodKey + "-01";
      // Find tenant for this period
      const tenant = history.find(t => t.startDate <= periodDate && (!t.endDate || t.endDate >= periodDate))
                  || history[history.length-1]
                  || {name:"לא ידוע", phone:""};
      const calc = calcBill(b.readings, tariffs, unit, units, (data.buildingBills||{})[periodKey], data.bills, periodKey, b.noWaterDiscount||false);
      rows.push({k, unit, periodKey, b, calc, tenant});
    }
  }
  rows.sort((a,b)=>b.periodKey.localeCompare(a.periodKey));

  // Tenant options for selected unit
  const selectedUnit = units.find(u=>u.id===+selUnit);
  const tenantOptions = selectedUnit
    ? (selectedUnit.tenantHistory||[]).map(t=>({key:t.startDate, label:`${t.name} (${t.startDate}${t.endDate?" → "+t.endDate:" → כיום"})`}))
    : [];

  const filtered = rows
    .filter(r => selUnit==="all" || r.unit.id===+selUnit)
    .filter(r => {
      if(selTenant==="all" || !selectedUnit) return true;
      if(selTenant==="current"){
        const cur = currentTenant(selectedUnit);
        return r.tenant.startDate === cur.startDate;
      }
      return r.tenant.startDate === selTenant;
    });

  // Summary totals
  const totalDue  = filtered.reduce((s,r)=>s+r.unit.rent+r.calc.total, 0);
  const totalPaid = filtered.filter(r=>r.b.paid).reduce((s,r)=>s+r.unit.rent+r.calc.total, 0);
  const totalOwed = filtered.filter(r=>!r.b.paid).reduce((s,r)=>s+r.unit.rent+r.calc.total, 0);

  const printReport = () => {
    const today = new Date().toLocaleDateString("he-IL");
    const unitTitle = selUnit==="all" ? "כל היחידות" : units.find(u=>u.id===+selUnit)?.name;
    const rows_html = filtered.map(r => {
      const t = r.tenant;
      const linesHtml = Object.entries(r.calc.lines).map(([,l])=>{
        if(l.tiered){
          return `<tr style="font-size:11px;color:#555"><td style="padding:3px 8px;padding-right:20px">↳ ${l.name}</td>
            <td>מוזל: ${l.lowUsage.toFixed(1)}×${l.priceLow}₪${l.highUsage>0?` + יקר: ${l.highUsage.toFixed(1)}×${l.priceHigh}₪`:""} (מכסה ${l.allowance.toFixed(0)} מ״ק / ${l.persons} נפשות)</td>
            <td style="text-align:left">${fmt(l.amount)}</td></tr>`;
        }
        const detail = l.periods?.length>1
          ? l.periods.map(p=>`${p.kwh.toFixed(1)}×${p.price}₪`).join(" + ")
          : `${l.usage} ${l.unit} × ${(l.price||0)}₪`;
        const fixed = l.fixedShare>0 ? ` + קבוע ${fmt(l.fixedShare)}` : "";
        return `<tr style="font-size:11px;color:#555"><td style="padding:3px 8px;padding-right:20px">↳ ${l.name}</td><td>${detail}${fixed}</td><td style="text-align:left">${fmt(l.amount)}</td></tr>`;
      }).join("");
      return `
        <tr style="background:#f9f9f9;border-top:2px solid #e8c547">
          <td style="padding:8px 10px;font-weight:700">${r.unit.name}</td>
          <td style="padding:8px 10px">${periodLabel(r.periodKey)}</td>
          <td style="padding:8px 10px">${t.name}<br/><span style="font-size:11px;color:#888">${t.phone||""}</span></td>
          <td style="padding:8px 10px">${fmt(r.unit.rent)}</td>
          <td style="padding:8px 10px">${fmt(r.calc.total)}</td>
          <td style="padding:8px 10px;font-weight:700">${fmt(r.unit.rent+r.calc.total)}</td>
          <td style="padding:8px 10px;color:${r.b.paid?"#2a7a2a":"#aa2222"};font-weight:700">${r.b.paid?`✓ שולם${r.b.paidDate?" · "+r.b.paidDate:""}`:"⏳ לא שולם"}</td>
        </tr>
        ${linesHtml}
      `;
    }).join("");

    const html = `<html dir="rtl"><head><meta charset="utf-8"/><style>
      body{font-family:Arial,sans-serif;max-width:900px;margin:30px auto;color:#222;font-size:13px}
      h1{font-size:20px;border-bottom:3px solid #1a1a2e;padding-bottom:8px}
      .summary{display:flex;gap:24px;margin:16px 0;font-size:13px}
      .sum-box{background:#f5f5f5;border-radius:6px;padding:10px 16px;text-align:center}
      .sum-box .val{font-size:18px;font-weight:800}
      table{width:100%;border-collapse:collapse;margin-top:16px}
      th{background:#1a1a2e;color:#e8c547;padding:8px 10px;text-align:right;font-size:12px}
      td{padding:6px 10px;border-bottom:1px solid #eee;vertical-align:top}
      .foot{margin-top:20px;font-size:10px;color:#aaa;border-top:1px solid #ddd;padding-top:10px}
    </style></head><body>
    <h1>📊 דוח חשבונות — ${unitTitle}</h1>
    <div class="summary">
      <div class="sum-box"><div style="color:#888">סה״כ לחיוב</div><div class="val">${fmt(totalDue)}</div></div>
      <div class="sum-box" style="color:#2a7a2a"><div>שולם</div><div class="val">${fmt(totalPaid)}</div></div>
      <div class="sum-box" style="color:#aa2222"><div>ממתין</div><div class="val">${fmt(totalOwed)}</div></div>
    </div>
    <table>
      <thead><tr>
        <th>יחידה</th><th>תקופה</th><th>שוכר</th><th>שכירות</th><th>שירותים</th><th>סה״כ</th><th>סטטוס</th>
      </tr></thead>
      <tbody>${rows_html}</tbody>
    </table>
    <div class="foot">הופק: ${today} · מערכת ניהול נכסים</div>
    </body></html>`;

    const w = window.open("","_blank");
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
  };

  return(
    <div>
      {/* Filters */}
      <Card style={{marginBottom:16}}>
        <div style={{fontWeight:700,color:"#e8c547",marginBottom:12}}>📊 סינון דוח</div>
        <div style={{display:"flex",gap:12,flexWrap:"wrap",alignItems:"flex-end"}}>
          <label style={S.lbl}>יחידה
            <select value={selUnit} onChange={e=>{setSelUnit(e.target.value);setSelTenant("current");}} style={{...S.sel,display:"block",marginTop:4}}>
              <option value="all">כל היחידות</option>
              {units.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
          {selectedUnit&&(
            <label style={S.lbl}>שוכר
              <select value={selTenant} onChange={e=>setSelTenant(e.target.value)} style={{...S.sel,display:"block",marginTop:4}}>
                <option value="all">כל השוכרים</option>
                <option value="current">שוכר נוכחי</option>
                {tenantOptions.map(t=><option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </label>
          )}
          <button onClick={printReport} style={{...S.btn("#e8c547","#1a1a2e"),display:"flex",alignItems:"center",gap:6,alignSelf:"flex-end"}}>🖨️ הדפסה / ייצוא</button>
        </div>
      </Card>

      {/* Summary cards */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:14,marginBottom:20}}>
        <StatCard label="סה״כ לחיוב"  value={fmt(totalDue)}  icon="📋" color="#e8c547"/>
        <StatCard label="סה״כ שולם"   value={fmt(totalPaid)} icon="✅" color="#4caf88"/>
        <StatCard label="סה״כ ממתין"  value={fmt(totalOwed)} icon="⏳" color="#e85c4a"/>
      </div>

      {/* Report table */}
      <Card style={{padding:0,overflow:"hidden"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
          <thead><tr style={{background:"#0e0e20"}}>
            {["יחידה","תקופה","שוכר","שכירות","שירותים","סה״כ","סטטוס"].map(h=>(
              <th key={h} style={{padding:"10px 12px",textAlign:"right",color:"#666",fontWeight:600,borderBottom:"1px solid #1e1e3a",whiteSpace:"nowrap"}}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {filtered.length===0&&<tr><td colSpan={7} style={{padding:40,textAlign:"center",color:"#555"}}>אין נתונים להצגה</td></tr>}
            {filtered.map(r=>(
              <React.Fragment key={r.k}>
                <tr style={{borderBottom:"1px solid #1e1e3a",background:r.b.paid?"#0a120a":"#120a0a"}}>
                  <td style={{padding:"10px 12px",fontWeight:700,color:"#e8c547"}}>{r.unit.name}</td>
                  <td style={{padding:"10px 12px",color:"#6bc5f8",whiteSpace:"nowrap"}}>{periodLabel(r.periodKey)}</td>
                  <td style={{padding:"10px 12px"}}>
                    <div style={{color:"#ddd",fontSize:13}}>{r.tenant.name}</div>
                    <div style={{color:"#555",fontSize:11}}>{r.tenant.phone}</div>
                  </td>
                  <td style={{padding:"10px 12px",color:"#ccc"}}>{fmt(r.unit.rent)}</td>
                  <td style={{padding:"10px 12px"}}>
                    {Object.entries(r.calc.lines).map(([tk,l])=>(
                      <div key={tk} style={{fontSize:11,color:"#888",whiteSpace:"nowrap"}}>
                        {l.name}: {l.tiered
                          ? `${l.lowUsage.toFixed(1)}+${l.highUsage.toFixed(1)} מ״ק`
                          : `${l.usage} ${l.unit}`
                        } = <span style={{color:"#ccc"}}>{fmt(l.amount)}</span>
                      </div>
                    ))}
                  </td>
                  <td style={{padding:"10px 12px",fontWeight:800,fontSize:15,color:r.b.locked?"#e8c547":"#aaa",whiteSpace:"nowrap"}}>{r.b.locked&&r.b.lockedAmount!=null?<>{fmt(r.b.lockedAmount)} <span style={{fontSize:10}}>🔒</span></>:fmt(r.unit.rent+r.calc.total)}</td>
                  <td style={{padding:"10px 12px"}}>
                    <Badge color={r.b.paid?"#4caf88":"#e85c4a"}>
                      {r.b.paid?`✓ ${r.b.paidDate||"שולם"}`:"⏳ ממתין"}
                    </Badge>
                  </td>
                </tr>
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ─── APP ─────────────────────────────────────────────────────────────────────

export default function App(){
  const[tab,setTab]=useState("dashboard");
  const[showAdmin,setShowAdmin]=useState(false);

  // Detect environment — stable across renders (window never changes)
  const isClaudeEnv = typeof window !== "undefined" && typeof window.storage === "object";

  // Always call ALL hooks unconditionally (Rules of Hooks)
  const auth         = useAuth();          // returns stub when in Claude env
  const supabaseHook = useSupabaseData(DEFAULT_DATA);
  const claudeHook   = useCloudData();

  const rawHook  = isClaudeEnv ? claudeHook : supabaseHook;
  const userRole  = isClaudeEnv ? "editor"  : auth?.userRole;
  const userUnitId = isClaudeEnv ? null : auth?.unitId;   // non-null = unit_viewer
  const readonly = !canEdit(userRole);
  const { data, syncOk, lastSync } = rawHook;
  const save = readonly ? () => {} : rawHook.save;

  // ── Auth gates (only outside Claude) ─────────────────────────────────────
  if(!isClaudeEnv){
    if(auth.isLoading || data===null) return (
      <div style={{minHeight:"100vh",background:"#0a0a1a",display:"flex",alignItems:"center",justifyContent:"center",color:"#666",fontFamily:"'Segoe UI',sans-serif",fontSize:16,flexDirection:"column",gap:12}}>
        <div style={{fontSize:40}}>🏢</div><div>טוען…</div>
      </div>
    );
    if(!auth.isLoggedIn) return <LoginScreen authStep={auth.authStep} error={auth.error} onSendLink={auth.sendMagicLink} onSignInPassword={auth.signInWithPassword} />;
    if(isPending(auth.userRole)) return <PendingScreen email={auth.email} onSignOut={auth.signOut}/>;
    if(!canView(auth.userRole)) return <PendingScreen email={auth.email} onSignOut={auth.signOut}/>;
  }

  const isUnitView = isUnitViewer(userRole);
  const tabs=[
    {id:"dashboard",label:"סקירה כללית",    icon:"📊"},
    {id:"bills",    label:"חשבונות שירותים",icon:"💧"},
    ...(!isUnitView?[
      {id:"finance",  label:"הכנסות והוצאות", icon:"💰"},
      {id:"units",    label:"יחידות דיור",     icon:"🏠"},
      {id:"reports",  label:"דוחות",           icon:"📈"},
      {id:"excel",    label:"Excel",            icon:"📊"},
    ]:[]),
  ];

  if(!data) return(
    <div dir="rtl" style={{minHeight:"100vh",background:"#0a0a1a",display:"flex",alignItems:"center",justifyContent:"center",color:"#666",fontFamily:"'Segoe UI',Tahoma,sans-serif",fontSize:16,gap:12,flexDirection:"column"}}>
      <div style={{fontSize:40}}>🏢</div>
      <div>טוען נתונים מהענן…</div>
      <div style={{width:200,height:3,background:"#1e1e3a",borderRadius:3,overflow:"hidden"}}>
        <div style={{width:"60%",height:"100%",background:"#e8c547",borderRadius:3,animation:"pulse 1s infinite"}}/>
      </div>
    </div>
  );

  return(
    <div dir="rtl" style={{minHeight:"100vh",background:"#0a0a1a",color:"#ddd",fontFamily:"'Segoe UI',Tahoma,sans-serif"}}>
      {showAdmin&&<AdminPanel currentEmail={auth?.email} onClose={()=>setShowAdmin(false)} units={data?.units||[]}/>}
      <div style={{background:"linear-gradient(135deg,#12122a,#1a1a3a)",borderBottom:"1px solid #1e1e40",padding:"14px 24px",display:"flex",alignItems:"center",gap:12}}>
        <div style={{fontSize:26}}>🏢</div>
        <div style={{flex:1}}>
          <div style={{fontWeight:900,fontSize:19,color:"#e8c547"}}>מערכת ניהול נכסים</div>
          <div style={{color:"#555",fontSize:11}}>ניהול שוכרים · חשבונות · כספים</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10,fontSize:12}}>
          {readonly&&!isUnitViewer(userRole)&&<span style={{color:"#e8c547",background:"#e8c54722",border:"1px solid #e8c54744",borderRadius:10,padding:"2px 10px"}}>👁 צפייה בלבד</span>}
          {isUnitViewer(userRole)&&<span style={{color:"#a78bfa",background:"#a78bfa22",border:"1px solid #a78bfa44",borderRadius:10,padding:"2px 10px"}}>🏠 {data?.units?.find(u=>u.id===+userUnitId)?.name||"יחידה שלי"}</span>}
          {!isClaudeEnv&&auth?.email&&(
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{color:"#555"}}>{auth.email}</span>
              {isAdmin(auth?.userRole)&&<button onClick={()=>setShowAdmin(true)} style={{background:"#1a1a2e",border:"1px solid #2a2a4a",color:"#e8c547",borderRadius:8,padding:"4px 10px",cursor:"pointer",fontSize:11,fontFamily:"inherit"}}>🔑 ניהול משתמשים</button>}
              <button onClick={auth.signOut} style={{background:"none",border:"1px solid #2a2a4a",color:"#555",borderRadius:8,padding:"4px 10px",cursor:"pointer",fontSize:11,fontFamily:"inherit"}}>התנתק</button>
            </div>
          )}
          {isClaudeEnv&&<span style={{color:"#4caf88"}}>☁️ שיתוף ענן</span>}
        </div>
      </div>

      <SyncBar syncOk={syncOk} lastSync={lastSync} isClaudeEnv={isClaudeEnv}/>

      <div style={{background:"#0e0e22",borderBottom:"1px solid #1e1e3a",display:"flex",overflowX:"auto",padding:"0 16px"}}>
        {tabs.map(t=><NavTab key={t.id} {...t} active={tab===t.id} onClick={()=>setTab(t.id)}/>)}
      </div>

      <div style={{padding:20,maxWidth:1100,margin:"0 auto"}}>
        {tab==="dashboard"&&<DashboardTab data={data}/>}
        {tab==="bills"    &&<BillsTab     data={data} save={save} readonly={readonly} unitFilter={isUnitViewer(userRole)?userUnitId:null}/>}
        {tab==="finance"  &&!isUnitViewer(userRole)&&<FinanceTab   data={data} save={save} readonly={readonly}/>}
        {tab==="units"    &&!isUnitViewer(userRole)&&<UnitsTab     data={data} save={save} readonly={readonly}/>}
        {tab==="reports"  &&!isUnitViewer(userRole)&&<ReportsTab   data={data} unitFilter={null}/>}
        {tab==="excel"    &&!isUnitViewer(userRole)&&<ExcelPanel   data={data} save={save}/>}
      </div>
    </div>
  );
}
