"use client";
import React, { useEffect, useMemo, useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Shuffle, ListChecks, CheckCircle2, AlertTriangle } from "lucide-react";

// ──────────────────────────────────────────────────────────────────────────────
// Types & constants
// ──────────────────────────────────────────────────────────────────────────────
const STORAGE_KEY = "spinango_state_v2" as const;
const RANKS = ["A","K","Q","J","T","9","8","7","6","5","4","3","2"] as const;

export type TableMode = "3MAX" | "HU";
export type Position = "BTN" | "SB" | "BB";

const POSITIONS_3MAX: readonly Position[] = ["BTN","SB","BB"] as const;
const POSITIONS_HU:    readonly Position[] = ["SB","BB"]       as const;

const PAINT_ACTIONS = ["FOLD","CALL","RAISE","SHOVE","RAISECALL","TIERSTACK"] as const; // editor
const DECISION_ACTIONS = ["FOLD","CALL","RAISE","SHOVE","TIERSTACK"] as const; // trainer

type PaintAction = typeof PAINT_ACTIONS[number];
type DecisionAction = typeof DECISION_ACTIONS[number];
type Rank = typeof RANKS[number];

const DEFAULT_DEPTHS = Array.from({length: 21}, (_,i) => 25 - i).filter(d => d >= 5);

export type ComboKey = string; // "AKs" | "AQo" | "TT"
export type RangeMap = Record<ComboKey, PaintAction>;
export type DepthKey = `${number}bb`;

export type Ranges = {
  [depth in DepthKey]?: { [pos in Position]?: { [contextKey: string]: RangeMap } }
};
export type RangesByMode = Partial<Record<TableMode, Ranges>>;
export type HistoryState = Partial<Record<Position, DecisionAction | null>>;

// ──────────────────────────────────────────────────────────────────────────────
// Helpers (combos, ranges)
// ──────────────────────────────────────────────────────────────────────────────
const comboKey = (r1: Rank, r2: Rank, suited: boolean): ComboKey => {
  if (r1 === r2) return (r1 + r2) as ComboKey; // pair
  const [hi, lo] = RANKS.indexOf(r1) < RANKS.indexOf(r2) ? [r1, r2] : [r2, r1];
  return `${hi}${lo}${suited ? "s" : "o"}` as ComboKey;
};

const allCombos: ComboKey[] = (() => {
  const keys: ComboKey[] = [];
  for (let i = 0; i < RANKS.length; i++) {
    for (let j = 0; j < RANKS.length; j++) {
      if (i === j) keys.push((RANKS[i] + RANKS[j]) as ComboKey);
      else if (i < j) { keys.push(`${RANKS[i]}${RANKS[j]}s` as ComboKey); keys.push(`${RANKS[i]}${RANKS[j]}o` as ComboKey); }
    }
  }
  return keys;
})();

function emptyRangeMap(): RangeMap { const m: RangeMap = {} as RangeMap; for (const c of allCombos) m[c] = "FOLD"; return m; }

// quick helper: set multiple combos to an action on a map
function setCombos(m: RangeMap, combos: ComboKey[], a: PaintAction){ combos.forEach(k=>{ if (k in m) m[k]=a; }); }

function orderFor(mode: TableMode): readonly Position[] { return mode === "HU" ? POSITIONS_HU : POSITIONS_3MAX; }

export function makeContextKey(history: HistoryState, actor: Position, mode: TableMode): string {
  const order = orderFor(mode); const idx = order.indexOf(actor); const prev = order.slice(0, idx);
  const parts: string[] = []; for (const p of prev){ const a = history[p]; if (a && a !== 'FOLD') parts.push(`${p}:${a}`); }
  return parts.join(",");
}

// ──────────────────────────────────────────────────────────────────────────────
// Context validation (BB cannot act unless BTN & SB acted, etc.)
// ──────────────────────────────────────────────────────────────────────────────
function isContextValid(actor: Position, mode: TableMode, h: HistoryState): { valid: boolean; reason?: string } {
  const has = (x: any) => x !== undefined && x !== null;
  if (mode === 'HU') { if (actor === 'SB') return { valid: true }; if (!has(h.SB) || h.SB === 'FOLD') return { valid:false, reason:"En HU, définis l'action du SB (limp=CALL / raise / shove)." }; return { valid:true }; }
  if (actor === 'BTN') return { valid:true };
  if (actor === 'SB') { if (!has(h.BTN)) return { valid:false, reason:"En 3-max, SB agit après BTN : précise l'action du BTN." }; return { valid:true }; }
  if (!has(h.BTN)) return { valid:false, reason:"En 3-max, BB agit après BTN : précise l'action du BTN." };
  if (!has(h.SB))  return { valid:false, reason:"En 3-max, BB agit après SB : précise l'action du SB." };
  if (h.BTN === 'FOLD' && h.SB === 'FOLD') return { valid:false, reason:"BTN et SB ont fold : le coup est terminé." };
  return { valid:true };
}

