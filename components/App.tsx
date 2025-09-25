"use client";
import React, { useEffect, useMemo, useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"; // ← fix import
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Shuffle, ListChecks, CheckCircle2 } from "lucide-react";

/**
 * Spinango – Spin & Go Preflop Trainer
 * 3-max (BTN/SB/BB)  ➕ Heads-Up (SB(BTN) / BB)
 */

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

const DEFAULT_DEPTHS = Array.from({length: 21}, (_,i) => 25 - i).filter(d => d >= 5);

type Rank = typeof RANKS[number];

export type ComboKey = string; // "AKs" | "AQo" | "TT"
export type RangeMap = Record<ComboKey, PaintAction>;
export type DepthKey = `${number}bb`;

export type Ranges = {
  [depth in DepthKey]?: {
    [pos in Position]?: {
      [contextKey: string]: RangeMap
    }
  }
}
export type RangesByMode = Partial<Record<TableMode, Ranges>>;

export type HistoryState = Partial<Record<Position, DecisionAction | null>>;

// ---- utils mains
const comboKey = (r1: Rank, r2: Rank, suited: boolean): ComboKey => {
  if (r1 === r2) return (r1 + r2) as ComboKey; // pair
  const [hi, lo] = RANKS.indexOf(r1) < RANKS.indexOf(r2) ? [r1, r2] : [r2, r1];
  return `${hi}${lo}${suited ? "s" : "o"}` as ComboKey;
};

const allCombos: ComboKey[] = (() => {
  const keys: ComboKey[] = [];
  for (let i = 0; i < RANKS.length; i++) {
    for (let j = 0; j < RANKS.length; j++) {
      if (i === j) {
        keys.push((RANKS[i] + RANKS[j]) as ComboKey);
      } else if (i < j) {
        keys.push(`${RANKS[i]}${RANKS[j]}s` as ComboKey);
        keys.push(`${RANKS[i]}${RANKS[j]}o` as ComboKey);
      }
    }
  }
  return keys;
})();

function emptyRangeMap(): RangeMap {
  const m: RangeMap = {} as RangeMap;
  for (const c of allCombos) m[c] = "FOLD";
  return m;
}

// ordre d'action selon le mode
function orderFor(mode: TableMode): readonly Position[] {
  return mode === "HU" ? POSITIONS_HU : POSITIONS_3MAX;
}

// Contexte encodé
export function makeContextKey(history: HistoryState, actor: Position, mode: TableMode): string {
  const order = orderFor(mode);
  const idx = order.indexOf(actor);
  const prev = order.slice(0, idx);
  const parts: string[] = [];
  for (const p of prev){
    const a = history[p];
    if (a) parts.push(`${p}:${a}`);
  }
  return parts.join(","); // "" si pot non ouvert
}

// ---- cartes (UI)
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
  if (t === 's') return [{ rank: r1, suit: '♠' as const }, { rank: r2, suit: '♠' as const }];
  return [{ rank: r1, suit: '♠' as const }, { rank: r2, suit: '♥' as const }];
}

function HoleCards({combo}:{combo: ComboKey}){
  const [c1, c2] = splitToCards(combo);
  return (
    <div className="flex items-center gap-3">
      {[c1,c2].map((c,idx)=> (
        <div key={idx} className="w-16 h-24 rounded-2xl border shadow-sm bg-white flex flex-col items-center justify-center">
          <div className={`text-3xl font-bold ${RED.has(c.suit)?"text-red-600":"text-slate-800"}`}>{c.rank}</div>
          <div className={`text-xl ${RED.has(c.suit)?"text-red-600":"text-slate-800"}`}>{c.suit}</div>
        </div>
      ))}
    </div>
  );
}

// ---- grid 13×13
function actionToCellClass(a: PaintAction){
  switch(a){
    case "FOLD": return "bg-white text-slate-900 hover:brightness-95";
    case "CALL": return "bg-yellow-400/80 text-slate-900 hover:brightness-105";
    case "RAISE": return "bg-orange-500/80 text-white hover:brightness-110";
    case "RAISECALL": return "bg-red-700/80 text-white hover:brightness-110";
    case "SHOVE": return "bg-green-500/80 text-white hover:brightness-110";
    case "TIERSTACK": return "bg-sky-300/80 text-slate-900 hover:brightness-110";
  }
}

