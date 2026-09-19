/** A small, deterministic study of the hosted installer's grain and displaced bands. */
export const matrixLoaderFragments = Array.from({ length: 8 }, (_, fragment) => {
  const grain: string[] = [];
  const signal: string[] = [];
  for (let row = 0; row < 14; row += 1) {
    for (let column = fragment * 3; column < fragment * 3 + 3; column += 1) {
      const seed = Math.sin(column * 127.1 + row * 311.7 + 19) * 43758.5453;
      const noise = seed - Math.floor(seed);
      const ridge = row - (2 + column * 0.39 + Math.sin(column * 0.42) * 1.6);
      const counter = row - (11 - column * 0.32);
      const density = Math.max(Math.exp(-(ridge * ridge) / 9), Math.exp(-(counter * counter) / 3) * 0.55);
      if (noise > density) continue;
      const x = 2 + column * 2.9;
      const y = 3 + row * 3;
      const width = noise > 0.55 ? 1.8 : 1.25;
      const height = (column + row * 3) % 17 === 0 ? 3.5 : 1.25;
      const path = `M${x.toFixed(1)} ${y}h${width}v${height}h-${width}z`;
      (noise < density * 0.4 ? grain : signal).push(path);
    }
  }
  return { grain: grain.join(''), signal: signal.join('') };
});

export const matrixLoaderSvg = `<svg class="ankka-loader-field" viewBox="0 0 72 48" fill="currentColor" aria-hidden="true" focusable="false">${matrixLoaderFragments.map(({ grain, signal }) => `<g><path opacity=".55" d="${grain}"/><path d="${signal}"/></g>`).join('')}</svg>`;

// The compact treatment uses the same monochrome matrix, simplified to 4 × 4 pixels.
// It also works in a button pseudo-element without markup or an image request.
export const compactMatrixStyles = `
  content: "";
  display: block;
  flex: none;
  width: 1rem;
  height: 1rem;
  background: currentColor;
  mask-image: repeating-linear-gradient(to right, #000 0 2px, transparent 2px 4px), repeating-linear-gradient(to bottom, #000 0 2px, transparent 2px 4px), linear-gradient(135deg, transparent 35%, #000 50%, transparent 65%);
  mask-size: 4px 4px, 4px 4px, 300% 300%;
  mask-composite: intersect;
  animation: ankka-matrix-scan 1.8s linear infinite;
`;

export const matrixLoaderStyles = `
.ankka-loader { position: relative; display: inline-flex; flex: none; width: 4.5rem; height: 3rem; align-items: center; justify-content: center; color: inherit; }
.ankka-loader-field { display: block; width: 100%; height: 100%; overflow: visible; }
.ankka-loader-field > g { opacity: .7; animation: ankka-matrix-fragment 3.6s cubic-bezier(.45, 0, .55, 1) infinite; }
.ankka-loader-field > g:nth-child(even) { animation-direction: reverse; }
${matrixLoaderFragments.map((_, index) => `.ankka-loader-field > g:nth-child(${index + 1}) { animation-delay: ${(-index * 0.29).toFixed(2)}s; }`).join('\n')}
.ankka-loader-inline { width: 1rem; height: 1rem; }
.ankka-loader-inline::before {${compactMatrixStyles}}
@keyframes ankka-matrix-fragment {
  0%, 100% { transform: translate(0, 0); opacity: .55; }
  30% { transform: translate(0, 0); opacity: 1; }
  55% { transform: translate(5px, -5px); opacity: .45; }
  75% { transform: translate(-3px, 3px); opacity: .8; }
}
@keyframes ankka-matrix-scan {
  from { mask-position: 0 0, 0 0, 100% 100%; }
  to { mask-position: 0 0, 0 0, 0% 0%; }
}
@media (prefers-reduced-motion: reduce) {
  .ankka-loader-field > g { animation: none; opacity: .7; }
  .ankka-loader-inline::before { animation: none; mask-image: repeating-linear-gradient(to right, #000 0 2px, transparent 2px 4px), repeating-linear-gradient(to bottom, #000 0 2px, transparent 2px 4px); opacity: .6; }
}
`;
