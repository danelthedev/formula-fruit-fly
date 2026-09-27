import { readFileSync } from 'node:fs';
import { forwardGenome } from '../src/nn.ts';
// wall-approach obs: speed high, centered, heading ok, forward ray short
const obs = [200/300, 0, 0, 0.1, 0.5, 0.5, 0.5, 0.12, 0.5, 0.5, 0.5, 0.5, 0, 0.5, 0, 0.5];
const saved = JSON.parse(readFileSync('/tmp/headless_pop.json', 'utf8'));
let nBrk = 0, nThr = 0;
for (const a of saved.pop) {
  const g = new Float32Array(a);
  const [thr, brk] = forwardGenome(g, obs);
  if (brk > 0.1) nBrk++;
  if (thr > 0.9) nThr++;
}
console.log(`pop=${saved.pop.length} brake>0.1: ${nBrk}, throttle>0.9: ${nThr}`);
