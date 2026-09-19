import { compactMatrixStyles, matrixLoaderStyles, matrixLoaderSvg } from './matrix-loader';

/**
 * Presentation shared by the Worker pages and the dashboard's installation handoff.
 * Matches the hosted installer's public tokens; everything is bundled locally.
 */
export const customerLoadingStyles = matrixLoaderStyles;

export const customerLoadingIndicator = `<span class="ankka-loader" aria-hidden="true">${matrixLoaderSvg}</span>`;

export const customerPageStyles = `${customerLoadingStyles}
.ankka-setup {
  color-scheme: dark;
  --canvas: #141414;
  --ink: #ededed;
  --ink-body: #d4d4d4;
  --muted: #b0b0b0;
  --border: rgb(255 255 255 / 0.17);
  --border-strong: rgb(255 255 255 / 0.38);
  --danger: #f3b0a9;
  --radius-control: 0.625rem;
  --radius-panel: 0.75rem;
  --font-mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  --font-size-body: 1rem;
  --font-size-label: 0.75rem;
  --font-size-caption: 0.8125rem;
  --font-size-ui: 0.875rem;
  min-height: 100svh;
  padding-block-end: 4rem;
  background: var(--canvas);
  color: var(--ink-body);
  font: 400 var(--font-size-body)/1.6 "Helvetica Neue", Helvetica, Arial, sans-serif;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
body.ankka-setup { margin: 0; }
.ankka-setup, .ankka-setup * { box-sizing: border-box; }
.ankka-setup [hidden] { display: none !important; }
.ankka-setup ::selection { color: var(--canvas); background: #dedede; }
.ankka-setup .site-header { width: min(48rem, calc(100% - 3rem)); margin-inline: auto; padding-block: clamp(5rem, 15vh, 10rem) 2.75rem; }
.ankka-setup .brand { display: flex; justify-content: center; color: var(--ink); }
.ankka-setup .wordmark {
  display: block;
  width: min(80%, 28rem);
  height: auto;
  -webkit-mask-image: linear-gradient(to bottom, #000 20%, transparent 100%);
  mask-image: linear-gradient(to bottom, #000 20%, transparent 100%);
}
.ankka-setup main { width: min(42rem, calc(100% - 3rem)); margin-inline: auto; padding: 0; }
.ankka-setup main.page-message { max-width: 32rem; text-align: center; }
.ankka-setup h1, .ankka-setup h2 { color: var(--ink); text-wrap: balance; font-weight: 300; }
.ankka-setup h1 { margin: 0 auto; font-size: clamp(1.75rem, 4vw, 2.5rem); letter-spacing: -0.025em; line-height: 1.1; text-align: center; }
.ankka-setup h2 { margin: 0 0 1rem; font-size: 1.375rem; letter-spacing: -0.02em; line-height: 1.25; }
.ankka-setup p { margin-block: 1.25rem; text-wrap: pretty; }
.ankka-setup main > p { color: var(--muted); }
.ankka-setup .eyebrow { margin: 0 0 1.25rem; font: 400 var(--font-size-label)/1.5 var(--font-mono); letter-spacing: 0.09em; text-transform: uppercase; text-align: center; }
.ankka-setup #intro { max-width: 48ch; margin: 1rem auto; text-align: center; }
.ankka-setup #message { min-height: 1.6em; color: var(--muted); font-size: var(--font-size-ui); }
.ankka-setup .page-form > #message { text-align: center; margin-block: 1rem 2rem; }
.ankka-setup code { font: 0.9em var(--font-mono); overflow-wrap: anywhere; }
.ankka-setup #credential-note { color: var(--ink); }
.ankka-setup #detail { overflow-wrap: anywhere; font-size: var(--font-size-caption); }
.ankka-setup a { color: inherit; text-underline-offset: 0.25em; text-decoration-thickness: from-font; text-decoration-skip-ink: auto; }
.ankka-setup :is(a, button, input, select, textarea, summary):focus-visible { outline: 2px solid var(--ink); outline-offset: 4px; }
.ankka-setup #heading:focus { outline: none; }
.ankka-setup form { margin-block: 2rem; }
.ankka-setup label { display: grid; align-content: start; min-width: 0; gap: 0.5rem; margin-block: 1.25rem; color: var(--ink); font-size: var(--font-size-ui); font-weight: 400; }
.ankka-setup input, .ankka-setup select, .ankka-setup textarea {
  width: 100%;
  min-width: 0;
  min-height: 3rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--canvas);
  color: var(--ink);
  font: inherit;
  font-size: var(--font-size-body);
}
.ankka-setup textarea { resize: vertical; }
.ankka-setup input::placeholder, .ankka-setup textarea::placeholder { color: var(--muted); opacity: 1; }
.ankka-setup small { display: block; color: var(--muted); font-size: var(--font-size-caption); font-weight: 400; line-height: 1.55; }
.ankka-setup label > small { margin: 0; }
.ankka-setup label > span > small { display: inline; margin-inline-start: 0.5rem; }
.ankka-setup input[type=file] { margin-block: 1rem; }
.ankka-setup input::file-selector-button { margin-inline-end: 1rem; padding: 0.35rem 0.65rem; border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: transparent; color: var(--ink); font: inherit; cursor: pointer; }
.ankka-setup .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 1.5rem; }
.ankka-setup button, .ankka-setup .button-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 1.5rem;
  min-height: 3.25rem;
  max-width: 100%;
  padding: 0.85rem 1.25rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--ink);
  font: 400 var(--font-size-caption)/1.5 var(--font-mono);
  text-align: center;
  text-decoration: none;
  cursor: pointer;
  user-select: none;
  transition: color 160ms ease, border-color 160ms ease, background-color 160ms ease;
}
.ankka-setup button:not(.secondary)::after, .ankka-setup .button-link:not([target="_blank"])::after { content: "→" / ""; font: 1.25rem/1 Arial, sans-serif; }
.ankka-setup button.secondary { color: var(--muted); border-color: var(--border); }
.ankka-setup button.danger { color: var(--danger); border-color: currentColor; }
.ankka-setup button:disabled { cursor: wait; opacity: 0.45; }
.ankka-setup button:disabled:not(.secondary)::after {${compactMatrixStyles}}
.ankka-setup button:active:not(:disabled), .ankka-setup .button-link:active { transform: scale(0.98); }
.ankka-setup .actions { display: flex; justify-content: center; align-items: center; flex-wrap: wrap; gap: 0.75rem; margin-block: 2rem; }
.ankka-setup #review-button { display: flex; margin: 2rem auto 0; }
.ankka-setup details { margin-block: 1.5rem; color: var(--muted); }
.ankka-setup summary { min-height: 2.75rem; align-content: center; font: 400 var(--font-size-caption)/1.6 var(--font-mono); cursor: pointer; }
.ankka-setup li { margin-block: 0.5rem; }
.ankka-setup #review { margin-block-start: 2rem; }
.ankka-setup #review > h2 { text-align: center; }
.ankka-setup #review > p, .ankka-setup #review > small { color: var(--muted); font-size: var(--font-size-ui); }
.ankka-setup dl { margin-block: 1.5rem; }
.ankka-setup dt { color: var(--muted); font: 400 var(--font-size-label)/1.6 var(--font-mono); }
.ankka-setup dd { margin: 0.35rem 0 1.25rem; color: var(--ink); overflow-wrap: anywhere; }
.ankka-setup #summary { padding: 1.25rem 1.25rem 0; border: 1px solid var(--border); border-radius: var(--radius-panel); }
.ankka-setup .domain-guide { margin-block: 2rem; padding-block-start: 2rem; border-block-start: 1px solid var(--border); }
.ankka-setup .domain-guide > p { color: var(--muted); }
.ankka-setup .address-examples { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.5rem; padding: 1.25rem; border: 1px solid var(--border); border-radius: var(--radius-panel); }
.ankka-setup .address-examples dd { margin: 0.35rem 0 0; font-family: var(--font-mono); font-size: var(--font-size-ui); }
.ankka-setup .domain-steps { padding-inline-start: 1.4rem; margin-block: 2rem; }
.ankka-setup .domain-steps li { padding-inline-start: 0.5rem; margin-block: 1.25rem; }
.ankka-setup .domain-steps p { color: var(--muted); margin-block: 0.35rem; font-size: var(--font-size-ui); }
.ankka-setup .domain-note { font-size: var(--font-size-caption); }
.ankka-setup .warning { padding: 0.75rem 1rem; border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent); border-radius: var(--radius-control); color: var(--danger); }
.ankka-setup .page-message > .ankka-loader, .ankka-setup #progress .ankka-loader, .ankka-setup .page-loader .ankka-loader { display: grid; width: 12rem; height: 8rem; margin: 2rem auto; }
.ankka-setup.update-panel { min-height: 0; padding: 0; background: transparent; }
.ankka-setup .update-heading { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 1rem; }
.ankka-setup .update-heading h2 { margin: 0; }
.ankka-setup .update-label { color: var(--muted); font: var(--font-size-label)/1.6 var(--font-mono); }
.ankka-setup .release-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.5rem; padding: 1.25rem; border: 1px solid var(--border); border-radius: var(--radius-panel); }
.ankka-setup .release-summary dd { margin-block-end: 0; font-family: var(--font-mono); font-size: var(--font-size-ui); }
.ankka-setup .release-notes { padding-inline-start: 1.25rem; color: var(--muted); font-size: var(--font-size-ui); list-style: square; }
.ankka-setup .update-status { display: flex; align-items: center; gap: 1.25rem; margin-block-start: 1.5rem; padding: 0.75rem 1rem; border: 1px solid var(--border); border-radius: var(--radius-control); }
.ankka-setup .update-status p { flex: 1; margin: 0; font-size: var(--font-size-ui); }
.ankka-setup .update-status[data-tone="error"], .ankka-setup .update-status[data-tone="warning"] { color: var(--danger); }
.ankka-setup .update-dismiss { min-height: 2.75rem; padding: 0.5rem; border: 0; }
.ankka-setup.update-panel .actions { justify-content: flex-start; }
.ankka-setup.update-panel button:disabled::after { content: none; }
@media (hover: hover) and (pointer: fine) {
  .ankka-setup button:hover:not(:disabled), .ankka-setup .button-link:hover { background: var(--ink); color: var(--canvas); border-color: var(--ink); }
  .ankka-setup button.secondary:hover { background: transparent; color: var(--ink); }
  .ankka-setup button.danger:hover { background: var(--danger); color: var(--canvas); border-color: var(--danger); }
  .ankka-setup summary:hover { color: var(--ink); }
}
@media (max-width: 45rem) {
  .ankka-setup .site-header { padding-block: clamp(4rem, 12vh, 7rem) 2.25rem; }
  .ankka-setup .grid, .ankka-setup .address-examples, .ankka-setup .release-summary { grid-template-columns: 1fr; gap: 0; }
  .ankka-setup .release-summary { gap: 1.25rem; }
  .ankka-setup .address-examples { gap: 1.25rem; }
  .ankka-setup .actions { flex-direction: column; align-items: stretch; }
  .ankka-setup .actions > *, .ankka-setup #review-button { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .ankka-setup *, .ankka-setup *::before, .ankka-setup *::after { animation: none !important; transition: none !important; }
  .ankka-setup button:disabled:not(.secondary)::after { mask-image: repeating-linear-gradient(to right, #000 0 2px, transparent 2px 4px), repeating-linear-gradient(to bottom, #000 0 2px, transparent 2px 4px); opacity: .6; }
}
`;
