import { compactMatrixStyles } from './matrix-loader';

/** Shared by React and server-rendered pages. State always comes from the owning flow. */
export const stepListStyles = `
ol.ankka-steps {
  counter-reset: ankka-step;
  list-style: none;
  margin: 1.5rem 0;
  padding: 0;
  text-align: left;
  font-size: .875rem;
  line-height: 1.6;
}
ol.ankka-steps > li {
  counter-increment: ankka-step;
  position: relative;
  min-height: 3.5rem;
  margin: 0;
  padding: .25rem 0 1.5rem 3rem;
  color: var(--muted, #b0b0b0);
}
ol.ankka-steps > li:last-child { min-height: 2rem; padding-bottom: 0; }
ol.ankka-steps > li::before {
  content: counter(ankka-step, decimal-leading-zero) / "";
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border: 1px solid var(--border, #ffffff2b);
  border-radius: .5rem;
  color: var(--muted, #b0b0b0);
  font: 400 .6875rem/1 ui-monospace, monospace;
}
ol.ankka-steps > li:not(:last-child)::after {
  content: '';
  position: absolute;
  top: 2.375rem;
  bottom: .375rem;
  left: 1rem;
  width: 1px;
  background: var(--border, #ffffff2b);
}
ol.ankka-steps > li > :first-child { margin-top: 0; }
ol.ankka-steps > li > :last-child { margin-bottom: 0; }
ol.ankka-steps > li:is([data-state="active"], [data-state="current"]) { color: var(--ink, #ededed); }
ol.ankka-steps > li:is([data-state="active"], [data-state="current"])::before { color: var(--ink, #ededed); border-color: currentColor; background: #ffffff08; }
ol.ankka-steps > li[data-state="done"]::before { content: '✓' / '';  color: var(--ink, #ededed); font-size: .875rem; }
ol.ankka-steps > li[data-state="stopped"]::before { content: '!' / '';  color: var(--danger, #f3b0a9); border-color: currentColor; font-size: .875rem; }
.ankka-step-heading { display: flex; flex-direction: column; align-items: flex-start; gap: .125rem; }
.ankka-step-label { font-weight: 500; }
.ankka-step-status { display: inline-flex; align-items: center; gap: .5rem; font-size: .75rem; color: var(--muted, #b0b0b0); }
[data-state="active"] > .ankka-step-heading > .ankka-step-status { color: var(--ink, #ededed); }
[data-state="active"] > .ankka-step-heading::before {
  ${compactMatrixStyles}
  position: absolute;
  top: .125rem;
  left: .125rem;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: .375rem;
  pointer-events: none;
}
ol.ankka-steps > li[data-state="active"]::before { text-shadow: 0 0 3px var(--canvas, #141414); }
[data-state="stopped"] > .ankka-step-heading > .ankka-step-status { color: var(--danger, #f3b0a9); }
@media (prefers-reduced-motion: reduce) {
  [data-state="active"] > .ankka-step-heading::before { animation: none; }
}
`;

/** Runs inside the caller's nonce-protected script; labels are inserted only as text. */
export const stepListScript = `
const progressStep=(label,state,status)=>{
  const item=document.createElement('li');item.dataset.state=state;
  if(state==='active')item.setAttribute('aria-current','step');
  const heading=document.createElement('div');heading.className='ankka-step-heading';
  const name=document.createElement('span');name.className='ankka-step-label';name.textContent=label;
  const detail=document.createElement('span');detail.className='ankka-step-status';detail.textContent=status;
  heading.append(name,detail);item.append(heading);return item;
};
`;
