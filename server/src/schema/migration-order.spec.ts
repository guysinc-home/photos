import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const folder = join(import.meta.dirname, 'migrations');
const order = readFileSync(join(folder, 'ORDER'), 'utf8').split('\n').filter(Boolean);
const files = readdirSync(folder)
  .filter((file) => file.endsWith('.ts'))
  .map((file) => file.replace(/\.ts$/, ''));

describe('migrations', () => {
  it('should list every migration file in ORDER exactly once', () => {
    expect(new Set(order).size).toBe(order.length);
    expect([...order].sort()).toEqual([...files].sort());
  });

  it('should name every migration later than all migrations listed before it', () => {
    const outOfOrder = order.filter((name, index) => index > 0 && name.localeCompare(order[index - 1]) <= 0);

    expect(outOfOrder).toEqual([]);
  });
});
