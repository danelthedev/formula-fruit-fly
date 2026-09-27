import { readFileSync, writeFileSync } from 'node:fs';
const saved = JSON.parse(readFileSync('/tmp/hp_spa.json', 'utf8'));
const g = saved.best ?? saved.pop[0];
const wf = { v: 1, teamId: 'PLACEHOLDER', teamName: 'QualiTeam', arch: [16, 64, 64, 3], weights: [...g] };
writeFileSync('/tmp/spa_champ_weights.json', JSON.stringify(wf));
console.log('exported', g.length, 'weights');
