import fs from 'node:fs';
const mon = JSON.parse(fs.readFileSync('/tmp/hp_monaco.json'));
const donors = [];
for (const f of ['/tmp/hp_spa.json', '/tmp/hp_bahrain.json', '/tmp/hp_portimao2.json']) {
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    donors.push(new Float32Array(d.best ?? d.pop[0]));
  } catch { /* skip */ }
}
let s = 4242;
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
const pop = mon.pop.map((a) => [...a]);
for (let i = 6; i < pop.length; i++) pop[i] = mut(donors[i % donors.length], 0.08);
mon.pop = pop;
fs.writeFileSync('/tmp/headless_pop.json', JSON.stringify(mon));
console.log(`grafted ${pop.length - 6} multi-donor mutants into Monaco pop`);
