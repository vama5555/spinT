"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { CheckCircle2, ListChecks, Shuffle, AlertTriangle } from "lucide-react";

// ── Types & constants ─────────────────────────────────────────────────────────
const STORAGE_KEY = "spinango_state_v2" as const;
const SESSIONS_KEY = "spinango_sessions_v1" as const;
const RANKS = ["A","K","Q","J","T","9","8","7","6","5","4","3","2"] as const;
const DEFAULT_DEPTHS = Array.from({ length: 21 }, (_, i) => 25 - i).filter((d) => d >= 5);

export type TableMode = "3MAX" | "HU";
export type Position = "BTN" | "SB" | "BB";

const POSITIONS_3MAX: readonly Position[] = ["BTN","SB","BB"] as const;
const POSITIONS_HU:    readonly Position[] = ["SB","BB"]       as const;

const PAINT_ACTIONS = ["FOLD","CALL","RAISE","SHOVE","RAISECALL","TIERSTACK"] as const;   // éditeur
const DECISION_ACTIONS = ["FOLD","CALL","RAISE","SHOVE","TIERSTACK"] as const;            // session

export type ComboKey = string;
export type RangeMap = Record<ComboKey, typeof PAINT_ACTIONS[number]>;
export type DepthKey = `${number}bb`;
export type Ranges = { [depth in DepthKey]?: { [pos in Position]?: { [contextKey: string]: RangeMap } } };
export type RangesByMode = Partial<Record<TableMode, Ranges>>;
export type HistoryState = Partial<Record<Position, typeof DECISION_ACTIONS[number] | null>>;

type Counter = { correct: number; total: number };
type SessionStats = {
  active: boolean; startAt: number; endAt?: number;
  overall: Counter;
  byPosition: Partial<Record<Position, Counter>>;
  byDepth: Record<number, Counter>;
  byContext: Record<string, Counter>;
};
type SavedSession = SessionStats & { id: string; mode?: TableMode };
type TrainingMode = "standard" | "spaced" | "difficult_only";

type MistakeSnapshot = {
  mode: TableMode; position: Position; depth: number;
  history: HistoryState; hand: ComboKey;
  correct: typeof DECISION_ACTIONS[number];
  contextKey: string; map?: RangeMap;
} | null;

// ── Helpers (combos, ranges) ──────────────────────────────────────────────────
type Rank = typeof RANKS[number];
const comboKey = (r1: Rank, r2: Rank, suited: boolean): ComboKey => {
  if (r1 === r2) return (r1 + r2) as ComboKey;
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
const emptyRangeMap = (): RangeMap => { const m = {} as RangeMap; for (const c of allCombos) m[c] = "FOLD"; return m; };

function mergeRangeMaps(
  target: RangeMap | undefined,
  source: RangeMap,
  replace: boolean
): RangeMap {
  if (replace || !target) return { ...source };
  const out: RangeMap = { ...target };
  for (const k of allCombos as ComboKey[]) {
    // compléter seulement les cases vides / FOLD
    if (out[k] === undefined || out[k] === "FOLD") out[k] = source[k];
  }
  return out;
}

const orderFor = (mode: TableMode): readonly Position[] => mode === "HU" ? POSITIONS_HU : POSITIONS_3MAX;
export function makeContextKey(history: HistoryState, actor: Position, mode: TableMode): string {
  const order = orderFor(mode); const idx = order.indexOf(actor); const prev = order.slice(0, idx);
  const parts: string[] = [];
  for (const p of prev){ const a = history[p]; if (a && a !== 'FOLD') parts.push(`${p}:${a}`); }
  return parts.join(",");
}

// ── Context rules ─────────────────────────────────────────────────────────────
function isContextValid(actor: Position, mode: TableMode, h: HistoryState): { valid: boolean; reason?: string } {
  const has = (x: any) => x !== undefined && x !== null;
  if (mode === 'HU') { if (actor === 'SB') return { valid: true };
    if (!has(h.SB) || h.SB === 'FOLD') return { valid:false, reason:"En HU, définis l'action du SB (limp=CALL / raise / shove)." };
    return { valid:true };
  }
  if (actor === 'BTN') return { valid:true };
  if (actor === 'SB') { if (!has(h.BTN)) return { valid:false, reason:"En 3-max, SB agit après BTN : précise l'action du BTN." }; return { valid:true }; }
  if (!has(h.BTN)) return { valid:false, reason:"En 3-max, BB agit après BTN : précise l'action du BTN." };
  if (!has(h.SB))  return { valid:false, reason:"En 3-max, BB agit après SB : précise l'action du SB." };
  if (h.BTN === 'FOLD' && h.SB === 'FOLD') return { valid:false, reason:"BTN et SB ont fold : le coup est terminé." };
  return { valid:true };
}
const hasShoveBefore = (actor: Position, mode: TableMode, h: HistoryState) => {
  const order = orderFor(mode); const idx = order.indexOf(actor); const prev = order.slice(0, idx);
  return prev.some(p => h[p] === 'SHOVE');
};
const getAllowedDecisionActions = (actor: Position, mode: TableMode, h: HistoryState) =>
  hasShoveBefore(actor, mode, h) ? (["FOLD","CALL"] as const) : DECISION_ACTIONS;
const getAllowedPaintActions = (actor: Position, mode: TableMode, h: HistoryState) =>
  hasShoveBefore(actor, mode, h) ? (["FOLD","CALL"] as const) : PAINT_ACTIONS;
const getAllowedHistoryActions = (p: Position, actor: Position, mode: TableMode, h: HistoryState) => {
  if (mode === '3MAX' && actor === 'BB' && p === 'SB'){ if (h.BTN === 'SHOVE') return ["FOLD","CALL"] as any; }
  return DECISION_ACTIONS as any;
};

// ── Small UI bits ─────────────────────────────────────────────────────────────
const RED = new Set(["♥","♦"]);
function randomHandKey(): ComboKey {
  const i = Math.floor(Math.random()*RANKS.length);
  const j = Math.floor(Math.random()*RANKS.length);
  if (i===j) return (RANKS[i]+RANKS[j]) as ComboKey;
  const suited = Math.random()<0.5;
  const [hi, lo] = i<j ? [RANKS[i], RANKS[j]] : [RANKS[j], RANKS[i]];
  return `${hi}${lo}${suited?"s":"o"}` as ComboKey;
}
function splitToCards(k: ComboKey){
  const r1 = k[0], r2 = k[1], t = k[2];
  if (r1 === r2) return [{ rank: r1, suit: '♠' as const }, { rank: r2, suit: '♥' as const }];
  if (t === 's')  return [{ rank: r1, suit: '♠' as const }, { rank: r2, suit: '♠' as const }];
  return [{ rank: r1, suit: '♠' as const }, { rank: r2, suit: '♥' as const }];
}
// Cartes héros : rang + symbole de couleur (♥♦ en rouge, ♠♣ en sombre)
const RED_SUITS = new Set(["♥","♦"]);

function HoleCards({ combo }: { combo: ComboKey }) {
  const [c1, c2] = splitToCards(combo);
  return (
    <div className="flex items-center gap-1.5 sm:gap-3">
      {[c1, c2].map((c, idx) => (
        <div
          key={idx}
          className="w-11 h-16 sm:w-16 sm:h-24 rounded-2xl border shadow-sm bg-white flex flex-col items-center justify-center"
        >
          <div className={`text-xl sm:text-3xl font-bold ${RED.has(c.suit) ? "text-red-600" : "text-slate-800"}`}>{c.rank}</div>
          <div className={`text-base sm:text-xl ${RED.has(c.suit) ? "text-red-600" : "text-slate-800"}`}>{c.suit}</div>
        </div>
      ))}
    </div>
  );
}
function DealerChip(){ return <span className="inline-flex items-center justify-center rounded-full bg-amber-300 text-amber-900 text-[10px] font-bold w-6 h-6 shadow">D</span>; }
function SeatBadge({ p, mode }: { p: Position; mode: TableMode }){
  const isBtn = (mode === 'HU' && p === 'SB') || (mode === '3MAX' && p === 'BTN');
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-slate-700 text-white border border-slate-600">
        {mode === 'HU' && p === 'SB' ? 'SB (BTN)' : p}
      </span>
      {isBtn && <DealerChip />}
    </div>
  );
}
function ActionPill({ label, action, dimmed, step }:{
  label:string; action:typeof DECISION_ACTIONS[number] | '—'; dimmed?:boolean; step?:number
}){
  const base = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border shadow-sm';
  const map: Record<string,string> = {
    FOLD:'bg-slate-200 text-slate-800 border-slate-300',
    CALL:'bg-yellow-200 text-yellow-900 border-yellow-300',
    RAISE:'bg-orange-300 text-orange-900 border-orange-400',
    SHOVE:'bg-green-300 text-green-900 border-green-400',
    '—':'bg-slate-100 text-slate-500 border-slate-200'
  };
  return (
    <span className={`${base} ${map[action]||map['—']} ${dimmed?'opacity-60':''}`}>
      {step ? <span className="inline-flex items-center justify-center w-4 h-4 text-[9px] rounded-full bg-black/20 text-white">{step}</span> : null}
      <span>{label}</span>
    </span>
  );
}
const prettyAction = (p: Position, mode: TableMode, h: HistoryState): {label:string, action:typeof DECISION_ACTIONS[number] | '—'} => {
  const a = h[p];
  if (!a) return {label:'—', action:'—'};
  if (mode==='HU' && p==='SB' && a==='CALL') return {label:'LIMP', action:'CALL'};
  return {label:String(a), action:a as any};
};