function ContextGuard({ ok, reason, children }: { ok: boolean; reason?: string; children: React.ReactNode }){
  if (ok) return <>{children}</>;
  return (
    <div className="relative">
      <div className="pointer-events-none opacity-40">{children}</div>
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex items-center gap-2 rounded-xl border bg-white/90 p-3 text-sm text-slate-900 shadow">
          <AlertTriangle className="h-4 w-4" />
          <span>{reason || "Contexte incomplet pour cette position."}</span>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Cards UI
// ──────────────────────────────────────────────────────────────────────────────
const RED = new Set(["♥","♦"]);
function randomHandKey(): ComboKey { const i = Math.floor(Math.random()*RANKS.length); const j = Math.floor(Math.random()*RANKS.length); if (i===j) return (RANKS[i]+RANKS[j]) as ComboKey; const suited = Math.random()<0.5; const [hi, lo] = i<j ? [RANKS[i], RANKS[j]] : [RANKS[j], RANKS[i]]; return `${hi}${lo}${suited?"s":"o"}` as ComboKey; }
function splitToCards(k: ComboKey){ const r1 = k[0], r2 = k[1], t = k[2]; if (r1 === r2) return [{ rank: r1, suit: '♠' as const }, { rank: r2, suit: '♥' as const }]; if (t === 's') return [{ rank: r1, suit: '♠' as const }, { rank: r2, suit: '♠' as const }]; return [{ rank: r1, suit: '♠' as const }, { rank: r2, suit: '♥' as const }]; }
function HoleCards({combo}:{combo: ComboKey}){ const [c1, c2] = splitToCards(combo); return (
  <div className="flex items-center gap-2 sm:gap-3">
    {[c1,c2].map((c,idx)=> (
      <div key={idx} className="w-14 h-20 sm:w-16 sm:h-24 rounded-2xl border shadow-sm bg-white flex flex-col items-center justify-center">
        <div className={`text-2xl sm:text-3xl font-bold ${RED.has(c.suit)?"text-red-600":"text-slate-800"}`}>{c.rank}</div>
        <div className={`text-lg sm:text-xl ${RED.has(c.suit)?"text-red-600":"text-slate-800"}`}>{c.suit}</div>
      </div>
    ))}
  </div>
);} 

// ──────────────────────────────────────────────────────────────────────────────
// Poker Table (layout + badges + stacks)
// ──────────────────────────────────────────────────────────────────────────────
function DealerChip(){ return <span className="inline-flex items-center justify-center rounded-full bg-amber-300 text-amber-900 text-[10px] font-bold w-6 h-6 shadow">D</span>; }

function getSeatLayout(mode: TableMode, hero: Position): Record<Position, React.CSSProperties> {
  const layout: Partial<Record<Position, React.CSSProperties>> = {};
  const bottomCenter: React.CSSProperties = { bottom: '6%', left: '50%', transform: 'translateX(-50%)' };
  if (mode === 'HU') {
    const opp = hero === 'SB' ? 'BB' : 'SB';
    layout[hero] = bottomCenter;
    layout[opp]  = { top: '12%', left: '50%', transform: 'translateX(-50%)' };
    layout['BTN' as Position] = { display: 'none' };
    return layout as Record<Position, React.CSSProperties>;
  }
  const others = (['BTN','SB','BB'] as Position[]).filter(p => p !== hero);
  layout[hero] = bottomCenter;
  if (others[0]) layout[others[0]] = { top: '12%', left: '15%' };
  if (others[1]) layout[others[1]] = { top: '12%', right: '15%' };
  return layout as Record<Position, React.CSSProperties>;
}

function SeatBadge({ p, mode }: { p: Position; mode: TableMode }){
  const isBtn = (mode === 'HU' && p === 'SB') || (mode === '3MAX' && p === 'BTN');
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-slate-700 text-white border border-slate-600">{mode === 'HU' && p === 'SB' ? 'SB (BTN)' : p}</span>
      {isBtn && <DealerChip />}
    </div>
  );
}

function ActionPill({ label, action, dimmed, step }:{ label:string; action:DecisionAction|'—'; dimmed?:boolean; step?:number }){
  const base = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border shadow-sm';
  const map: Record<string,string> = { 'FOLD':'bg-slate-200 text-slate-800 border-slate-300', 'CALL':'bg-yellow-200 text-yellow-900 border-yellow-300', 'RAISE':'bg-orange-300 text-orange-900 border-orange-400', 'SHOVE':'bg-green-300 text-green-900 border-green-400', '—':'bg-slate-100 text-slate-500 border-slate-200' };
  return (<span className={`${base} ${map[action]||map['—']} ${dimmed?'opacity-60':''}`}>{step ? <span className="inline-flex items-center justify-center w-4 h-4 text-[9px] rounded-full bg-black/20 text-white">{step}</span> : null}<span>{label}</span></span>);
}

function prettyAction(p: Position, mode: TableMode, h: HistoryState): {label:string, action:DecisionAction|'—'}{ const a = h[p]; if (!a) return {label:'—', action:'—'}; if (mode==='HU' && p==='SB' && a==='CALL') return {label:'LIMP', action:'CALL'}; return {label:String(a), action:a as DecisionAction}; }

function PokerTable({ mode, hero, history, hand, contextLabel, depth }:{
  mode: TableMode;
  hero: Position;
  history: HistoryState;
  hand: ComboKey;
  contextLabel: string;
  depth: number;
}){
  const layout = getSeatLayout(mode, hero);
  const seats: Position[] = mode === 'HU' ? (['SB','BB'] as Position[]) : (['BTN','SB','BB'] as Position[]);
  const order = mode === 'HU' ? (['SB','BB'] as Position[]) : (['BTN','SB','BB'] as Position[]);
  const heroIdx = order.indexOf(hero);
  return (
    <div className="w-full">
      <div className="relative mx-auto w-full max-w-full sm:max-w-3xl lg:max-w-4xl aspect-[4/3] sm:aspect-[16/9] lg:aspect-[2/1] rounded-[999px] bg-emerald-900/80 ring-3 sm:ring-5 ring-emerald-700/60 shadow-inner overflow-hidden px-2">
        {/* felt texture */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(255,255,255,0.08),rgba(0,0,0,0))]"></div>

        {/* seats */}
        {seats.map((p)=>{
          const style = layout[p] || {};
          if ((style as any).display === 'none') return null;
          const isHero = p === hero;
          const {label, action} = prettyAction(p, mode, history);
          const step = order.indexOf(p)+1;
          const actedBeforeHero = order.indexOf(p) < heroIdx; // adversaires avant nous
          return (
            <div key={p} className="absolute z-10" style={style}>
              <div className={`w-[clamp(120px,18vw,200px)] rounded-2xl bg-slate-900/90 text-white border border-white/10 shadow-md p-2 ${isHero ? 'ring-2 ring-fuchsia-400/80' : ''}`}>
                <div className="flex items-center justify-between gap-2 min-h-6">
                  <SeatBadge p={p} mode={mode} />
                  <ActionPill label={label} action={action} step={step} dimmed={!actedBeforeHero && !isHero} />
                </div>
                {isHero ? (
                  <>
                    <div className="mt-2 flex justify-center">
                      <HoleCards combo={hand} />
                    </div>
                    <div className="mt-1 text-center text-white select-none">
                      <span className="text-xl sm:text-2xl font-extrabold leading-none">{depth}</span>
                      <span className="ml-1 text-base sm:text-lg font-extrabold leading-none">bb</span>
                    </div>
                  </>
                ) : (
                  <div className="mt-2">
                    <div className="mt-1 text-center text-white select-none">
                      <span className="text-xl sm:text-2xl font-extrabold leading-none">{depth}</span>
                      <span className="ml-1 text-base sm:text-lg font-extrabold leading-none">bb</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// 13×13 Range grid
// ──────────────────────────────────────────────────────────────────────────────
function actionToCellClass(a: PaintAction){ switch(a){ case "FOLD": return "bg-white text-slate-900 hover:brightness-95"; case "CALL": return "bg-yellow-400/80 text-slate-900 hover:brightness-105"; case "RAISE": return "bg-orange-500/80 text-white hover:brightness-110"; case "RAISECALL": return "bg-red-700/80 text-white hover:brightness-110"; case "SHOVE": return "bg-green-500/80 text-white hover:brightness-110"; case "TIERSTACK": return "bg-sky-300/80 text-slate-900 hover:brightness-110"; } }
function RangeGrid({ map, onPaint, currentAction, disabled = false }:{ map: RangeMap; onPaint: (k: ComboKey, a: PaintAction) => void; currentAction: PaintAction; disabled?: boolean; }){ const [isMouseDown, setIsMouseDown] = useState(false); return (
  <div className="overflow-x-auto rounded-xl border">
    <table className="w-full min-w-[520px] border-collapse text-[10px] sm:text-[12px]">
      <thead><tr><th className="sticky left-0 top-0 z-20 p-1 sm:p-2 text-left bg-white text-slate-900">\\</th>{RANKS.map((r)=>(<th key={r} className="p-1 sm:p-2 text-center sticky top-0 z-10 bg-white text-slate-900">{r}</th>))}</tr></thead>
      <tbody onMouseLeave={()=>setIsMouseDown(false)}>
        {RANKS.map((r1,i)=> (
          <tr key={r1}>
            <th className="sticky left-0 z-10 p-1 sm:p-2 text-left bg-white text-slate-900">{r1}</th>
            {RANKS.map((r2,j)=>{ let key: ComboKey; let label=""; if(i===j){ key=(r1+r2) as ComboKey; label=key; } else if(i<j){ key=`${r1}${r2}s` as ComboKey; label=`${r1}${r2}s`; } else { key=`${r2}${r1}o` as ComboKey; label=`${r2}${r1}o`; } const a = map[key]; return (
              <td key={label} className={`p-1 sm:p-2 text-center select-none border ${disabled?"cursor-not-allowed opacity-60":"cursor-pointer"} ${actionToCellClass(a)}`}
                onMouseDown={(e)=>{ if(disabled) return; e.preventDefault(); setIsMouseDown(true); onPaint(key, currentAction); }}
                onMouseUp={()=>setIsMouseDown(false)}
                onMouseEnter={()=>{ if(disabled) return; if(isMouseDown) onPaint(key, currentAction); }}
                title={`${label}: ${a}`}>{label}</td>
            );})}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
); }

// ──────────────────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────────────────
export default function SpinRangeTrainer(){
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [mode, setMode] = useState<TableMode>("3MAX");
  const [depths, setDepths] = useState<number[]>(DEFAULT_DEPTHS);
  const [activeDepth, setActiveDepth] = useState<number>(15);
  const [position, setPosition] = useState<Position>("BTN");
  const [history, setHistory] = useState<HistoryState>({});
  const [autoHistory, setAutoHistory] = useState<boolean>(true);
  const [rangesByMode, setRangesByMode] = useState<RangesByMode>(()=>({}));
  const [paintAction, setPaintAction] = useState<PaintAction>("RAISE");
  const [showRange, setShowRange] = useState(false);
  const [hand, setHand] = useState<ComboKey>('AA');
  const [modeRandom, setModeRandom] = useState<boolean>(true);
  const [score, setScore] = useState({ok:0, total:0});

  // COPY UI state
  const [copyFromDepth, setCopyFromDepth] = useState<number>(25);
  const [copyToDepth, setCopyToDepth] = useState<number>(24);
  const [copyOnlyCurrentContext, setCopyOnlyCurrentContext] = useState<boolean>(false);
  const [copyOverwrite, setCopyOverwrite] = useState<boolean>(true);

  // Load/Save
  useEffect(()=>{ try{ const raw = localStorage.getItem(STORAGE_KEY); if (raw){ const data = JSON.parse(raw); if (data?.rangesByMode) setRangesByMode(data.rangesByMode as RangesByMode); if (Array.isArray(data?.depths) && data.depths.length) setDepths(data.depths as number[]); } else { const rawV1 = localStorage.getItem("spinango_state_v1"); if (rawV1){ const dataV1 = JSON.parse(rawV1); if (dataV1?.ranges){ setRangesByMode({ "3MAX": dataV1.ranges as Ranges }); toast.message("Migration des ranges v1 → v2 (3MAX)"); } if (Array.isArray(dataV1?.depths) && dataV1.depths.length) setDepths(dataV1.depths as number[]); } } } catch(err){ console.error('Load state error', err); } }, []);
  useEffect(()=>{ try{ localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, rangesByMode, depths })); } catch(err){ console.error('Autosave error', err); } }, [rangesByMode, depths]);
  useEffect(()=>{ const id = setTimeout(()=>nextHand(), 0); return ()=>clearTimeout(id); }, []);
  useEffect(()=>{ ensureActiveStructures(); }, [mode, activeDepth, position, history]);

  function ensureActiveStructures(){ const dk: DepthKey = `${activeDepth}bb`; const ctx = contextKey(); const { valid } = isContextValid(position, mode, history); if (!valid) return; setRangesByMode(prev=>{ const copy: RangesByMode = { ...(prev||{}) }; copy[mode] = copy[mode] || {}; const r = copy[mode]!; r[dk] = r[dk] || {}; r[dk]![position] = r[dk]![position] || {}; r[dk]![position]![ctx] = r[dk]![position]![ctx] || emptyRangeMap(); return copy; }); }
  function contextKey(){ return makeContextKey(history, position, mode); }
  const activeMap: RangeMap | undefined = useMemo(()=>{ const dk: DepthKey = `${activeDepth}bb`; return rangesByMode[mode]?.[dk]?.[position]?.[contextKey()]; }, [rangesByMode, mode, activeDepth, position, history]);

  function paint(key: ComboKey, a: PaintAction){ const dk: DepthKey = `${activeDepth}bb`; const ctx = contextKey(); setRangesByMode(prev => ({ ...(prev||{}), [mode]: { ...(prev?.[mode]||{}), [dk]: { ...((prev?.[mode]?.[dk])||{}), [position]: { ...((prev?.[mode]?.[dk]?.[position])||{}), [ctx]: { ...((prev?.[mode]?.[dk]?.[position]?.[ctx])||emptyRangeMap()), [key]: a } } } } })); }

  function normalizePaintToDecision(a: PaintAction | undefined): DecisionAction { if (!a) return 'FOLD'; return a === 'RAISECALL' ? 'RAISE' : (a as DecisionAction); }
  function getCorrectActionForCurrentHand(): DecisionAction { const correctPaint = activeMap ? activeMap[hand] : 'FOLD'; return normalizePaintToDecision(correctPaint); }

  // ── Copy helpers
  function cloneRangeMap(m?: RangeMap): RangeMap { return m ? JSON.parse(JSON.stringify(m)) as RangeMap : emptyRangeMap(); }
  function mergeRangeMaps(target: RangeMap | undefined, source: RangeMap, overwrite: boolean): RangeMap {
    if (overwrite) return cloneRangeMap(source);
    const res: RangeMap = target ? { ...target } : emptyRangeMap();
    for (const k of Object.keys(source)){
      const tk = (res as any)[k] as PaintAction | undefined;
      if (!tk || tk === 'FOLD') (res as any)[k] = (source as any)[k];
    }
    return res;
  }
  function copyRangesBetweenDepths(from: number, to: number, onlyCurrentContext: boolean, overwrite: boolean){
    if (from === to) { toast.error('Choisis deux profondeurs différentes'); return; }
    const fromKey: DepthKey = `${from}bb`; const toKey: DepthKey = `${to}bb`;
    const srcPos = rangesByMode[mode]?.[fromKey]?.[position];
    if (!srcPos){ toast.error(`Pas de ranges pour ${position} @ ${from}bb`); return; }
    const ctxNow = contextKey();
    setRangesByMode(prev => {
      const next: RangesByMode = { ...(prev||{}) };
      next[mode] = next[mode] || {};
      const modeMap = next[mode]!;
      modeMap[toKey] = modeMap[toKey] || {};
      const destPosMap = (modeMap[toKey]![position] = modeMap[toKey]![position] || {});

      const contexts = onlyCurrentContext ? [ctxNow] : Object.keys(srcPos);
      if (contexts.length === 0){ toast.error('Aucun contexte à copier'); return prev; }
      for (const ctx of contexts){
        const srcMap = srcPos[ctx]; if (!srcMap) continue;
        destPosMap[ctx] = mergeRangeMaps(destPosMap[ctx], srcMap, overwrite);
      }
      toast.success(`Copié ${position} ${from}bb → ${to}bb ${onlyCurrentContext ? `(contexte courant)` : `(tous contextes)`}${overwrite?` (remplace)`:` (complète)`}`);
      return next;
    });
  }

  function runSelfTests(){
    const evalAns = (chosen: DecisionAction, correctPaint: PaintAction) => chosen === (correctPaint === 'RAISECALL' ? 'RAISE' : (correctPaint as DecisionAction));
    const rules = [
      { name: 'RAISECALL → RAISE', pass: evalAns('RAISE','RAISECALL') },
      { name: 'RAISECALL ≠ CALL', pass: !evalAns('CALL','RAISECALL') },
      { name: 'SHOVE ok', pass: evalAns('SHOVE','SHOVE') },
      { name: 'CALL ok', pass: evalAns('CALL','CALL') },
      { name: 'TIERSTACK ok', pass: evalAns('TIERSTACK','TIERSTACK') },
    ];
    const ctxTests = [
      { name:'HU BB invalide sans action SB', pass: isContextValid('BB','HU',{}).valid===false },
      { name:'HU BB valide vs limp', pass: isContextValid('BB','HU',{SB:'CALL'}).valid===true },
      { name:'3MAX BB invalide BTN undefined', pass: isContextValid('BB','3MAX',{}).valid===false },
      { name:'3MAX BB invalide SB undefined', pass: isContextValid('BB','3MAX',{BTN:'RAISE'}).valid===false },
      { name:'3MAX BB valide BTN=RAISE & SB=CALL', pass: isContextValid('BB','3MAX',{BTN:'RAISE',SB:'CALL'}).valid===true },
    ];
    // merge tests
    const src = emptyRangeMap(); setCombos(src,['AA','AKs'],'RAISE');
    const tgt = emptyRangeMap(); setCombos(tgt,['AA'],'FOLD'); setCombos(tgt,['QQ'],'CALL');
    const merged = mergeRangeMaps(tgt, src, false);
    const copyTests = [
      { name: 'merge keeps existing non-FOLD', pass: merged['QQ']==='CALL' },
      { name: 'merge writes missing/FOLD', pass: merged['AKs']==='RAISE' && merged['AA']==='RAISE' },
      { name: 'overwrite replaces', pass: mergeRangeMaps(tgt, src, true)['QQ']===src['QQ'] },
    ];
    const tests = [...rules, ...ctxTests, ...copyTests];
    const passed = tests.filter(t=>t.pass).length;
    if (passed===tests.length) toast.success(`Tests OK (${passed}/${tests.length})`);
    else { const failed = tests.filter(t=>!t.pass).map(t=>t.name).join('; '); toast.error(`Tests ratés (${passed}/${tests.length}) → ${failed}`); }
  }

  // One-click install of a tiny GTO demo pack (partial, for example only)
  function installGTODemo(){
    const dk: DepthKey = '15bb';
    // BTN unopened
    const btnMap = emptyRangeMap();
    setCombos(btnMap,[ 'AA','KK','QQ','JJ','TT','AKs','AQs','AJs','KQs','AKo','AQo','A5s','KJs','QJs','JTs' ],'RAISE');
    // SB unopened (3-max) — tighter example
    const sbMap = emptyRangeMap();
    setCombos(sbMap,[ 'AA','KK','QQ','JJ','TT','AKs','AQs','AJs','KQs','AKo','AQo','A5s' ],'RAISE');
    // BB vs BTN open (SB folded → context = "BTN:RAISE")
    const bbVsBtnRaise = emptyRangeMap();
    setCombos(bbVsBtnRaise,[ 'AA','KK','QQ','JJ','TT','AKs','AQs','AKo' ],'SHOVE');
    setCombos(bbVsBtnRaise,[ 'AJs','KQs','AQo','99','88' ],'CALL');

    const demo: RangesByMode = {
      '3MAX': {
        [dk]: {
          BTN: { "": btnMap },
          SB:  { "": sbMap },
          BB:  { "BTN:RAISE": bbVsBtnRaise },
        }
      }
    };
    setRangesByMode(demo);
    if (!depths.includes(15)) setDepths(prev=> Array.from(new Set([...prev,15])).sort((a,b)=>b-a));
    toast.success('Pack GTO (démo) installé');
  }

  function nextHand(){ const next = randomHandKey(); let newPos: Position = position; let newDepth = activeDepth; if (modeRandom){ const positionsPool = mode === "HU" ? POSITIONS_HU : POSITIONS_3MAX; newPos = positionsPool[Math.floor(Math.random()*positionsPool.length)] as Position; newDepth = depths[Math.floor(Math.random()*depths.length)]; setPosition(newPos); setActiveDepth(newDepth); } if (autoHistory){ const h = generateRandomHistory(newPos, mode); setHistory(h); } setShowRange(false); setHand(next); }
  function answer(a: DecisionAction){ const correct = getCorrectActionForCurrentHand(); const isOk = a === correct; setScore(s => ({ ok: s.ok + (isOk?1:0), total: s.total + 1 })); toast[isOk?"success":"error"](isOk?"✔ Correct":"✘ Correct: "+correct); nextHand(); }
  function verify(){ const correct = getCorrectActionForCurrentHand(); toast.message('Action correcte pour cette main: '+correct); setShowRange(true); }
  function resetScore(){ setScore({ok:0,total:0}); }

  function handleExport(){ try{ const blob = new Blob([JSON.stringify({ version:2, rangesByMode, depths }, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `spinango-ranges-${Date.now()}.json`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); toast.success('Export JSON prêt'); } catch{ toast.error('Échec export JSON'); } }
  function handleImportClick(){ fileInputRef.current?.click(); }
  async function onFileSelected(e: React.ChangeEvent<HTMLInputElement>){ const file = e.target.files?.[0]; if (!file) return; try{ const text = await file.text(); const data = JSON.parse(text); if (!data || typeof data !== 'object') throw new Error('Fichier invalide'); if (data.rangesByMode) setRangesByMode(data.rangesByMode as RangesByMode); else if (data.ranges) setRangesByMode({ "3MAX": data.ranges as Ranges }); if (Array.isArray(data.depths) && data.depths.length) setDepths(data.depths as number[]); toast.success('Import réussi'); } catch(err){ toast.error('Import invalide'); console.error(err); } finally { if (e.target) e.target.value = ''; } }

  function generateRandomHistory(actor: Position, m: TableMode): HistoryState {
    const pick = <T,>(items: [T, number][]): T => { const s = items.reduce((a, [,p])=>a+p, 0); let r = Math.random()*s; for (const [v,p] of items){ if ((r-=p) <= 0) return v; } return items[0][0]; };
    const h: HistoryState = {};
    if (m === 'HU'){ if (actor === 'SB') return h; const sb = pick<DecisionAction>([['CALL', 0.45],['RAISE', 0.5],['SHOVE', 0.05]] as any); h.SB = sb; return h; }
    if (actor === 'BTN') return h;
    if (actor === 'SB'){ const btn = pick<DecisionAction>([['FOLD', 0.35],['RAISE', 0.55],['SHOVE', 0.10]] as any); h.BTN = btn; return h; }
    const btn = pick<DecisionAction>([['FOLD', 0.25],['RAISE', 0.6],['SHOVE', 0.15]] as any); h.BTN = btn; let sb: DecisionAction; if (btn === 'FOLD') sb = pick<DecisionAction>([['CALL', 0.25],['RAISE', 0.55],['SHOVE', 0.20]] as any); else sb = pick<DecisionAction>([['FOLD', 0.5],['CALL', 0.3],['RAISE', 0.15],['SHOVE', 0.05]] as any); h.SB = sb; return h;
  }

  function HistoryPicker({actor}:{actor:Position}){ const order = orderFor(mode); const idx = order.indexOf(actor); const prev = order.slice(0, idx); return (
    <div className="flex flex-wrap gap-2 sm:gap-3">{prev.map(p=> (
      <div key={p} className="flex items-center gap-1 sm:gap-2">
        <Label className="w-10 sm:w-12">{p}</Label>
        <div className="flex flex-wrap gap-1">{DECISION_ACTIONS.map(a=> (
          <Button key={a} size="sm" variant={history[p]===a?"default":"outline"} className={history[p]===a?"":"bg-white text-slate-900 hover:bg-white/90 hover:text-slate-900 border-slate-300"} onClick={()=>setHistory(h=>({...h,[p]:h[p]===a?null:a}))}>{a}</Button>
        ))}</div>
      </div>
    ))}</div>
  ); }

  function historyToString(h: HistoryState, actor: Position){ const order = orderFor(mode); const idx = order.indexOf(actor); const prev = order.slice(0, idx); const parts: string[] = []; for (const p of prev){ if (h[p]) parts.push(`${p}:${h[p]}`); } return parts.join(','); }
  function DepthSelector({depths, active, setActive}:{depths:number[]; active:number; setActive:(n:number)=>void}){ return (
    <div className="flex items-center gap-2 flex-wrap"><Label>Profondeur</Label><div className="flex flex-wrap gap-2">{depths.map(d=> (<Button key={d} size="sm" variant={d===active?'default':'outline'} className={d===active?'':'bg-white text-slate-900'} onClick={()=>setActive(d)}>{d}bb</Button>))}</div></div>
  ); }

  const posOptions: readonly Position[] = mode === "HU" ? POSITIONS_HU : POSITIONS_3MAX; const modeBadge = mode === "HU" ? "HU" : "3-max"; const posLabel = (p: Position) => (mode === "HU" && p === 'SB') ? 'SB (BTN)' : p; const { valid: isCtxValid, reason: ctxReason } = isContextValid(position, mode, history);

  return (
    <div className="mx-auto max-w-6xl px-3 sm:px-4 py-4 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-2">
        <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight bg-gradient-to-r from-indigo-500 to-fuchsia-500 bg-clip-text text-transparent">Spinango – Preflop Trainer</h1>
        <div className="flex items-center gap-2"><span className="text-xs font-semibold px-2 py-1 rounded-full bg-slate-900/80 text-white">{modeBadge}</span><span className="text-xs sm:text-sm font-semibold text-white px-2 sm:px-3 py-1 rounded-full bg-slate-900/80">{activeDepth}bb</span></div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Label>Mode</Label>
        <Tabs value={mode} onValueChange={(v)=>{ const newMode = v as TableMode; setMode(newMode); const pool: readonly Position[] = newMode === "HU" ? POSITIONS_HU : POSITIONS_3MAX; if (!pool.includes(position)) { setPosition(newMode === "HU" ? "SB" : "BTN"); setHistory({}); } setShowRange(false); }}>
          <TabsList><TabsTrigger value="3MAX">3-max</TabsTrigger><TabsTrigger value="HU">Heads-Up</TabsTrigger></TabsList>
        </Tabs>
      </div>

      <Tabs defaultValue="trainer">
        <TabsList className="flex flex-wrap"><TabsTrigger value="trainer">Session</TabsTrigger><TabsTrigger value="editor">Éditeur</TabsTrigger><TabsTrigger value="options">Options</TabsTrigger></TabsList>

        <TabsContent value="trainer">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2"><CardTitle>Session</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                    <Label>Position</Label>
                    <Select value={position} onValueChange={(v)=>setPosition(v as Position)}>
                      <SelectTrigger className="w-28 sm:w-32"><SelectValue placeholder="Position"/></SelectTrigger>
                      <SelectContent>{posOptions.map(p=> <SelectItem key={p} value={p as any}>{posLabel(p as Position)}</SelectItem>)}</SelectContent>
                    </Select>
                    <Label>Profondeur</Label>
                    <Select value={String(activeDepth)} onValueChange={(v)=>setActiveDepth(parseInt(v,10))}>
                      <SelectTrigger className="w-20 sm:w-24"><SelectValue placeholder="bb"/></SelectTrigger>
                      <SelectContent>{depths.map(d=> <SelectItem key={d} value={String(d)}>{d}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2"><Label>Historique auto</Label><Switch checked={autoHistory} onCheckedChange={(v)=>{ setAutoHistory(!!v); if (v) setHistory(generateRandomHistory(position, mode)); }} /></div>
                    <div className="flex items-center gap-2"><Label>Aléa pos/depth</Label><Switch checked={modeRandom} onCheckedChange={setModeRandom}/></div>
                  </div>
                </div>

                <div className="space-y-2">{autoHistory ? (<div className="text-sm text-muted-foreground">Contexte: {historyToString(history, position) || 'pot non ouvert'}</div>) : (
                  <div className="space-y-2"><Label>Actions précédentes (contexte)</Label><HistoryPicker actor={position}/><div className="text-xs text-muted-foreground">Contexte: {contextKey() || 'pot non ouvert'}</div></div>
                )}</div>

                <PokerTable mode={mode} hero={position} history={history} hand={hand} contextLabel={contextKey()} depth={activeDepth} />

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">{DECISION_ACTIONS.map(a => (<Button key={a} size="sm" variant={'outline'} onClick={()=>answer(a)}>{a}</Button>))}</div>
                <div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" onClick={verify}><CheckCircle2 className="mr-2 h-4 w-4"/>Vérifier & ouvrir la range</Button><Button size="sm" variant="outline" onClick={nextHand}><Shuffle className="mr-2 h-4 w-4"/>Main suivante</Button><Button size="sm" variant="ghost" onClick={resetScore}><ListChecks className="mr-2 h-4 w-4"/>Reset score</Button></div>

                {showRange && (<div className="mt-3 border rounded-xl p-3"><div className="flex items-center justify-between mb-2"><div className="text-sm text-muted-foreground">{posLabel(position)} @ {activeDepth}bb — {contextKey() || 'Unopened'}</div><Button size="sm" variant="outline" onClick={()=>setShowRange(false)}>Fermer</Button></div>{activeMap ? (<RangeGrid map={activeMap} onPaint={()=>{}} currentAction={'FOLD' as PaintAction}/>) : (<div className="text-sm text-muted-foreground">Aucune range définie pour ce contexte.</div>)}</div>)}

                <div className="text-sm">Score: <span className="font-semibold">{score.ok}/{score.total}</span> ({score.total?Math.round(100*score.ok/score.total):0}%)</div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="editor">
          <div className="space-y-3">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3"><DepthSelector depths={depths} active={activeDepth} setActive={setActiveDepth} />
                <Select value={position} onValueChange={(v)=>setPosition(v as Position)}><SelectTrigger className="w-32"><SelectValue placeholder="Position"/></SelectTrigger><SelectContent>{posOptions.map(p=> <SelectItem key={p} value={p as any}>{posLabel(p as Position)}</SelectItem>)}</SelectContent></Select>
              </div>

              {/* Copy ranges (position courante) */}
              <div className="rounded-xl border p-3 space-y-2 bg-white/60">
                <div className="flex items-center gap-2 flex-wrap">
                  <Label>Copier {posLabel(position)} (mode {mode})</Label>
                  <Label className="text-xs text-muted-foreground">de</Label>
                  <Select value={String(copyFromDepth)} onValueChange={(v)=>setCopyFromDepth(parseInt(v,10))}>
                    <SelectTrigger className="w-20"><SelectValue placeholder="from"/></SelectTrigger>
                    <SelectContent>{depths.map(d=> <SelectItem key={d} value={String(d)}>{d}</SelectItem>)}</SelectContent>
                  </Select>
                  <Label className="text-xs text-muted-foreground">à</Label>
                  <Select value={String(copyToDepth)} onValueChange={(v)=>setCopyToDepth(parseInt(v,10))}>
                    <SelectTrigger className="w-20"><SelectValue placeholder="to"/></SelectTrigger>
                    <SelectContent>{depths.map(d=> <SelectItem key={d} value={String(d)}>{d}</SelectItem>)}</SelectContent>
                  </Select>
                  <div className="flex items-center gap-2"><Switch checked={copyOnlyCurrentContext} onCheckedChange={setCopyOnlyCurrentContext}/><span className="text-xs">Seulement contexte actuel</span></div>
                  <div className="flex items-center gap-2"><Switch checked={copyOverwrite} onCheckedChange={setCopyOverwrite}/><span className="text-xs">Remplacer (sinon complète)</span></div>
                  <Button size="sm" onClick={()=>copyRangesBetweenDepths(copyFromDepth, copyToDepth, copyOnlyCurrentContext, copyOverwrite)}>Appliquer</Button>
                </div>
                <div className="text-xs text-muted-foreground">Astuce : pour propager rapidement, répète l'opération (ex : 25→24, puis 24→23 ...). «Remplacer» écrase; sinon, seules les cases FOLD/missing seront complétées.</div>
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 flex-wrap"><Label>Contexte</Label><HistoryPicker actor={position} /></div>
                {!isCtxValid && (<div className="flex items-center gap-2 text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-sm"><AlertTriangle className="h-4 w-4"/><span>{ctxReason}</span></div>)}
              </div>
              <ContextGuard ok={isCtxValid} reason={ctxReason}>
                {activeMap && (<RangeGrid map={activeMap} onPaint={paint} currentAction={paintAction}/>) }
                {!activeMap && <div className="text-sm text-muted-foreground">Aucune range définie pour ce contexte.</div>}
                <div className="flex items-center gap-2 flex-wrap"><Label>Peindre</Label><div className="flex flex-wrap gap-2">{PAINT_ACTIONS.map(a=> (<Button key={a} size="sm" disabled={!isCtxValid} variant={paintAction===a?'default':'outline'} className={paintAction===a?'':'bg-white text-slate-900'} onClick={()=>setPaintAction(a)}>{a === 'RAISECALL' ? 'RAISE-CALL' : a}</Button>))}</div></div>
              </ContextGuard>
            </div>
            <div className="text-xs text-muted-foreground">Légende – Fold: blanc; Call: jaune (Limp si SB HU unopened); Raise: orange vif; Raise-Call: rouge foncé; Shove: vert vif; Tierstack: bleu ciel.</div>
          </div>
        </TabsContent>

        <TabsContent value="options">
          <Card>
            <CardHeader className="pb-2"><CardTitle>Options</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2"><Label>Profondeurs actives (séparées par des virgules)</Label><Input value={depths.join(',')} onChange={(e)=>{ const arr = e.target.value.split(',').map(x=>parseInt(x.trim(),10)).filter(n=>!isNaN(n)); setDepths(arr); if (!arr.includes(activeDepth) && arr.length){ setActiveDepth(arr[0]); } }} placeholder="25,24,23,...,5"/></div>
              <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" onClick={runSelfTests}>Lancer les self-tests</Button> <Button size="sm" variant="secondary" onClick={installGTODemo}>Installer pack GTO (démo)</Button><span className="text-xs text-muted-foreground">(règles de contexte, layout, merge/copy, etc.)</span></div>
              <div className="flex flex-wrap items-center gap-2"><Button size="sm" onClick={handleExport}>Exporter JSON</Button><Button size="sm" variant="secondary" onClick={handleImportClick}>Importer JSON (remplacer)</Button><input ref={fileInputRef} type="file" accept="application/json" hidden onChange={onFileSelected} /><span className="text-xs text-muted-foreground">Autosave activé (localStorage). Export/Import incluent 3MAX & HU.</span></div>
              <div className="text-xs text-muted-foreground">Les ranges dépendent du <b>contexte</b> et du <b>mode</b>. Exemple HU: si SB (BTN) a LIMP (CALL), tu édites la réponse de BB vs limp.</div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
