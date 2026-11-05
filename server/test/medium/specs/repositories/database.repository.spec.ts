import { Kysely } from 'kysely';
import { setTimeout } from 'node:timers/promises';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

const POOL_SIZE = 10;

let db: Kysely<DB>;
let sut: DatabaseRepository;

const withinFifteenSeconds = <T>(promise: Promise<T>) =>
  Promise.race([
    promise,
    setTimeout(15_000).then(() => {
      throw new Error('timed out');
    }),
  ]);

beforeAll(async () => {
  db = await getKyselyDB();
  sut = new DatabaseRepository(db, LoggingRepository.create(), new ConfigRepository());
});

describe(DatabaseRepository.name, () => {
  describe('withUuidLock', () => {
    it('should finish when more callers hold different uuid locks than the pool has connections', async () => {
      const ids = Array.from({ length: POOL_SIZE * 3 }, () => factory.uuid());

      const results = Promise.all(
        ids.map((id) => sut.withUuidLock(id, () => db.selectFrom('user').select('id').execute())),
      );

      await expect(withinFifteenSeconds(results)).resolves.toHaveLength(ids.length);
    }, 20_000);

    it('should finish when more callers wait on the same uuid lock than the pool has connections', async () => {
      const id = factory.uuid();
      const order: number[] = [];

      const results = Promise.all(
        Array.from({ length: POOL_SIZE * 3 }, (_, index) =>
          sut.withUuidLock(id, async () => {
            await db.selectFrom('user').select('id').execute();
            order.push(index);
          }),
        ),
      );

      await expect(withinFifteenSeconds(results)).resolves.toHaveLength(POOL_SIZE * 3);
      expect(order).toHaveLength(POOL_SIZE * 3);
    }, 20_000);

    it('should not run two callbacks for the same uuid at once', async () => {
      const id = factory.uuid();
      let running = 0;
      let maxRunning = 0;

      await Promise.all(
        Array.from({ length: 5 }, () =>
          sut.withUuidLock(id, async () => {
            running++;
            maxRunning = Math.max(maxRunning, running);
            await setTimeout(20);
            running--;
          }),
        ),
      );

      expect(maxRunning).toBe(1);
    });
  });
});
