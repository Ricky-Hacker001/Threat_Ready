import { Controller, Get, Inject } from "@nestjs/common";
import { APP_KEYS } from "@threatready/contracts";
import { sql } from "drizzle-orm";
import { Public } from "../authz/authz.js";
import { CONFIG, type Config } from "../config.js";
import { DB, type Db } from "../db/db.js";

@Controller()
export class PublicController {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DB) private readonly db: Db,
  ) {}

  /** What the auth page needs to render. Contains no secrets. */
  @Get("public/config")
  @Public()
  config_() {
    return {
      providers: { google: !!this.config.google, github: !!this.config.github },
      turnstileSiteKey: this.config.turnstile?.siteKey ?? null,
      // Public origins only; internal URLs never leave the server.
      apps: APP_KEYS.map((k) => {
        const { internalUrl: _internal, ...info } = this.config.apps[k];
        return info;
      }),
      /** Origins the SPA may send the browser back to after sign-in (?next=). */
      appOrigins: this.config.appOrigins,
    };
  }

  /** ALB health check. */
  @Get("health")
  @Public()
  async health() {
    await this.db.execute(sql`select 1`);
    return { ok: true };
  }
}