function getSeatLayout(mode: TableMode, hero: Position): Record<Position, React.CSSProperties> {
  const layout: Partial<Record<Position, React.CSSProperties>> = {};
  const bottomCenter: React.CSSProperties = { bottom: '6%', left: '50%', transform: 'translateX(-50%)' };
  if (mode === 'HU') {
    const opp = hero === 'SB' ? 'BB' : 'SB';
    layout[hero] = bottomCenter;
    layout[opp]  = { top: '12%', left: '50%', transform: 'translateX(-50%)' };
    (layout as any)['BTN'] = { display: 'none' };
    return layout as Record<Position, React.CSSProperties>;
  }
  const others = (["BTN","SB","BB"] as Position[]).filter(p => p !== hero);
  layout[hero] = bottomCenter;
  if (others[0]) layout[others[0]] = { top: '12%', left: '15%' };
  if (others[1]) layout[others[1]] = { top: '12%', right: '15%' };
  return layout as Record<Position, React.CSSProperties>;
}

function PokerTable({
  mode,
  hero,
  history,
  hand,
  depth,
}: {
  mode: TableMode
  hero: Position
  history: HistoryState
  hand: ComboKey
  depth: number
}) {
  const layout = getSeatLayout(mode, hero)
  const seats: Position[] = mode === "HU" ? (["SB", "BB"] as Position[]) : (["BTN", "SB", "BB"] as Position[])
  const order = seats
  const heroIdx = order.indexOf(hero)
  const others = seats.filter((s) => s !== hero)

  const leftForMobile = (p: Position) => {
    if (mode === "HU") return "50%"
    const i = others.indexOf(p)
    return i === 0 ? "28%" : "72%" // évite d’être rogné
  }

  return (
    <div className="w-full">
      <div className="relative mx-auto w-full max-w-full sm:max-w-3xl lg:max-w-4xl aspect-[4/3] sm:aspect-[16/9] lg:aspect-[2/1] rounded-[999px] bg-emerald-900/80 ring-2 sm:ring-4 ring-emerald-700/60 shadow-inner overflow-hidden px-2">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(255,255,255,0.08),rgba(0,0,0,0))]" />

        {seats.map((p) => {
          const style = layout[p] || {}
          if ((style as any).display === "none") return null

          const isHero = p === hero
          const { label, action } = prettyAction(p, mode, history)
          const step = order.indexOf(p) + 1
          const actedBeforeHero = order.indexOf(p) < heroIdx

          if (!isHero) {
            return (
              <React.Fragment key={p}>
                {/* Pastille compacte adversaire (mobile) */}
                <div
                  className="absolute sm:hidden"
                  style={{ top: "10%", left: leftForMobile(p), transform: "translateX(-50%)" }}
                >
                  <div className="rounded-full bg-slate-900/90 text-white border border-white/10 px-2 py-1 text-[11px] flex items-center gap-1">
                    <span className="font-semibold">{mode === "HU" && p === "SB" ? "SB (BTN)" : p}</span>
                    <ActionPill label={label} action={action} step={step} dimmed={!actedBeforeHero} />
                  </div>
                </div>

                {/* Desktop/tablette : en-tête uniquement (pas de cartes vilain) */}
                <div className="absolute z-10 hidden sm:block" style={style}>
                  <div className="w-[clamp(120px,16vw,180px)] rounded-2xl bg-slate-900/90 text-white border border-white/10 shadow-md p-2">
                    <div className="flex items-center justify-between gap-2 min-h-6">
                      <SeatBadge p={p} mode={mode} />
                      <ActionPill label={label} action={action} step={step} dimmed={!actedBeforeHero} />
                    </div>
                    <div className="mt-1 text-center select-none">
                      <span className="text-lg sm:text-xl font-extrabold leading-none">{depth}</span>
                      <span className="ml-1 text-sm sm:text-base font-extrabold leading-none">bb</span>
                    </div>
                  </div>
                </div>
              </React.Fragment>
            )
          }

          // HERO : pas d’en-tête → plus de “petit carré gris”
          return (
            <div key={p} className="absolute z-10" style={style}>
              <div className="w-[clamp(120px,44vw,200px)] sm:w-[clamp(140px,18vw,220px)] rounded-2xl bg-slate-900/90 text-white border border-white/10 shadow-md p-2 ring-2 ring-fuchsia-400/80">
                <div className="mt-1 flex justify-center">
                  <HoleCards combo={hand} />
                </div>
                <div className="mt-1 text-center select-none flex items-center justify-center gap-2">
                  <span className="px-2 py-0.5 text-[10px] font-semibold rounded bg-slate-700 text-white border border-slate-600">
                    {mode === "HU" && p === "SB" ? "SB (BTN)" : p}
                  </span>
                  <span className="text-xl sm:text-2xl font-extrabold leading-none">{depth}</span>
                  <span className="text-base sm:text-lg font-extrabold leading-none">bb</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}



// ── Account tab ───────────────────────────────────────────────────────────────
function pct(c?: Counter){ if (!c || c.total===0) return 0; return Math.round((100*c.correct)/c.total); }
function sumCounter(a?: Counter, b?: Counter): Counter {
  return { correct: (a?.correct||0) + (b?.correct||0), total: (a?.total||0) + (b?.total||0) };
}
const fmtDuration = (ms: number) => { const s = Math.max(0, Math.floor(ms/1000)); const m = Math.floor(s/60); const r = s%60; return `${m}m${r.toString().padStart(2,'0')}s`; };
const makeEmptySession = (): SessionStats => ({ active: true, startAt: Date.now(), overall:{correct:0,total:0}, byPosition:{}, byDepth:{}, byContext:{} });
const applyAttempt = (stats: SessionStats, pos: Position, depth: number, ctx: string, ok: boolean): SessionStats => {
  const inc = (c?: Counter): Counter => ({ correct:(c?.correct||0)+(ok?1:0), total:(c?.total||0)+1 });
  const key = ctx || 'Pot non ouvert';
  return {
    ...stats,
    overall:inc(stats.overall),
    byPosition:{...stats.byPosition,[pos]:inc(stats.byPosition[pos])},
    byDepth:{...stats.byDepth,[depth]:inc(stats.byDepth[depth])},
    byContext:{...stats.byContext,[key]:inc(stats.byContext[key])}
  };
};
const aggregateSessionsHistory = (list: SavedSession[]): SessionStats => {
  const agg = makeEmptySession(); agg.active = false;
  agg.startAt = list[0]?.startAt || Date.now(); agg.endAt = list[list.length-1]?.endAt;
  for (const s of list){
    agg.overall = sumCounter(agg.overall, s.overall);
    (["BTN","SB","BB"] as Position[]).forEach(p=> agg.byPosition[p] = sumCounter(agg.byPosition[p], s.byPosition[p]));
    Object.keys(s.byDepth||{}).forEach(k=>{ const d = Number(k); agg.byDepth[d] = sumCounter(agg.byDepth[d], s.byDepth[d]); });
    Object.entries(s.byContext||{}).forEach(([k,v])=> agg.byContext[k] = sumCounter(agg.byContext[k], v));
  }
  return agg;
};

function AccountTab({
  savedSessions, useAccountForRevision, setUseAccountForRevision, currentMode
}:{ savedSessions: SavedSession[]; useAccountForRevision: boolean; setUseAccountForRevision: (v:boolean)=>void; currentMode: TableMode; }){
  const [filterMode, setFilterMode] = useState<'ALL' | TableMode>(currentMode);
  const list = (savedSessions || []).filter(s => filterMode === 'ALL' ? true : (s.mode ? s.mode === filterMode : false));

  if (!list.length){
    return (
      <Card>
        <CardHeader className="pb-2"><CardTitle>Compte · Statistiques sauvegardées</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <Label>Filtre</Label>
            <Select value={filterMode} onValueChange={(v)=>setFilterMode(v as any)}>
              <SelectTrigger className="w-36"><SelectValue placeholder="Filtre"/></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Tous modes</SelectItem>
                <SelectItem value="3MAX">3-max</SelectItem>
                <SelectItem value="HU">Heads-Up</SelectItem>
              </SelectContent>
            </Select>
          </div>
          Aucun historique pour ce filtre.
        </CardContent>
      </Card>
    );
  }

  const agg = aggregateSessionsHistory(list);
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle>Compte · Statistiques sauvegardées</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex items-center gap-2">
          <Label>Filtre</Label>
          <Select value={filterMode} onValueChange={(v)=>setFilterMode(v as any)}>
            <SelectTrigger className="w-36"><SelectValue placeholder="Filtre"/></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Tous modes</SelectItem>
              <SelectItem value="3MAX">3-max</SelectItem>
              <SelectItem value="HU">Heads-Up</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span>Précision: <b>{pct(agg.overall)}%</b> ({agg.overall.correct}/{agg.overall.total})</span>
          <span>Sessions: <b>{list.length}</b></span>
        </div>

        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          {["BTN","SB","BB"].map(p=>{ const c = agg.byPosition[p as Position]; return (
            <div key={p} className="rounded-md border p-2 text-center">
              <div className="text-xs text-slate-500">{p}</div>
              <div className="text-base font-semibold">{pct(c)}%</div>
              <div className="text-[11px] text-slate-500">{c?.correct||0}/{c?.total||0}</div>
            </div>
          );})}
        </div>

        <div>
          <div className="font-semibold mb-1">Par profondeur</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2">
            {Object.keys(agg.byDepth)
              .sort((a,b)=>Number(b)-Number(a))
              .map(k=>{
                const d = Number(k);
                const c = agg.byDepth[d];
                return (
                  <div key={k} className="rounded-md border p-2 text-center">
                    <div className="text-xs text-slate-500">{d}bb</div>
                    <div className="text-base font-semibold">{pct(c)}%</div>
                    <div className="text-[11px] text-slate-500">{c?.correct||0}/{c?.total||0}</div>
                  </div>
                );
              })}
          </div>
        </div>

        <div>
          <div className="font-semibold mb-1">Par contexte (top 8)</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
            {Object.entries(agg.byContext)
              .sort((a,b)=> (b[1]?.total||0) - (a[1]?.total||0))
              .slice(0,8)
              .map(([k,c])=> (
                <div key={k} className="rounded-md border p-2">
                  <div className="text-xs text-slate-500 break-words">{k || 'Pot non ouvert'}</div>
                  <div className="text-base font-semibold">{pct(c)}%</div>
                  <div className="text-[11px] text-slate-500">{c?.correct||0}/{c?.total||0}</div>
                </div>
              ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Switch checked={useAccountForRevision} onCheckedChange={setUseAccountForRevision} />
          <span>Utiliser ces stats pour les révisions</span>
        </div>
      </CardContent>
    </Card>
  );
}

// ── 13×13 Range Grid ─────────────────────────────────────────────────────────
function actionToCellClass(a: typeof PAINT_ACTIONS[number]){
  switch(a){
    case "FOLD": return "bg-white text-slate-900 hover:brightness-95";
    case "CALL": return "bg-yellow-400/80 text-slate-900 hover:brightness-105";
    case "RAISE": return "bg-orange-500/80 text-white hover:brightness-110";
    case "RAISECALL": return "bg-red-700/80 text-white hover:brightness-110";
    case "SHOVE": return "bg-green-500/80 text-white hover:brightness-110";
    case "TIERSTACK": return "bg-sky-300/80 text-slate-900 hover:brightness-110";
  }
}
function RangeGrid({ map, onPaint, currentAction, disabled = false }:{ map: RangeMap; onPaint: (k: ComboKey, a: typeof PAINT_ACTIONS[number]) => void; currentAction: typeof PAINT_ACTIONS[number]; disabled?: boolean; }){
  const [isMouseDown, setIsMouseDown] = useState(false);
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full min-w-[520px] border-collapse text-[10px] sm:text-[12px]">
        <thead>
          <tr>
            <th className="sticky left-0 top-0 z-20 p-1 sm:p-2 text-left bg-white text-slate-900">\\</th>
            {RANKS.map((r)=>(<th key={r} className="p-1 sm:p-2 text-center sticky top-0 z-10 bg-white text-slate-900">{r}</th>))}
          </tr>
        </thead>
        <tbody onMouseLeave={()=>setIsMouseDown(false)}>
          {RANKS.map((r1,i)=> (
            <tr key={r1}>
              <th className="sticky left-0 z-10 p-1 sm:p-2 text-left bg-white text-slate-900">{r1}</th>
              {RANKS.map((r2,j)=>{
                let key: ComboKey; let label="";
                if(i===j){ key=(r1+r2) as ComboKey; label=key; }
                else if(i<j){ key=`${r1}${r2}s` as ComboKey; label=`${r1}${r2}s`; }
                else { key=`${r2}${r1}o` as ComboKey; label=`${r2}${r1}o`; }
                const a = map[key];
                return (
                  <td
                    key={label}
                    className={`p-1 sm:p-2 text-center select-none border ${disabled?"cursor-not-allowed opacity-60":"cursor-pointer"} ${actionToCellClass(a)}`}
                    onMouseDown={(e)=>{ if(disabled) return; e.preventDefault(); setIsMouseDown(true); onPaint(key, currentAction); }}
                    onMouseUp={()=>setIsMouseDown(false)}
                    onMouseEnter={()=>{ if(disabled) return; if(isMouseDown) onPaint(key, currentAction); }}
                    title={`${label}: ${a}`}
                  >
                    {label}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Small pickers ────────────────────────────────────────────────────────────
function HistoryPicker({actor, mode, history, setHistory}:{actor:Position; mode:TableMode; history:HistoryState; setHistory:(fn:(h:HistoryState)=>HistoryState)=>void}){
  const order = orderFor(mode); const idx = order.indexOf(actor); const prev = order.slice(0, idx);
  return (
    <div className="flex flex-wrap gap-2 sm:gap-3">
      {prev.map(p=> { const allowed = getAllowedHistoryActions(p as Position, actor, mode, history); return (
        <div key={p} className="flex items-center gap-1 sm:gap-2">
          <Label className="w-10 sm:w-12">{p}</Label>
          <div className="flex flex-wrap gap-1">
            {DECISION_ACTIONS.map(a=> (
              <Button key={a} size="sm" disabled={!allowed.includes(a as any)} variant={history[p]===a?"default":"outline"} className={history[p]===a?"":"bg-white text-slate-900 hover:bg-white/90 hover:text-slate-900 border-slate-300"} onClick={()=>{ if (!allowed.includes(a as any)) return; setHistory(h=>({...h,[p]:h[p]===a?null:a})) }}>{a}</Button>
            ))}
          </div>
        </div>
      ); })}
    </div>
  );
}

function DepthSelector({
  depths,
  active,
  setActive,
}: {
  depths: number[];
  active: number;
  setActive: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Label>Profondeur</Label>
      <div className="flex flex-wrap gap-2">
        {depths.map((d) => {
          const isActive = d === active;
          return (
            <Button
              key={d}
              size="sm"
              variant={isActive ? "default" : "outline"}
              // ✅ make outline chips readable on white background
              className={
                isActive
                  ? undefined
                  : "bg-white text-slate-900 hover:bg-white/90 hover:text-slate-900 border-slate-300"
              }
              onClick={() => setActive(d)}
            >
              {d}bb
            </Button>
          );
        })}
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────
export default function SpinRangeTrainer(){
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [mode, setMode] = useState<TableMode>("3MAX");
  const [depths, setDepths] = useState<number[]>(DEFAULT_DEPTHS);
  const [activeDepth, setActiveDepth] = useState<number>(15);
  const [position, setPosition] = useState<Position>("BTN");
  const [history, setHistory] = useState<HistoryState>({});
  const [autoHistory, setAutoHistory] = useState<boolean>(true);
  const [rangesByMode, setRangesByMode] = useState<RangesByMode>(()=>({}));
  const [paintAction, setPaintAction] = useState<typeof PAINT_ACTIONS[number]>("RAISE");
  const [showRange, setShowRange] = useState(false);
  const [hand, setHand] = useState<ComboKey>('AA');
  const [modeRandom, setModeRandom] = useState<boolean>(true);
  const [score, setScore] = useState({ok:0, total:0});

  // erreurs & rapport
  const [lastMistake, setLastMistake] = useState<MistakeSnapshot>(null);
  const [showReport, setShowReport] = useState<boolean>(false);

  const [session, setSession] = useState<SessionStats>(makeEmptySession());
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const [useAccountForRevision, setUseAccountForRevision] = useState<boolean>(true);
  const [trainingMode, setTrainingMode] = useState<TrainingMode>('standard');
  
  // Copie de ranges (UI)
  const [copyFromDepth, setCopyFromDepth] = useState<number>(activeDepth);
  const [copyToDepth, setCopyToDepth] = useState<number>(
  depths.find((d) => d !== activeDepth) ?? activeDepth
  );
  const [copyOnlyCurrentContext, setCopyOnlyCurrentContext] = useState(true);
  const [copyReplace, setCopyReplace] = useState(false);

  // Load/Save
  useEffect(()=>{ try{ const raw = localStorage.getItem(STORAGE_KEY); if (raw){ const data = JSON.parse(raw); if (data?.rangesByMode) setRangesByMode(data.rangesByMode as RangesByMode); if (Array.isArray(data?.depths) && data.depths.length) setDepths(data.depths as number[]); } } catch{} }, []);
  useEffect(()=>{ try{ localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, rangesByMode, depths })); } catch{} }, [rangesByMode, depths]);
  useEffect(()=>{ try{ const raw = localStorage.getItem(SESSIONS_KEY); if (raw) setSavedSessions(JSON.parse(raw)); } catch{} }, []);
  useEffect(()=>{ try{ localStorage.setItem(SESSIONS_KEY, JSON.stringify(savedSessions)); } catch{} }, [savedSessions]);

  useEffect(()=>{ const id = setTimeout(()=>nextHand(), 0); return ()=>clearTimeout(id); }, []);
  useEffect(()=>{ ensureActiveStructures(); }, [mode, activeDepth, position, history]);
  useEffect(()=>{ const allowed = getAllowedPaintActions(position, mode, history) as readonly string[]; if (!(allowed as any).includes(paintAction)) setPaintAction(allowed[0] as any); }, [position, mode, history]);

// ── Copier les ranges entre profondeurs ──────────────────────────────────────
function copyRangesBetweenDepths() {
  const from = copyFromDepth;
  const to = copyToDepth;
  if (from == null || to == null) {
    toast.error("Choisis des profondeurs source et cible.");
    return;
  }
  if (from === to) {
    toast.message("Même profondeur : rien à copier.");
    return;
  }

  const fromKey: DepthKey = `${from}bb`;
  const toKey: DepthKey = `${to}bb`;

  setRangesByMode(prev => {
    const next: RangesByMode = { ...(prev || {}) };
    const srcAllDepths = next[mode]?.[fromKey];
    if (!srcAllDepths) {
      toast.error(`Aucune range à ${from}bb pour ${mode}.`);
      return prev;
    }

    // Prépare destination
    next[mode] = next[mode] || {};
    const dstAllDepths = (next[mode]![toKey] = next[mode]![toKey] || {});

    const positionsPool: Position[] = mode === "HU" ? (["SB","BB"] as Position[]) : (["BTN","SB","BB"] as Position[]);
    const positionsToCopy: Position[] = [position];
    // (si tu veux copier TOUTES les positions quand "Seulement contexte" est OFF,
    // remplace la ligne au-dessus par: const positionsToCopy = copyOnlyCurrentContext ? [position] : positionsPool;

    for (const pos of positionsToCopy) {
      const srcByCtx = srcAllDepths[pos];
      if (!srcByCtx) continue;

      dstAllDepths[pos] = dstAllDepths[pos] || {};

      if (copyOnlyCurrentContext) {
        const ctx = makeContextKey(history, pos, mode);
        const srcMap = srcByCtx[ctx];
        if (!srcMap) continue;
        dstAllDepths[pos]![ctx] = mergeRangeMaps(dstAllDepths[pos]![ctx], srcMap, copyReplace);
      } else {
        // toutes les ranges de la position (tous contextes)
        for (const [ctx, srcMap] of Object.entries(srcByCtx)) {
          dstAllDepths[pos]![ctx] = mergeRangeMaps(dstAllDepths[pos]![ctx], srcMap, copyReplace);
        }
      }
    }

    return next;
  });

  toast.success(
    `${copyOnlyCurrentContext ? "Contexte" : "Position"} copié(e) ${from}bb → ${to}bb`
  );
}

  function ensureActiveStructures(){ const dk: DepthKey = `${activeDepth}bb`; const ctx = contextKey(); const { valid } = isContextValid(position, mode, history); if (!valid) return; setRangesByMode(prev=>{ const copy: RangesByMode = { ...(prev||{}) }; copy[mode] = copy[mode] || {}; const r = copy[mode]!; r[dk] = r[dk] || {}; r[dk]![position] = r[dk]![position] || {}; r[dk]![position]![ctx] = r[dk]![position]![ctx] || emptyRangeMap(); return copy; }); }
  function contextKey(){ return makeContextKey(history, position, mode); }
  const activeMap: RangeMap | undefined = useMemo(()=>{ const dk: DepthKey = `${activeDepth}bb`; return rangesByMode[mode]?.[dk]?.[position]?.[contextKey()]; }, [rangesByMode, mode, activeDepth, position, history]);

  function paint(key: ComboKey, a: typeof PAINT_ACTIONS[number]){ const dk: DepthKey = `${activeDepth}bb`; const ctx = contextKey(); setRangesByMode(prev => ({ ...(prev||{}), [mode]: { ...(prev?.[mode]||{}), [dk]: { ...((prev?.[mode]?.[dk])||{}), [position]: { ...((prev?.[mode]?.[dk]?.[position])||{}), [ctx]: { ...((prev?.[mode]?.[dk]?.[position]?.[ctx])||emptyRangeMap()), [key]: a } } } } })); }

  const normalize = (a?: typeof PAINT_ACTIONS[number]) => (!a ? 'FOLD' : (a === 'RAISECALL' ? 'RAISE' : a)) as typeof DECISION_ACTIONS[number];
  function getCorrectActionForCurrentHand(){ const correctPaint = activeMap ? activeMap[hand] : 'FOLD'; let ans = normalize(correctPaint); if (hasShoveBefore(position, mode, history)){ if (ans === 'RAISE' || ans === 'TIERSTACK' || ans === 'SHOVE') ans = 'CALL'; } return ans; }

  function nextHand(){ const pickRandom = () => { let newPos: Position = position; let newDepth = activeDepth; if (modeRandom){ const positionsPool = mode === "HU" ? POSITIONS_HU : POSITIONS_3MAX; newPos = positionsPool[Math.floor(Math.random()*positionsPool.length)] as Position; newDepth = depths[Math.floor(Math.random()*depths.length)]; } const h = autoHistory ? generateRandomHistory(newPos, mode) : history; return { newPos, newDepth, h }; }; const { newPos, newDepth, h } = pickRandom(); setPosition(newPos); setActiveDepth(newDepth); if (autoHistory) setHistory(h); setShowRange(false); setHand(randomHandKey()); }

  function answer(a: typeof DECISION_ACTIONS[number]){
    const correct = getCorrectActionForCurrentHand();
    const isOk = a === correct;
    setSession(prev => applyAttempt(prev, position, activeDepth, contextKey(), isOk));
    setScore(s => ({ ok: s.ok + (isOk?1:0), total: s.total + 1 }));
    if (!isOk){
      const snap: Exclude<MistakeSnapshot, null> = { mode, position, depth: activeDepth, history: { ...history }, hand, correct, contextKey: contextKey(), map: activeMap ? { ...activeMap } : undefined };
      setLastMistake(snap);
      toast.error("✘ Correct: "+correct);
    } else {
      toast.success("✔ Correct");
    }
    nextHand();
  }
  function verify(){ const correct = getCorrectActionForCurrentHand(); toast.message('Action correcte pour cette main: '+correct); setShowRange(true); }
  const resetScore = () => setScore({ok:0,total:0});

  // Clôture et rapport de session
  function closeAndSaveSession(){
    const ended: SavedSession = { id: String(Date.now()), ...session, active: false, endAt: Date.now(), mode } as SavedSession;
    setSavedSessions(list => [...list, ended]);
    setSession(prev => ({ ...prev, active:false, endAt: ended.endAt }));
    setShowReport(true);
    toast.success('Session clôturée');
  }
  function startNewSession(){ setSession(makeEmptySession()); setScore({ok:0,total:0}); setShowReport(false); setLastMistake(null); toast.message('Nouvelle session'); }
  function replayMistake(){ if (!lastMistake) return; setMode(lastMistake.mode); setPosition(lastMistake.position); setActiveDepth(lastMistake.depth); setHistory(lastMistake.history); setHand(lastMistake.hand); setShowRange(true); setLastMistake(null); }

  function handleExport(){ try{ const blob = new Blob([JSON.stringify({ version:2, rangesByMode, depths }, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `spinango-ranges-${Date.now()}.json`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); toast.success('Export JSON prêt'); } catch{ toast.error('Échec export JSON'); } }
  const handleImportClick = () => fileInputRef.current?.click();
  async function onFileSelected(e: React.ChangeEvent<HTMLInputElement>){ const file = e.target.files?.[0]; if (!file) return; try{ const text = await file.text(); const data = JSON.parse(text); if (!data || typeof data !== 'object') throw new Error('Fichier invalide'); if (data.rangesByMode) setRangesByMode(data.rangesByMode as RangesByMode); else if (data.ranges) setRangesByMode({ "3MAX": data.ranges as Ranges }); if (Array.isArray(data.depths) && data.depths.length) setDepths(data.depths as number[]); toast.success('Import réussi'); } catch{ toast.error('Import invalide'); } finally { if (e.target) e.target.value = ''; } }

  function generateRandomHistory(actor: Position, m: TableMode): HistoryState {
    const pick = <T,>(items: [T, number][]): T => {
      const s = items.reduce((a, [,p])=>a+p, 0);
      let r = Math.random()*s;
      for (const [v,p] of items){ if ((r-=p) <= 0) return v; }
      return items[0][0];
    };
    const h: HistoryState = {};
    if (m === 'HU'){
      if (actor === 'SB') return h;
      const sb = pick<any>([['CALL', 0.45],['RAISE', 0.5],['SHOVE', 0.05]]);
      h.SB = sb; return h;
    }
    if (actor === 'BTN') return h;
    if (actor === 'SB'){
      const btn = pick<any>([['FOLD', 0.35],['RAISE', 0.55],['SHOVE', 0.10]]);
      h.BTN = btn; return h;
    }
    const btn = pick<any>([['FOLD', 0.25],['RAISE', 0.6],['SHOVE', 0.15]]);
    h.BTN = btn; let sb: any;
    if (btn === 'FOLD') sb = pick<any>([['CALL', 0.25],['RAISE', 0.55],['SHOVE', 0.20]]);
    else sb = pick<any>([['FOLD', 0.5],['CALL', 0.3],['RAISE', 0.15],['SHOVE', 0.05]]);
    h.SB = sb; return h;
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const { valid: isCtxValid, reason: ctxReason } = isContextValid(position, mode, history);
  const posOptions: readonly Position[] = mode === "HU" ? POSITIONS_HU : POSITIONS_3MAX;
  const posLabel = (p: Position) => (mode === "HU" && p === 'SB') ? 'SB (BTN)' : p;

  return (
    <div className="mx-auto max-w-6xl p-4 space-y-4">
      {/* Header */}
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-indigo-500 to-fuchsia-500 bg-clip-text text-transparent">Spinango – Preflop Trainer</h1>
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold px-2 py-1 rounded-full bg-slate-900/80 text-white">{mode === 'HU' ? 'HU' : '3-max'}</span>
          <span className="text-sm font-semibold text-white px-3 py-1 rounded-full bg-slate-900/80">{activeDepth}bb</span>
        </div>
      </div>

      {/* Mode switch */}
      <div className="flex items-center gap-2">
        <Label>Mode</Label>
        <Tabs value={mode} onValueChange={(v)=>{ const newMode = v as TableMode; setMode(newMode); const pool: readonly Position[] = newMode === "HU" ? POSITIONS_HU : POSITIONS_3MAX; if (!pool.includes(position)) { setPosition(newMode === "HU" ? "SB" : "BTN"); setHistory({}); } setShowRange(false); }}>
          <TabsList>
            <TabsTrigger value="3MAX">3-max</TabsTrigger>
            <TabsTrigger value="HU">Heads-Up</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <Tabs defaultValue="trainer">
        <TabsList>
          <TabsTrigger value="trainer">Session</TabsTrigger>
          <TabsTrigger value="editor">Éditeur</TabsTrigger>
          <TabsTrigger value="options">Options</TabsTrigger>
          <TabsTrigger value="account">Compte</TabsTrigger>
        </TabsList>

        {/* SESSION */}
        <TabsContent value="trainer">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2"><CardTitle>Session</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                {/* Bandeau de réglages */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {/* Bloc 1 */}
                  <div className="rounded-lg border bg-white/60 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Label>Position</Label>
                      <Select value={position} onValueChange={(v)=>setPosition(v as Position)}>
                        <SelectTrigger className="w-28 sm:w-32"><SelectValue placeholder="Position"/></SelectTrigger>
                        <SelectContent>{posOptions.map(p=> <SelectItem key={p} value={p as any}>{posLabel(p as Position)}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-2">
                      <Label>Profondeur</Label>
                      <Select value={String(activeDepth)} onValueChange={(v)=>setActiveDepth(parseInt(v,10))}>
                        <SelectTrigger className="w-20 sm:w-24"><SelectValue placeholder="bb"/></SelectTrigger>
                        <SelectContent>{depths.map(d=> <SelectItem key={d} value={String(d)}>{d}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Bloc 2 */}
                  <div className="rounded-lg border bg-white/60 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Label>Entraînement</Label>
                      <Select value={trainingMode} onValueChange={(v)=>setTrainingMode(v as TrainingMode)}>
                        <SelectTrigger className="w-48"><SelectValue placeholder="Mode"/></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="standard">Standard (tirage uniforme)</SelectItem>
                          <SelectItem value="spaced">Révision espacée (surreprésente les spots ratés)</SelectItem>
                          <SelectItem value="difficult_only">Spots difficiles (uniquement &lt;70%)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="text-xs text-muted-foreground"><b>Révision espacée</b> : revoit plus souvent les contextes où tu t'es trompé(e). Option «Compte» pondère avec tes stats sauvegardées.</div>
                    <div className="flex items-center gap-2">
                      <Switch checked={useAccountForRevision} onCheckedChange={setUseAccountForRevision} />
                      <span className="text-xs">Pondérer avec «Compte»</span>
                    </div>
                  </div>

                  {/* Bloc 3 */}
                  <div className="rounded-lg border bg-white/60 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Label>Historique auto</Label>
                      <Switch checked={autoHistory} onCheckedChange={(v)=>{ setAutoHistory(!!v); if (v) setHistory(generateRandomHistory(position, mode)); }} />
                    </div>
                    <div className="flex items-center gap-2">
                      <Label>Aléa pos/depth</Label>
                      <Switch checked={modeRandom} onCheckedChange={setModeRandom}/>
                    </div>
                  </div>
                </div>

                {/* Contexte + table */}
                <div className="space-y-2">
                  <PokerTable mode={mode} hero={position} history={history} hand={hand} depth={activeDepth} />
                </div>

                {/* Actions */}
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                  {getAllowedDecisionActions(position, mode, history).map(a => (
                    <Button key={a} variant={'outline'} onClick={()=>answer(a as any)}>{a}</Button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={verify}><CheckCircle2 className="mr-2 h-4 w-4"/>Vérifier & ouvrir la range</Button>
                  <Button variant="outline" onClick={nextHand}><Shuffle className="mr-2 h-4 w-4"/>Main suivante</Button>
                  <Button variant="ghost" onClick={resetScore}><ListChecks className="mr-2 h-4 w-4"/>Reset score</Button>
                </div>

                {/* Popup erreur (dernière main) */}
                {lastMistake && (
                  <Card className="mt-3 border-amber-300">
                    <CardHeader className="pb-1"><CardTitle className="text-base">Tu t'es trompé·e</CardTitle></CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span><b>Correct:</b> {lastMistake.correct}</span>
                        <span>• <b>Position:</b> {(lastMistake.mode==='HU'&&lastMistake.position==='SB')?'SB (BTN)':lastMistake.position}</span>
                        <span>• <b>Stack:</b> {lastMistake.depth}bb</span>
                        <span>• <b>Contexte:</b> {lastMistake.contextKey || 'Pot non ouvert'}</span>
                      </div>
                      {lastMistake.map ? (
                        <RangeGrid map={lastMistake.map} onPaint={()=>{}} currentAction={'FOLD' as any} disabled />
                      ) : (
                        <div className="text-xs text-muted-foreground">Aucune range enregistrée pour ce contexte.</div>
                      )}<div className="flex gap-2">
                        <Button size="sm" onClick={replayMistake}>Rejouer le spot</Button>
                        <Button size="sm" variant="outline" onClick={()=>setLastMistake(null)}>Fermer</Button>
                      </div>
                    </CardContent>
                  </Card>
                )}

               {/* Score + actions de session */}
<div className="flex flex-wrap items-center gap-2 text-sm">
  <span>
    Score: <span className="font-semibold">{score.ok}/{score.total}</span>{" "}
    ({score.total ? Math.round((100 * score.ok) / score.total) : 0}%)
  </span>
  <Button size="sm" variant="outline" onClick={closeAndSaveSession}>Clôturer la session</Button>
  <Button size="sm" variant="ghost" onClick={startNewSession}>Nouvelle session</Button>
</div>

{/* Rapport de session */}
{showReport && (
  <Card className="mt-3">
    <CardHeader className="pb-2">
      <CardTitle>Rapport de session</CardTitle>
    </CardHeader>
    <CardContent className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span>
          Durée: <b>{session.endAt ? fmtDuration(session.endAt - session.startAt) : "—"}</b>
        </span>
        <span>
          Global: <b>{pct(session.overall)}%</b> ({session.overall.correct}/{session.overall.total})
        </span>
      </div>

      <div>
        <div className="font-semibold mb-1">Par position</div>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          {(["BTN", "SB", "BB"] as Position[]).map((p) => {
            const c = session.byPosition[p];
            return (
              <div key={p} className="rounded-md border p-2 text-center">
                <div className="text-xs text-slate-500">{p}</div>
                <div className="text-base font-semibold">{pct(c)}%</div>
                <div className="text-[11px] text-slate-500">{c?.correct || 0}/{c?.total || 0}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <div className="font-semibold mb-1">Par profondeur</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2">
          {Object.keys(session.byDepth)
            .sort((a, b) => Number(b) - Number(a))
            .map((k) => {
              const d = Number(k);
              const c = session.byDepth[d];
              return (
                <div key={k} className="rounded-md border p-2 text-center">
                  <div className="text-xs text-slate-500">{d}bb</div>
                  <div className="text-base font-semibold">{pct(c)}%</div>
                  <div className="text-[11px] text-slate-500">{c.correct}/{c.total}</div>
                </div>
              );
            })}
        </div>
      </div>

      <div>
        <div className="font-semibold mb-1">Par contexte (top 8)</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
          {Object.entries(session.byContext)
            .sort((a, b) => b[1].total - a[1].total)
            .slice(0, 8)
            .map(([k, c]) => (
              <div key={k} className="rounded-md border p-2">
                <div className="text-xs text-slate-500 break-words">{k || "Pot non ouvert"}</div>
                <div className="text-base font-semibold">{pct(c)}%</div>
                <div className="text-[11px] text-slate-500">{c.correct}/{c.total}</div>
              </div>
            ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => setShowReport(false)}>Masquer</Button>
        <Button size="sm" variant="secondary" onClick={startNewSession}>Nouvelle session</Button>
      </div>
    </CardContent>
  </Card>
)}

</CardContent>
</Card>
</div>
</TabsContent>

        {/* EDITEUR */}
        <TabsContent value="editor">
          <div className="space-y-3">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <DepthSelector depths={depths} active={activeDepth} setActive={setActiveDepth} />
                <Select value={position} onValueChange={(v)=>setPosition(v as Position)}>
                  <SelectTrigger className="w-36"><SelectValue placeholder="Position"/></SelectTrigger>
                  <SelectContent>
                    {posOptions.map(p=> <SelectItem key={p} value={p as any}>{posLabel(p as Position)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              {/* Contexte (picker) */}
              <div className="rounded-xl border p-3 space-y-2 bg-slate-400/50">
                <div className="flex items-center gap-2 flex-wrap">
                  <Label>Contexte</Label>
                  <div className="flex flex-col gap-2">
                    <div className="text-[12px] text-slate-700">
                      Sélectionne les actions déjà jouées avant {position}
                    </div>
                    <HistoryPicker
                      actor={position}
                      mode={mode}
                      history={history}
                      setHistory={setHistory}
                    />
                  </div>
                </div>
                              </div>
{/* Copie rapide entre profondeurs (dans l'éditeur) */}
<div className="rounded-xl border p-3 space-y-3 bg-slate-400/50">
  <div className="text-base font-semibold">
    Copier <b>{position}</b> (mode <b>{mode}</b>) de
  </div>

  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
    {/* From depth */}
    <div className="flex items-center gap-2">
      <Label className="w-20">de</Label>
      <Select
        value={String(copyFromDepth)}
        onValueChange={(v) => setCopyFromDepth(parseInt(v, 10))}
      >
        <SelectTrigger className="w-24"><SelectValue placeholder="bb" /></SelectTrigger>
        <SelectContent>
          {depths.map((d) => (
            <SelectItem key={d} value={String(d)}>{d}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>

    {/* To depth */}
    <div className="flex items-center gap-2">
      <Label className="w-20">à</Label>
      <Select
        value={String(copyToDepth)}
        onValueChange={(v) => setCopyToDepth(parseInt(v, 10))}
      >
        <SelectTrigger className="w-24"><SelectValue placeholder="bb" /></SelectTrigger>
        <SelectContent>
          {depths.map((d) => (
            <SelectItem key={d} value={String(d)}>{d}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>

    {/* Bouton */}
    <div className="flex items-center">
      <Button onClick={copyRangesBetweenDepths} disabled={copyFromDepth === copyToDepth}>
        Appliquer
      </Button>
    </div>
  </div>

  <div className="flex flex-wrap items-center gap-6">
    <label className="flex items-center gap-2 text-sm">
      <Switch checked={copyOnlyCurrentContext} onCheckedChange={setCopyOnlyCurrentContext} />
      <span>Seulement contexte actuel</span>
    </label>

    <label className="flex items-center gap-2 text-sm">
      <Switch checked={copyReplace} onCheckedChange={setCopyReplace} />
      <span>Remplacer (sinon complète les FOLD)</span>
    </label>
  </div>

  <div className="text-xs text-slate-700">
    Astuce : pour propager rapidement, répète l’opération (ex : 25→24, puis 24→23 …).<br/>
    «Remplacer» écrase ; sinon, seules les cases FOLD/manquantes sont complétées.
  </div>
</div>

              {/* Bloc PEINDRE */}
              <div className="rounded-xl border p-3 space-y-2 bg-white/60">
                <div className="flex items-center gap-2 flex-wrap">
                  <Label>Peindre</Label>
                  <div className="flex flex-wrap gap-2">
                    {PAINT_ACTIONS.map(a=>{
                      const allowed = getAllowedPaintActions(position, mode, history) as readonly string[];
                      const disabled = !(allowed as any).includes(a);
                      return (
                        <Button
                          key={a}
                          size="sm"
                          disabled={disabled}
                          variant={paintAction===a?'default':'outline'}
                          className={paintAction===a?'':'bg-white text-slate-900'}
                          onClick={()=> setPaintAction(a)}
                        >
                          {a === 'RAISECALL' ? 'RAISE-CALL' : a}
                        </Button>
                      );
                    })}
                  </div>
                </div>

                {!isCtxValid && (
                  <div className="flex items-center gap-2 text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-sm">
                    <AlertTriangle className="h-4 w-4"/><span>{ctxReason}</span>
                  </div>
                )}

                {activeMap ? (
                  <RangeGrid map={activeMap} onPaint={paint} currentAction={paintAction} disabled={!isCtxValid} />
                ) : (
                  <div className="text-sm text-muted-foreground">Aucune range définie pour ce contexte.</div>
                )}

                <div className="text-xs text-muted-foreground">
                  Légende – Fold: blanc; Call: jaune (Limp si SB HU unopened); Raise: orange vif; Raise-Call: rouge foncé; Shove: vert vif; Tierstack: bleu ciel.
                </div>
              </div>
            </div>
          </div>
        </TabsContent>

        {/* OPTIONS */}
        <TabsContent value="options">
          <Card>
            <CardHeader className="pb-2"><CardTitle>Options</CardTitle></CardHeader>
            <CardContent className="space-y-4">

              <div className="space-y-2">
                <Label>Profondeurs actives (séparées par des virgules)</Label>
                <Input
                  value={depths.join(',')}
                  onChange={(e)=>{
                    const arr = e.target.value.split(',').map(x=>parseInt(x.trim(),10)).filter(n=>!isNaN(n));
                    setDepths(arr);
                    if (!arr.includes(activeDepth) && arr.length){ setActiveDepth(arr[0]); }
                  }}
                  placeholder="25,24,23,...,5"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={handleExport}>Exporter JSON</Button>
                <Button size="sm" variant="secondary" onClick={handleImportClick}>Importer JSON (remplacer)</Button>
                <input ref={fileInputRef} type="file" accept="application/json" hidden onChange={onFileSelected} />
                <span className="text-xs text-muted-foreground">Autosave activé (localStorage). Export/Import incluent 3MAX &amp; HU.</span>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="account">
  <AccountTab
    savedSessions={savedSessions}
    useAccountForRevision={useAccountForRevision}
    setUseAccountForRevision={setUseAccountForRevision}
    currentMode={mode}
  />
</TabsContent>

</Tabs>
</div>
);
}


// Dev sanity tests (non-blocking)
if (typeof window !== 'undefined') {
  console.assert(allCombos.length === 169, 'allCombos should be 169, got', allCombos.length);
  const em = emptyRangeMap();
  console.assert(em['AA'] === 'FOLD' && em['AKs'] === 'FOLD', 'emptyRangeMap default FOLD');
  const ctx = makeContextKey({ BTN:'RAISE', SB:'CALL' } as any, 'BB', '3MAX');
  console.assert(ctx === 'BTN:RAISE,SB:CALL', 'makeContextKey failed', ctx);
  const onlyCallFold = getAllowedDecisionActions('BB','3MAX',{ BTN:'SHOVE' });
  console.assert(onlyCallFold.length===2 && onlyCallFold.includes('CALL') && onlyCallFold.includes('FOLD'), 'allowed actions after shove failed');
}
