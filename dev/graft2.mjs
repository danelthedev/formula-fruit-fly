import fs from 'node:fs';
const por = JSON.parse(fs.readFileSync('/tmp/hp_portimao.json'));
const spa = JSON.parse(fs.readFileSync('/tmp/hp_spa.json'));
const spaBest = new Float32Array(spa.best ?? spa.pop[0]);
let s = 777;
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
const pop = por.pop.map((a) => [...a]);
for (let i = 8; i < pop.length; i++) pop[i] = mut(spaBest, 0.08);
por.pop = pop;
fs.writeFileSync('/tmp/headless_pop.json', JSON.stringify(por));
console.log('grafted 16 spa-mutants into Portimao pop');
