import { z } from 'zod';
import { assertDefined } from '../assert-defined.js';
import { describe, expect, it } from 'vitest';
import { createBillingConnection, runWithBillingContext } from '../../src/infrastructure/postgres/connection.js';
import type { RowDataPacket } from '../../src/infrastructure/postgres/connection.js';
import Fastify from 'fastify';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration('PostgreSQL pool transaction context', () => {
  it('assigns concurrent transactions to independent physical sessions', async () => {
    const connection = await createBillingConnection(assertDefined(databaseUrl));
    try {
      const ids = await Promise.all([1, 2].map(() => runWithBillingContext(async () => {
        await connection.beginTransaction();
        try {
          const [rows] = await connection.query<(RowDataPacket & { connection_id: number })[]>('SELECT pg_backend_pid() AS connection_id');
          await new Promise((resolve) => setTimeout(resolve, 50));
          const [sameRows] = await connection.query<(RowDataPacket & { connection_id: number })[]>('SELECT pg_backend_pid() AS connection_id');
          expect(sameRows[0]?.connection_id).toBe(rows[0]?.connection_id);
          await connection.commit();
          return rows[0]?.connection_id;
        } catch (error) {
          await connection.rollback();
          throw error;
        }
      })));
      expect(ids[0]).toBeDefined();
      expect(ids[1]).toBeDefined();
      expect(ids[0]).not.toBe(ids[1]);
    } finally {
      await connection.end();
    }
  });

  it('propagates the context through a Fastify request lifecycle', async () => {
    const connection = await createBillingConnection(assertDefined(databaseUrl));
    const app = Fastify({ logger: false });
    app.addHook('onRequest', (_request, _reply, done) => { runWithBillingContext(() => done()); });
    app.get('/', async () => {
      await connection.beginTransaction();
      try {
        const [rows] = await connection.query<(RowDataPacket & { connection_id: number })[]>('SELECT pg_backend_pid() AS connection_id');
        await connection.commit();
        return { connectionId: rows[0]?.connection_id };
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
    try {
      const responses = await Promise.all([1, 2].map(() => app.inject({ method: 'GET', url: '/' })));
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      expect(z.object({ connectionId: z.number() }).parse(assertDefined(responses[0]).json<unknown>()).connectionId).not.toBe(z.object({ connectionId: z.number() }).parse(assertDefined(responses[1]).json<unknown>()).connectionId);
    } finally {
      await app.close();
      await connection.end();
    }
  });
});