function RangeGrid({
  map,
  onPaint,
  currentAction,
}: {
  map: RangeMap;
  onPaint: (k: ComboKey, a: PaintAction) => void;
  currentAction: PaintAction;
}) {
  const [isMouseDown, setIsMouseDown] = useState(false);
  return (
    <div className="overflow-auto rounded-xl border">
      <table className="min-w-[820px] border-collapse text-[12px]">
        <thead>
          <tr>
            {/* en-tête coin gauche */}
            <th className="sticky left-0 top-0 z-20 p-2 text-left bg-white text-slate-900">\</th>
            {/* en-têtes colonnes A K Q J ... */}
            {RANKS.map((r) => (
              <th
                key={r}
                className="p-2 text-center sticky top-0 z-10 bg-white text-slate-900"
              >
                {r}
              </th>
            ))}
          </tr>
        </thead>
        <tbody onMouseLeave={() => setIsMouseDown(false)}>
          {RANKS.map((r1, i) => (
            <tr key={r1}>
              {/* en-têtes lignes */}
              <th className="sticky left-0 z-10 p-2 text-left bg-white text-slate-900">
                {r1}
              </th>

              {RANKS.map((r2, j) => {
                let key: ComboKey;
                let label = "";
                if (i === j) {
                  key = (r1 + r2) as ComboKey;
                  label = key;
                } else if (i < j) {
                  key = `${r1}${r2}s` as ComboKey;
                  label = `${r1}${r2}s`;
                } else {
                  key = `${r2}${r1}o` as ComboKey;
                  label = `${r2}${r1}o`;
                }
                const a = map[key];
                return (
                  <td
                    key={label}
                    className={`p-2 text-center cursor-pointer select-none border ${actionToCellClass(
                      a
                    )}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setIsMouseDown(true);
                      onPaint(key, currentAction);
                    }}
                    onMouseUp={() => setIsMouseDown(false)}
                    onMouseEnter={() => {
                      if (isMouseDown) onPaint(key, currentAction);
                    }}
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

// ---- main
export default function SpinRangeTrainer(){
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [mode, setMode] = useState<TableMode>("3MAX");
  const [depths, setDepths] = useState<number[]>(DEFAULT_DEPTHS);
  const [activeDepth, setActiveDepth] = useState<number>(15);

  const [position, setPosition] = useState<Position>("BTN");
  const [history, setHistory] = useState<HistoryState>({ BTN: null, SB: null, BB: null });
  const [autoHistory, setAutoHistory] = useState<boolean>(true);

  const [rangesByMode, setRangesByMode] = useState<RangesByMode>(()=>({}));

  const [paintAction, setPaintAction] = useState<PaintAction>("RAISE");
  const [showRange, setShowRange] = useState(false);

  const [hand, setHand] = useState<ComboKey>('AA');
  const [modeRandom, setModeRandom] = useState<boolean>(true);
  const [score, setScore] = useState({ok:0, total:0});

  // load/save
  useEffect(()=>{
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw){
        const data = JSON.parse(raw);
        if (data?.rangesByMode) setRangesByMode(data.rangesByMode as RangesByMode);
        if (Array.isArray(data?.depths) && data.depths.length) setDepths(data.depths as number[]);
      } else {
        const rawV1 = localStorage.getItem("spinango_state_v1");
        if (rawV1){
          const dataV1 = JSON.parse(rawV1);
          if (dataV1?.ranges){
            setRangesByMode({ "3MAX": dataV1.ranges as Ranges });
            toast.message("Migration des ranges v1 → v2 (3MAX)");
          }
          if (Array.isArray(dataV1?.depths) && dataV1.depths.length) setDepths(dataV1.depths as number[]);
        }
      }
    } catch(err){ console.error('Load state error', err); }
  }, []);

  useEffect(()=>{
    try{
      const payload = JSON.stringify({ version: 2, rangesByMode, depths });
      localStorage.setItem(STORAGE_KEY, payload);
    } catch(err){ console.error('Autosave error', err); }
  }, [rangesByMode, depths]);

  useEffect(() => {
    const id = setTimeout(() => nextHand(), 0);
    return () => clearTimeout(id);
  }, []);

  useEffect(()=>{ ensureActiveStructures(); }, [mode, activeDepth, position, history]);

  function ensureActiveStructures(){
    const dk: DepthKey = `${activeDepth}bb`;
    const ctx = contextKey();
    setRangesByMode(prev => {
      const copy: RangesByMode = { ...(prev||{}) };
      copy[mode] = copy[mode] || {};
      const r = copy[mode]!;
      r[dk] = r[dk] || {};
      r[dk]![position] = r[dk]![position] || {};
      r[dk]![position]![ctx] = r[dk]![position]![ctx] || emptyRangeMap();
      return copy;
    });
  }

  function contextKey(){ return makeContextKey(history, position, mode); }

  const activeMap: RangeMap | undefined = useMemo(()=>{
    const dk: DepthKey = `${activeDepth}bb`;
    return rangesByMode[mode]?.[dk]?.[position]?.[contextKey()];
  }, [rangesByMode, mode, activeDepth, position, history]);

  function paint(key: ComboKey, a: PaintAction){
    const dk: DepthKey = `${activeDepth}bb`;
    const ctx = contextKey();
    setRangesByMode(prev => ({
      ...(prev||{}),
      [mode]: {
        ...(prev?.[mode]||{}),
        [dk]: {
          ...((prev?.[mode]?.[dk])||{}),
          [position]: {
            ...((prev?.[mode]?.[dk]?.[position])||{}),
            [ctx]: {
              ...((prev?.[mode]?.[dk]?.[position]?.[ctx])||emptyRangeMap()),
              [key]: a
            }
          }
        }
      }
    }));
  }

  // decisions
  function normalizePaintToDecision(a: PaintAction | undefined): DecisionAction {
    if (!a) return 'FOLD';
    return a === 'RAISECALL' ? 'RAISE' : (a as DecisionAction);
  }

  function getCorrectActionForCurrentHand(): DecisionAction {
    const correctPaint = activeMap ? activeMap[hand] : 'FOLD';
    return normalizePaintToDecision(correctPaint);
  }

  // ── AJOUT : self-tests (appelé par le bouton dans l’onglet Options)
  function runSelfTests(){
    const evalAns = (chosen: DecisionAction, correctPaint: PaintAction) =>
      chosen === (correctPaint === 'RAISECALL' ? 'RAISE' : (correctPaint as DecisionAction));

    const tests = [
      { name: 'RAISECALL → RAISE', pass: evalAns('RAISE','RAISECALL') },
      { name: 'RAISECALL ≠ CALL',  pass: !evalAns('CALL','RAISECALL') },
      { name: 'SHOVE ok',          pass: evalAns('SHOVE','SHOVE') },
      { name: 'CALL ok',           pass: evalAns('CALL','CALL') },
      { name: 'TIERSTACK ok',      pass: evalAns('TIERSTACK','TIERSTACK') },
    ];

    const passed = tests.filter(t=>t.pass).length;
    if (passed === tests.length) {
      toast.success(`Tests OK (${passed}/${tests.length})`);
    } else {
      const failed = tests.filter(t=>!t.pass).map(t=>t.name).join('; ');
      toast.error(`Tests ratés (${passed}/${tests.length}) → ${failed}`);
    }
  }

  function nextHand(){
    const next = randomHandKey();
    let newPos: Position = position;
    let newDepth = activeDepth;

    if (modeRandom){
      const positionsPool = mode === "HU" ? POSITIONS_HU : POSITIONS_3MAX;
      newPos = positionsPool[Math.floor(Math.random()*positionsPool.length)] as Position;
      newDepth = depths[Math.floor(Math.random()*depths.length)];
      setPosition(newPos);
      setActiveDepth(newDepth);
    }

    if (autoHistory){
      const h = generateRandomHistory(newPos, mode);
      setHistory(h);
    }

    setShowRange(false);
    setHand(next);
  }

  function answer(a: DecisionAction){
    const correct = getCorrectActionForCurrentHand();
    const isOk = a === correct;
    setScore(s => ({ ok: s.ok + (isOk?1:0), total: s.total + 1 }));
    toast[isOk?"success":"error"](isOk?"✔ Correct":"✘ Correct: "+correct);
    nextHand();
  }

  function verify(){
    const correct = getCorrectActionForCurrentHand();
    toast.message('Action correcte pour cette main: '+correct);
    setShowRange(true);
  }

  function resetScore(){ setScore({ok:0,total:0}); }

  // export / import
  function handleExport(){
    try{
      const blob = new Blob([JSON.stringify({ version:2, rangesByMode, depths }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `spinango-ranges-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('Export JSON prêt');
    } catch(err){ toast.error('Échec export JSON'); }
  }

  function handleImportClick(){ fileInputRef.current?.click(); }

  async function onFileSelected(e: React.ChangeEvent<HTMLInputElement>){
    const file = e.target.files?.[0];
    if (!file) return;
    try{
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object') throw new Error('Fichier invalide');
      if (data.rangesByMode) setRangesByMode(data.rangesByMode as RangesByMode);
      else if (data.ranges) setRangesByMode({ "3MAX": data.ranges as Ranges }); // compat
      if (Array.isArray(data.depths) && data.depths.length) setDepths(data.depths as number[]);
      toast.success('Import réussi');
    } catch(err){ toast.error('Import invalide'); console.error(err); }
    finally { if (e.target) e.target.value = ''; }
  }

  // history generation
  function generateRandomHistory(actor: Position, m: TableMode): HistoryState {
    const pick = <T,>(items: [T, number][]): T => {
      const s = items.reduce((a, [,p])=>a+p, 0);
      let r = Math.random()*s;
      for (const [v,p] of items){ if ((r-=p) <= 0) return v; }
      return items[0][0];
    };
    const h: HistoryState = { BTN: null, SB: null, BB: null };

    if (m === "HU"){
      if (actor === 'SB') return h; // unopened
      const sb = pick<DecisionAction>([["CALL", 0.45],["RAISE", 0.5],["SHOVE", 0.05]] as any);
      h.SB = sb as any; // CALL = limp
      return h;
    }

    if (actor === 'BTN') return h; // unopened
    if (actor === 'SB'){
      const btn = pick<DecisionAction>([["FOLD", 0.35],["RAISE", 0.55],["SHOVE", 0.10]] as any);
      h.BTN = (btn === 'FOLD') ? null : btn; return h;
    }
    const btn = pick<DecisionAction>([["FOLD", 0.25],["RAISE", 0.6],["SHOVE", 0.15]] as any);
    h.BTN = (btn === 'FOLD') ? null : btn;
    if (h.BTN === null) return h;
    if (h.BTN === 'RAISE'){
      let sb = pick<DecisionAction>([["FOLD", 0.5],["CALL", 0.3],["RAISE", 0.15],["SHOVE", 0.05]] as any);
      if (sb === 'FOLD') sb = null as any; h.SB = sb as any;
    } else if (h.BTN === 'SHOVE'){
      let sb = pick<DecisionAction>([["FOLD", 0.7],["CALL", 0.3]] as any);
      if (sb === 'FOLD') sb = null as any; h.SB = sb as any;
    }
    return h;
  }

  // UI helpers
  function HistoryPicker({actor}:{actor:Position}){
    const order = orderFor(mode);
    const idx = order.indexOf(actor);
    const prev = order.slice(0, idx);
    return (
      <div className="flex flex-wrap gap-3">
        {prev.map(p=> (
          <div key={p} className="flex items-center gap-2">
            <Label className="w-12">{p}</Label>
            <div className="flex gap-1">
              {DECISION_ACTIONS.map(a=> (
                <Button
                  key={a}
                  size="sm"
                  variant={history[p]===a?"default":"outline"}
                  className={history[p]===a?"":"bg-white text-slate-900 hover:bg-white/90 hover:text-slate-900 border-slate-300"}
                  onClick={()=>setHistory(h=>({...h,[p]:h[p]===a?null:a}))}
                >{a}</Button>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  function historyToString(h: HistoryState, actor: Position){
    const order = orderFor(mode);
    const idx = order.indexOf(actor);
    const prev = order.slice(0, idx);
    const parts: string[] = [];
    for (const p of prev){ if (h[p]) parts.push(`${p}:${h[p]}`); }
    return parts.join(',');
  }

  function DepthSelector({depths, active, setActive}:{depths:number[]; active:number; setActive:(n:number)=>void}){
    return (
      <div className="flex items-center gap-2">
        <Label>Profondeur</Label>
        <div className="flex flex-wrap gap-2">
          {depths.map(d=> (
            <Button key={d} size="sm" variant={d===active?'default':'outline'} className={d===active?'':'bg-white text-slate-900'} onClick={()=>setActive(d)}>{d}bb</Button>
          ))}
        </div>
      </div>
    )
  }

  // render
  const posOptions: readonly Position[] = mode === "HU" ? POSITIONS_HU : POSITIONS_3MAX;
  const modeBadge = mode === "HU" ? "HU" : "3-max";
  const posLabel = (p: Position) => (mode === "HU" && p === 'SB') ? 'SB (BTN)' : p;

  return (
    <div className="mx-auto max-w-6xl p-4 space-y-4">
      {/* Header */}
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-indigo-500 to-fuchsia-500 bg-clip-text text-transparent">Spinango – Preflop Trainer</h1>
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold px-2 py-1 rounded-full bg-slate-900/80 text-white">{modeBadge}</span>
          <span className="text-sm font-semibold text-white px-3 py-1 rounded-full bg-slate-900/80">{activeDepth}bb</span>
        </div>
      </div>

      {/* Mode switch */}
      <div className="flex items-center gap-2">
        <Label>Mode</Label>
        <Tabs value={mode} onValueChange={(v)=>{
          const newMode = v as TableMode;
          setMode(newMode);

          const pool: readonly Position[] = newMode === "HU" ? POSITIONS_HU : POSITIONS_3MAX;

          if (!pool.includes(position)) {
            setPosition(newMode === "HU" ? "SB" : "BTN");
            setHistory({ BTN: null, SB: null, BB: null });
          }

          setShowRange(false);
        }}>
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
        </TabsList>

        {/* SESSION */}
        <TabsContent value="trainer">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2"><CardTitle>Session</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Label>Position</Label>
                    <Select value={position} onValueChange={(v)=>setPosition(v as Position)}>
                      <SelectTrigger className="w-32"><SelectValue placeholder="Position"/></SelectTrigger>
                      <SelectContent>
                        {posOptions.map(p=> <SelectItem key={p} value={p as any}>{posLabel(p as Position)}</SelectItem>)}
                      </SelectContent>
                    </Select>

                    <Label>Profondeur</Label>
                    <Select value={String(activeDepth)} onValueChange={(v)=>setActiveDepth(parseInt(v,10))}>
                      <SelectTrigger className="w-24"><SelectValue placeholder="bb"/></SelectTrigger>
                      <SelectContent>
                        {depths.map(d=> <SelectItem key={d} value={String(d)}>{d}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-center gap-2">
                    <Label>Historique auto</Label>
                    <Switch checked={autoHistory} onCheckedChange={(v)=>{ setAutoHistory(!!v); if (v) setHistory(generateRandomHistory(position, mode)); }} />
                    <Label>Aléa pos/depth</Label>
                    <Switch checked={modeRandom} onCheckedChange={setModeRandom}/>
                  </div>
                </div>

                {/* Contexte */}
                <div className="space-y-2">
                  {autoHistory ? (
                    <div className="text-sm text-muted-foreground">Contexte: {historyToString(history, position) || 'pot non ouvert'}</div>
                  ) : (
                    <div>
                      <Label>Actions précédentes (contexte)</Label>
                      <HistoryPicker actor={position}/>
                      <div className="text-xs text-muted-foreground">Contexte: {contextKey() || 'pot non ouvert'}</div>
                    </div>
                  )}
                </div>

                {/* Cartes */}
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Main actuelle</div>
                  <HoleCards combo={hand}/>
                </div>

                {/* Actions */}
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                  {DECISION_ACTIONS.map(a => (
                    <Button key={a} variant={'outline'} onClick={()=>answer(a)}>{a}</Button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={verify}><CheckCircle2 className="mr-2 h-4 w-4"/>Vérifier & ouvrir la range</Button>
                  <Button variant="outline" onClick={nextHand}><Shuffle className="mr-2 h-4 w-4"/>Main suivante</Button>
                  <Button variant="ghost" onClick={resetScore}><ListChecks className="mr-2 h-4 w-4"/>Reset score</Button>
                </div>

                {/* Range viewer */}
                {showRange && (
                  <div className="mt-3 border rounded-xl p-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-sm text-muted-foreground">{posLabel(position)} @ {activeDepth}bb — {contextKey() || 'Unopened'}</div>
                      <Button size="sm" variant="outline" onClick={()=>setShowRange(false)}>Fermer</Button>
                    </div>
                    {activeMap ? (
                      <RangeGrid map={activeMap} onPaint={()=>{}} currentAction={"FOLD" as PaintAction}/>
                    ) : (
                      <div className="text-sm text-muted-foreground">Aucune range définie pour ce contexte.</div>
                    )}
                  </div>
                )}

                <div className="text-sm">Score: <span className="font-semibold">{score.ok}/{score.total}</span> ({score.total?Math.round(100*score.ok/score.total):0}%)</div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* EDITEUR */}
        <TabsContent value="editor">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <DepthSelector depths={depths} active={activeDepth} setActive={setActiveDepth} />

              <Select value={position} onValueChange={(v)=>setPosition(v as Position)}>
                <SelectTrigger className="w-36"><SelectValue placeholder="Position"/></SelectTrigger>
                <SelectContent>
                  {posOptions.map(p=> <SelectItem key={p} value={p as any}>{posLabel(p as Position)}</SelectItem>)}
                </SelectContent>
              </Select>

              <div className="flex items-center gap-2">
                <Label>Contexte</Label>
                <HistoryPicker actor={position} />
              </div>

              <div className="flex items-center gap-2">
                <Label>Peindre</Label>
                <div className="flex flex-wrap gap-2">
                  {PAINT_ACTIONS.map(a=> (
                    <Button key={a} size="sm" variant={paintAction===a?'default':'outline'} className={paintAction===a?'':'bg-white text-slate-900'} onClick={()=>setPaintAction(a)}>
                      {a === 'RAISECALL' ? 'RAISE-CALL' : a}
                    </Button>
                  ))}
                </div>
              </div>
            </div>

            {activeMap && (<RangeGrid map={activeMap} onPaint={paint} currentAction={paintAction}/>)}
            {!activeMap && <div className="text-sm text-muted-foreground">Aucune range définie pour ce contexte.</div>}

            <div className="text-xs text-muted-foreground">Légende – Fold: blanc; Call: jaune (Limp si SB HU unopened); Raise: orange vif; Raise-Call: rouge foncé; Shove: vert vif; Tierstack: bleu ciel.</div>
          </div>
        </TabsContent>

        {/* OPTIONS */}
        <TabsContent value="options">
          <Card>
            <CardHeader className="pb-2"><CardTitle>Options</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Profondeurs actives (séparées par des virgules)</Label>
                <Input value={depths.join(',')} onChange={(e)=>{
                  const arr = e.target.value.split(',').map(x=>parseInt(x.trim(),10)).filter(n=>!isNaN(n));
                  setDepths(arr);
                  if (!arr.includes(activeDepth) && arr.length){ setActiveDepth(arr[0]); }
                }} placeholder="25,24,23,...,5"/>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={runSelfTests}>Lancer les self-tests</Button>
                <span className="text-xs text-muted-foreground">(normalisation RAISE-CALL, comparaisons, etc.)</span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={handleExport}>Exporter JSON</Button>
                <Button size="sm" variant="secondary" onClick={handleImportClick}>Importer JSON (remplacer)</Button>
                <input ref={fileInputRef} type="file" accept="application/json" hidden onChange={onFileSelected} />
                <span className="text-xs text-muted-foreground">Autosave activé (localStorage). Export/Import incluent 3MAX & HU.</span>
              </div>

              <div className="text-xs text-muted-foreground">Les ranges dépendent du <b>contexte</b> et du <b>mode</b>. Exemple HU: si SB (BTN) a LIMP (CALL), tu édites la réponse de BB vs limp.</div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
