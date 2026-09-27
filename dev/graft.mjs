import fs from 'node:fs';
const por = JSON.parse(fs.readFileSync('/tmp/headless_pop.json', 'utf8'));
const spa = JSON.parse(fs.readFileSync('/tmp/spa_champ.json', 'utf8'));
const spaBest = spa.best ?? spa.pop[0];
// deterministic-ish mutations of spa best using simple LCG
let s = 12345;
const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const mut = (g, sig) => {
  const o = Float32Array.from(g);
  for (let i = 0; i < o.length; i += 2) {
    const u1 = Math.max(rnd(), 1e-9), u2 = rnd();
    const r = Math.sqrt(-2 * Math.log(u1)), t = 2 * Math.PI * u2;
    o[i] += r * Math.cos(t) * sig;
    if (i + 1 < o.length) o[i + 1] += r * Math.sin(t) * sig;
  }
  return [...o];
};
// keep first 12 (local lines), replace rest with spa mutants at varying sigma
const pop = por.pop.map((a) => [...a]);
for (let i = 12; i < pop.length; i++) pop[i] = mut(spaBest, 0.05 + 0.05 * (i % 3));
por.pop = pop;
fs.writeFileSync('/tmp/headless_pop.json', JSON.stringify(por));
console.log(`grafted: pop=${pop.length}, kept 12 local + ${pop.length - 12} spa-mutants`);
