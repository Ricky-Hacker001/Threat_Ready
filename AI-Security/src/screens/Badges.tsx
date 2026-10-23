import React from "react";
import { useApp } from "@/state/store";
import { badgeShowcase } from "@/engine/progress";
import { Crumbs } from "@/components/common";

export function Badges() {
  const { state, dispatch } = useApp();
  const p = state.progress!;
  const items = badgeShowcase(p);
  const taskBadges = items.filter((i) => i.def.kind === "task");
  const tierBadges = items.filter((i) => i.def.kind === "tier");
  const earned = items.filter((i) => i.earned).length;

  return (
    <div className="stack">
      <Crumbs onHome={() => dispatch({ t: "mission" })} trail={["Badges"]} />

      <div className="row between wrap">
        <div>
          <h1 style={{ margin: 0 }}>Badges &amp; appreciation</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Complete all three levels of a task to unlock its badge. Clear a whole tier for a tier medal.
          </p>
        </div>
        <span className="pill info">{earned} / {items.length} unlocked</span>
      </div>

      <h3 style={{ marginTop: 8 }}>Task badges</h3>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(210px,1fr))" }}>
        {taskBadges.map((b) => (
          <BadgeCard key={b.def.id} {...b} />
        ))}
      </div>

      <h3 style={{ marginTop: 16 }}>Tier medals</h3>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(210px,1fr))" }}>
        {tierBadges.map((b) => (
          <BadgeCard key={b.def.id} {...b} />
        ))}
      </div>

      <div className="row mt">
        <button className="btn ghost" onClick={() => dispatch({ t: "mission" })}>
          Back to Mission Control
        </button>
      </div>
    </div>
  );
}

function BadgeCard({
  def,
  earned,
  progress,
}: ReturnType<typeof badgeShowcase>[number]) {
  return (
    <div
      className="card"
      style={{
        textAlign: "center",
        // No dimming for locked cards (it took the muted text under 4.5:1); the greyed icon and the
        // progress bar show the locked state.
        borderColor: earned ? "var(--green)" : "var(--border)",
        background: earned ? "var(--green-bg)" : "var(--bg-1)",
      }}
    >
      <div
        style={{
          fontSize: 34,
          filter: earned ? "none" : "grayscale(1) opacity(0.45)",
          marginBottom: 6,
        }}
        aria-hidden="true"
      >
        {earned ? def.icon : "🔒"}
      </div>
      <div style={{ fontWeight: 600 }}>{def.title}</div>
      <div className="small muted" style={{ minHeight: 34, marginTop: 4 }}>
        {def.description}
      </div>
      {earned ? (
        <span className="pill green" style={{ marginTop: 8 }}>
          Unlocked
        </span>
      ) : (
        <div style={{ marginTop: 8 }}>
          <div className="bar">
            <span style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            {Math.round(progress * 100)}% complete
          </div>
        </div>
      )}
    </div>
  );
}
