/**
 * Budget Durable Object: one global instance tracks today's LLM spend (USD, from token counts × configured
 * prices) and Workers AI neurons, and refuses work once a cap is hit. Days roll over at 00:00 UTC, matching
 * Cloudflare's quota resets. Single-threaded by construction, so reservations can't race.
 */
import { DurableObject } from "cloudflare:workers";

type Tier = "primary" | "fallback";

const today = () => new Date().toISOString().slice(0, 10);

export class BudgetDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS spend (day TEXT PRIMARY KEY, usd REAL NOT NULL DEFAULT 0, neurons REAL NOT NULL DEFAULT 0, primary_calls INTEGER NOT NULL DEFAULT 0, fallback_calls INTEGER NOT NULL DEFAULT 0, refused INTEGER NOT NULL DEFAULT 0, inflight REAL NOT NULL DEFAULT 0)",
    );
  }

  private row() {
    const d = today();
    this.sql.exec("INSERT OR IGNORE INTO spend (day) VALUES (?)", d);
    return this.sql.exec("SELECT * FROM spend WHERE day = ?", d).one() as {
      day: string;
      usd: number;
      neurons: number;
      primary_calls: number;
      fallback_calls: number;
      refused: number;
      inflight: number;
    };
  }

  private caps() {
    return {
      usd: Number(this.env.DAILY_LLM_USD_CAP ?? 0.5),
      neurons: Number(this.env.FALLBACK_NEURON_CAP ?? 8000),
    };
  }

  /** May this call go ahead? `estimate` is reserved until commit, so bursts can't overshoot much. */
  async reserve(tier: Tier, estimate: number): Promise<boolean> {
    const r = this.row();
    const caps = this.caps();
    const ok = tier === "primary" ? r.usd + r.inflight + estimate <= caps.usd : r.neurons < caps.neurons;
    if (!ok) {
      this.sql.exec("UPDATE spend SET refused = refused + 1 WHERE day = ?", r.day);
      return false;
    }
    if (tier === "primary") this.sql.exec("UPDATE spend SET inflight = inflight + ? WHERE day = ?", estimate, r.day);
    return true;
  }

  async commit(tier: Tier, usd: number, neurons: number): Promise<void> {
    const r = this.row();
    if (tier === "primary")
      this.sql.exec(
        "UPDATE spend SET usd = usd + ?, inflight = MAX(0, inflight - 0.002), primary_calls = primary_calls + 1 WHERE day = ?",
        usd,
        r.day,
      );
    else
      this.sql.exec(
        "UPDATE spend SET usd = usd + ?, neurons = neurons + ?, fallback_calls = fallback_calls + 1 WHERE day = ?",
        usd,
        neurons,
        r.day,
      );
  }

  async stats(days = 14) {
    this.row();
    const rows = this.sql.exec("SELECT * FROM spend ORDER BY day DESC LIMIT ?", days).toArray();
    return { caps: this.caps(), days: rows };
  }

  /** Test hook for the quota-exhaustion drills (M6); admin-only route. */
  async simulate(usd: number, neurons: number) {
    const r = this.row();
    this.sql.exec("UPDATE spend SET usd = ?, neurons = ? WHERE day = ?", usd, neurons, r.day);
    return this.row();
  }
}
