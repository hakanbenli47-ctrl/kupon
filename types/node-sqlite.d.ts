declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(filename: string);
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): Record<string, unknown>[];
      get(...params: unknown[]): Record<string, unknown> | undefined;
      run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    };
    close(): void;
  }
}
