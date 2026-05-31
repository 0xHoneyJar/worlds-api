/**
 * Minimal ambient declaration for the `pg` module surface this repo uses.
 *
 * freeside-worlds installs `pg` as an OPTIONAL peer (the engine + protocol
 * packages have zero DB deps). Rather than pull @types/pg into the schema/
 * registry repo, we declare the exact two constructors we touch (Pool, Client)
 * with the structural shape PgConfigStore / migrate.ts rely on. The real `pg`
 * package satisfies this at runtime. If freeside-worlds later adds @types/pg,
 * delete this shim.
 */
declare module 'pg' {
  interface QueryResult<R = unknown> {
    rows: R[];
    rowCount: number | null;
  }
  interface PoolClient {
    query<R = unknown>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
    release(): void;
  }
  export class Pool {
    constructor(config?: { connectionString?: string });
    query<R = unknown>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
  }
  export class Client {
    constructor(config?: { connectionString?: string });
    connect(): Promise<void>;
    query<R = unknown>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
    end(): Promise<void>;
  }
}
