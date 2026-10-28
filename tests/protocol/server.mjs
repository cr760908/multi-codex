import readline from 'node:readline';
import { once } from 'node:events';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const responses = new Map();
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const m = JSON.parse(line);
  if (!m.method) { responses.get(m.id)?.(m); return; }
  const result = value => send({ id: m.id, result: value });
  switch (m.method) {
    case 'utf8': {
      const data = Buffer.from(JSON.stringify({ id: m.id, result: '中文🙂' }) + '\n');
      for (const byte of data) { process.stdout.write(Buffer.from([byte])); await new Promise(r => setTimeout(r, 1)); }
      break;
    }
    case 'batch': process.stdout.write(JSON.stringify({ method: 'event', params: 1 }) + '\n' + JSON.stringify({ method: 'event', params: 2 }) + '\n' + JSON.stringify({ id: m.id, result: 'done' }) + '\n'); break;
    case 'interleave': case 'unknown':
      responses.set(m.id, reply => result(reply.result ?? reply.error));
      send({ id: m.id, method: m.method === 'unknown' ? 'unsupported' : 'approval', params: {} }); break;
    case 'late': setTimeout(() => result('late'), 100); break;
    case 'slow': setTimeout(() => result('slow'), 200); break;
    case 'exit': process.exit(0); break;
    case 'ignore-eof': setInterval(() => {}, 1000); result('ignoring'); break;
    case 'stderr':
      for (let i = 0; i < 64; i++) if (!process.stderr.write('s'.repeat(65536))) await once(process.stderr, 'drain');
      result('drained'); break;
    case 'oversize': process.stdout.write('x'.repeat(2048)); break;
    case 'malformed': process.stdout.write('not JSON\n'); break;
  }
});
