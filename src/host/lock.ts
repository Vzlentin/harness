/**
 * The lock of the host of a project, which a program that writes the store with no host takes too, so that it never
 * writes while a host runs.
 */
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The lock of the host, a write transaction on `lock.sqlite`, held until `close()`. The system drops it when the
 * process ends. It is undefined when another process holds it. `IMMEDIATE`, not `EXCLUSIVE`: two hosts that start at
 * the same time can both fail `EXCLUSIVE`, each holding a lock the other one needs, and then no host runs.
 */
export function takeLock(directory: string): DatabaseSync | undefined {
	const database = new DatabaseSync(join(directory, "lock.sqlite"), { timeout: 0 });

	try {
		database.exec("BEGIN IMMEDIATE");

		return database;
	} catch {
		database.close();

		return undefined;
	}
}
