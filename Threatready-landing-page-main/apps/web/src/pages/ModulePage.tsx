import { useEffect } from "react";
import { Navigate, useParams } from "react-router";
import { useMe } from "../components/AppShell";
import { featureByKey, featureUrl } from "../content/features";

/**
 * Old /app/:feature links. Each feature now lives in its own app on its own
 * subdomain (interviewprep., labs., ar.), which owns its sessions, reports and
 * status; this route only forwards there.
 */
export function ModulePage() {
  const { feature } = useParams();
  const { me, apps } = useMe();
  const copy = feature ? featureByKey(feature) : undefined;
  const url = copy && !me.user.isTrial ? featureUrl(copy, apps) : null;

  useEffect(() => {
    if (url) window.location.replace(url);
  }, [url]);

  if (!url) return <Navigate to="/app" replace />;
  return (
    <p className="quota" role="status">
      Opening {copy?.title}…
    </p>
  );
}
