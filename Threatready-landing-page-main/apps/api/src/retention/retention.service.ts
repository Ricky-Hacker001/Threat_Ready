import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { CONFIG, type Config } from "../config.js";
import { DB, type Db } from "../db/db.js";
import { runRetention } from "./retention.js";

/**
 * Runs the retention pass (retention.ts) shortly after boot and then every RETENTION_INTERVAL_HOURS
 * (0 turns it off). Failures are logged and retried on the next tick; they never stop the API.
 */
@Injectable()
export class RetentionService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger("Retention");
  private timers: NodeJS.Timeout[] = [];

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  onApplicationBootstrap(): void {
    const hours = this.config.RETENTION_INTERVAL_HOURS;
    if (!(hours > 0)) return;
    // Not during boot itself: the first pass waits a minute so start-up stays quick.
    this.timers.push(setTimeout(() => void this.run(), 60_000).unref());
    this.timers.push(setInterval(() => void this.run(), hours * 60 * 60 * 1000).unref());
  }

  onApplicationShutdown(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  async run(): Promise<void> {
    try {
      const result = await runRetention(this.db, {
        unverifiedDays: this.config.RETENTION_UNVERIFIED_DAYS,
        guestDays: this.config.RETENTION_GUEST_DAYS,
      });
      if (!result) return; // another instance is running the pass
      const removed = Object.entries(result).filter(([, n]) => n > 0);
      if (removed.length) this.logger.log(`removed ${removed.map(([k, n]) => `${k}=${n}`).join(" ")}`);
    } catch (err) {
      this.logger.error(`retention pass failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
