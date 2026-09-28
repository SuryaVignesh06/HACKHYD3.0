import { ArrowLeft } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import IncidentDetailView from "../components/IncidentDetailView";

export default function IncidentDetail() {
  const { id = "" } = useParams();
  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mx-auto max-w-3xl space-y-4">
        <Link to="/history" className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Incident history
        </Link>
        <p className="font-mono text-sm text-memory">{id}</p>
        <IncidentDetailView incidentId={id} />
      </div>
    </div>
  );
}
