import React from "react";
import { useApp } from "@/state/store";
import { Shell } from "@/components/Shell";
import { Entry } from "@/screens/Entry";
import { MissionControl } from "@/screens/MissionControl";
import { Briefing } from "@/screens/Briefing";
import { Workspace } from "@/screens/Workspace";
import { Results } from "@/screens/Results";
import { Badges } from "@/screens/Badges";
import { Learning } from "@/screens/Learning";

export default function App() {
  const { state } = useApp();
  return (
    <Shell>
      {state.view === "entry" && <Entry />}
      {state.view === "mission" && <MissionControl />}
      {state.view === "briefing" && <Briefing />}
      {state.view === "workspace" && <Workspace />}
      {state.view === "results" && <Results />}
      {state.view === "badges" && <Badges />}
      {state.view === "learning" && <Learning />}
    </Shell>
  );
}
