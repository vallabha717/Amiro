/**
 * Voice room animation styles. Phase-driven via `data-phase` on `.vm-root`,
 * sound-driven via the `--in` / `--out` variables `useVoiceLevelVars` writes
 * every frame. Kept as one stylesheet (hoisted once by React 19) so the
 * mascot works anywhere -- the full room and the minimized dock.
 */
export const VOICE_ROOM_CSS = `
.vm-root { --in: 0; --out: 0; --accent: #6b7cff; isolation: isolate; }
.vm-root > * { pointer-events: none; }

/* ---- aura ---------------------------------------------------------- */
.vm-aura {
  position: absolute; inset: -18%; border-radius: 9999px; z-index: -2;
  background: radial-gradient(circle, color-mix(in srgb, var(--accent) 38%, transparent) 0%, transparent 62%);
  opacity: .55; transform: scale(calc(.9 + var(--in) * .25 + var(--out) * .35));
  transition: opacity .4s ease, transform 80ms linear;
}
.vm-root[data-phase="idle"] .vm-aura, .vm-root[data-phase="connecting"] .vm-aura { opacity: .3; }
.vm-root[data-phase="thinking"] .vm-aura, .vm-root[data-phase="transcribing"] .vm-aura { animation: vm-aura-think 2.4s ease-in-out infinite; }
.vm-root[data-phase="error"] .vm-aura { background: radial-gradient(circle, rgba(239,68,68,.35) 0%, transparent 62%); }

/* ---- body: breathing / leaning / swaying ---------------------------- */
.vm-react { position: absolute; inset: 0; transform-origin: 50% 92%; transition: transform 70ms linear; }
.vm-body { position: absolute; inset: 0; transform-origin: 50% 92%; animation: vm-breathe 4.2s ease-in-out infinite; }
.vm-body > * { position: absolute !important; inset: 0; }

.vm-root[data-phase="hearing"] .vm-react { transform: scale(calc(1 + var(--in) * .06)) translateY(calc(var(--in) * -4px)); }
.vm-root[data-phase="hearing"] .vm-body { animation: vm-nod 1.1s ease-in-out infinite; }
.vm-root[data-phase="listening"] .vm-body { animation: vm-breathe 3.4s ease-in-out infinite; }
.vm-root[data-phase="thinking"] .vm-body,
.vm-root[data-phase="transcribing"] .vm-body { animation: vm-ponder 2.6s ease-in-out infinite; }
.vm-root[data-phase="speaking"] .vm-react {
  transform: translateY(calc(var(--out) * -7px)) scaleY(calc(1 + var(--out) * .07)) scaleX(calc(1 - var(--out) * .035));
}
.vm-root[data-phase="speaking"] .vm-body { animation: vm-sway 2.2s ease-in-out infinite; }
.vm-root[data-phase="connecting"] .vm-body { animation: vm-wiggle 1.2s ease-in-out infinite; }
.vm-root[data-phase="error"] .vm-body { animation: vm-shake .5s ease-in-out 2; }

/* ---- headphones ----------------------------------------------------- */
.vm-band { z-index: -1; overflow: visible; }
.vm-band path { fill: none; stroke: #ece4d4; stroke-width: 26; stroke-linecap: round; filter: drop-shadow(0 2px 2px rgba(0,0,0,.18)); }
.vm-cup rect { fill: #efe7d6; stroke: rgba(0,0,0,.08); stroke-width: 2; }
.vm-cup .vm-cup-pad { fill: #d9cfbb; }
.vm-cup, .vm-band { transform-box: fill-box; transform-origin: center; }
.vm-root[data-phase="connecting"] .vm-band,
.vm-root[data-phase="connecting"] .vm-cup { animation: vm-don 1.2s cubic-bezier(.34,1.56,.64,1) both; }
.vm-cup-glow {
  fill: var(--accent); opacity: 0; mix-blend-mode: screen; filter: blur(14px);
  transition: opacity 120ms linear;
}
.vm-root[data-phase="listening"] .vm-cup-glow { animation: vm-glow-pulse 2.8s ease-in-out infinite; }
.vm-root[data-phase="hearing"] .vm-cup-glow { opacity: calc(.35 + var(--in) * 1.1); }
.vm-root[data-phase="hearing"] .vm-cup { transform: scale(calc(1 + var(--in) * .12)); }
.vm-root[data-muted="true"] .vm-cup-glow { opacity: 0 !important; animation: none; }
.vm-root[data-muted="true"] .vm-cup rect { fill: #c9c4bb; }

/* ---- mouth ---------------------------------------------------------- */
.vm-mouth { opacity: 0; transform: scaleY(.05); transition: opacity 90ms linear; }
.vm-root[data-phase="speaking"] .vm-mouth {
  opacity: clamp(0, calc((var(--out) - .04) * 8), 1);
  transform: scaleY(calc(.25 + var(--out) * 1.1)) scaleX(calc(.85 + var(--out) * .3));
}

/* ---- speaking rings -------------------------------------------------- */
.vm-rings { position: absolute; inset: 0; z-index: -1; opacity: 0; transition: opacity .3s ease; }
.vm-rings span {
  position: absolute; inset: 10%; border-radius: 9999px;
  border: 2px solid color-mix(in srgb, var(--accent) 70%, transparent);
  animation: vm-ring 2.1s cubic-bezier(.2,.6,.3,1) infinite;
}
.vm-rings span:nth-child(2) { animation-delay: .7s; }
.vm-rings span:nth-child(3) { animation-delay: 1.4s; }
.vm-root[data-phase="speaking"] .vm-rings { opacity: calc(.25 + var(--out) * 1.4); }

/* ---- hearing inflow -------------------------------------------------- */
.vm-inflow { position: absolute; inset: 0; opacity: 0; transition: opacity .25s ease; }
.vm-root[data-phase="hearing"] .vm-inflow { opacity: calc(.35 + var(--in) * 1.3); }
.vm-root[data-phase="listening"] .vm-inflow { opacity: .18; }
.vm-root[data-muted="true"] .vm-inflow { opacity: 0 !important; }
.vm-waves { position: absolute; top: calc(var(--ear-y) - 14%); width: 16%; height: 28%; overflow: visible; }
.vm-waves path { fill: none; stroke: var(--accent); stroke-width: 5; stroke-linecap: round; }
.vm-waves-l { left: -20%; }
.vm-waves-r { right: -20%; }
.vm-waves-l path { animation: vm-in-l 1.3s ease-in infinite; }
.vm-waves-r path { animation: vm-in-r 1.3s ease-in infinite; }
.vm-waves path:nth-child(2) { animation-delay: .43s; }
.vm-waves path:nth-child(3) { animation-delay: .86s; }
.vm-note {
  position: absolute; top: var(--ear-y); font-size: 18px; line-height: 1; color: var(--accent);
  opacity: 0; font-weight: 700;
}
.vm-root[data-phase="hearing"] .vm-note { animation: vm-note-l 2.2s ease-in infinite; }
.vm-note-1 { left: -14%; }
.vm-note-2 { right: -14%; animation-name: vm-note-r !important; animation-delay: .7s !important; }
.vm-note-3 { left: -10%; animation-delay: 1.4s !important; }

/* ---- thinking orbit -------------------------------------------------- */
.vm-orbit { position: absolute; left: 50%; top: -6%; width: 34%; height: 14%; transform: translateX(-50%); opacity: 0; transition: opacity .3s ease; }
.vm-root[data-phase="thinking"] .vm-orbit, .vm-root[data-phase="transcribing"] .vm-orbit { opacity: 1; }
.vm-orbit span {
  position: absolute; left: 50%; top: 50%; width: 11px; height: 11px; margin: -5.5px; border-radius: 9999px;
  background: var(--accent); box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 70%, transparent);
  animation: vm-orbit 1.8s linear infinite;
}
.vm-orbit span:nth-child(2) { animation-delay: -.6s; opacity: .75; width: 8px; height: 8px; margin: -4px; }
.vm-orbit span:nth-child(3) { animation-delay: -1.2s; opacity: .5; width: 6px; height: 6px; margin: -3px; }
.vm-root[data-phase="transcribing"] .vm-orbit span { animation-duration: 1.1s; }

/* ---- muted badge ----------------------------------------------------- */
.vm-muted-badge {
  position: absolute; right: 8%; top: 8%; display: grid; place-items: center;
  width: 28px; height: 28px; border-radius: 9999px; color: white; background: #ef4444;
  box-shadow: 0 2px 10px rgba(239,68,68,.45); animation: vm-pop .35s cubic-bezier(.34,1.56,.64,1) both;
}

/* ---- reduced motion -------------------------------------------------- */
.vm-root[data-reduce="true"] *, .vm-root[data-reduce="true"] { animation: none !important; transition: none !important; }

@keyframes vm-breathe { 0%,100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-2.5%) scale(1.012); } }
@keyframes vm-nod { 0%,100% { transform: rotate(0) translateY(0); } 30% { transform: rotate(-3deg) translateY(1.5%); } 60% { transform: rotate(2deg) translateY(-.5%); } }
@keyframes vm-ponder { 0%,100% { transform: rotate(-5deg) translateY(-1%); } 50% { transform: rotate(5deg) translateY(-2.5%); } }
@keyframes vm-sway { 0%,100% { transform: rotate(-1.5deg); } 50% { transform: rotate(1.5deg); } }
@keyframes vm-wiggle { 0%,100% { transform: rotate(0); } 25% { transform: rotate(-4deg); } 75% { transform: rotate(4deg); } }
@keyframes vm-shake { 0%,100% { transform: translateX(0); } 20%,60% { transform: translateX(-4%); } 40%,80% { transform: translateX(4%); } }
@keyframes vm-don { 0% { transform: translateY(-140%) scale(.7); opacity: 0; } 60% { opacity: 1; } 100% { transform: translateY(0) scale(1); opacity: 1; } }
@keyframes vm-glow-pulse { 0%,100% { opacity: .12; } 50% { opacity: .42; } }
@keyframes vm-ring { 0% { transform: scale(.85); opacity: .9; } 100% { transform: scale(1.75); opacity: 0; } }
@keyframes vm-in-l { 0% { transform: translateX(-90%); opacity: 0; } 35% { opacity: 1; } 100% { transform: translateX(55%); opacity: 0; } }
@keyframes vm-in-r { 0% { transform: translateX(90%); opacity: 0; } 35% { opacity: 1; } 100% { transform: translateX(-55%); opacity: 0; } }
@keyframes vm-note-l { 0% { transform: translate(-60%, 60%) rotate(-15deg) scale(.7); opacity: 0; } 30% { opacity: 1; } 100% { transform: translate(120%, -40%) rotate(10deg) scale(1.1); opacity: 0; } }
@keyframes vm-note-r { 0% { transform: translate(60%, 60%) rotate(15deg) scale(.7); opacity: 0; } 30% { opacity: 1; } 100% { transform: translate(-120%, -40%) rotate(-10deg) scale(1.1); opacity: 0; } }
@keyframes vm-orbit { from { transform: rotate(0deg) translateX(200%) rotate(0deg) scaleY(1); } to { transform: rotate(360deg) translateX(200%) rotate(-360deg); } }
@keyframes vm-aura-think { 0%,100% { opacity: .35; } 50% { opacity: .7; } }
@keyframes vm-pop { from { transform: scale(0); } to { transform: scale(1); } }

/* ---- companions (swarm agents in the room) --------------------------- */
.vm-companion { animation: vm-breathe 4.5s ease-in-out infinite; transform-origin: 50% 92%; }
.vm-companion[data-activity="working"] { animation: vm-hop .9s ease-in-out infinite; }
.vm-companion[data-activity="waiting"] { animation: vm-ponder 3s ease-in-out infinite; }
@keyframes vm-hop { 0%,100% { transform: translateY(0); } 40% { transform: translateY(-14%); } 60% { transform: translateY(-14%) rotate(3deg); } }
.vm-typing span { display: inline-block; width: 4px; height: 4px; margin: 0 1px; border-radius: 9999px; background: currentColor; animation: vm-type 1s ease-in-out infinite; }
.vm-typing span:nth-child(2) { animation-delay: .15s; }
.vm-typing span:nth-child(3) { animation-delay: .3s; }
@keyframes vm-type { 0%,100% { transform: translateY(0); opacity: .4; } 50% { transform: translateY(-3px); opacity: 1; } }

/* ---- level bars (dock) ------------------------------------------------ */
.vm-bars { display: flex; align-items: center; gap: 2px; height: 18px; }
.vm-bars i { display: block; width: 3px; border-radius: 3px; background: var(--accent); height: 20%; transition: height 70ms linear; }
`;
