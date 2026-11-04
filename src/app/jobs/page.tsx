"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError, dollars } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface JobRow {
  id: string;
  jobNo: number;
  name: string;
  jobType: string;
  status: string;
  customerName: string;
  costTotalCents: number;
}

const TYPE_LABEL: Record<string, string> = {
  retail: "Retail",
  "insurance-restoration": "Insurance",
  "solar-financed": "Solar",
};

export default function JobsPage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState("");
  // new-job form
  const [customerName, setCustomerName] = useState("");
  const [name, setName] = useState("");
  const [jobType, setJobType] = useState("retail");
  const [contract, setContract] = useState("");
  const [busy, setBusy] = useState(false);
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(jobs !== null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ jobs: JobRow[] }>("/api/jobs");
      setJobs(data.jobs);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.push("/login");
      } else {
        setError("Couldn't load jobs.");
      }
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createJob() {
    setBusy(true);
    setError("");
    try {
      const contractCents = Math.round(Number(contract || "0") * 100);
      const job = await api<{ id: string }>("/api/jobs", {
        method: "POST",
        json: { customerName, name, jobType, contractCents },
      });
      router.push(`/jobs/${job.id}`);
    } catch {
      setError("Couldn't create the job — check the fields.");
      setBusy(false);
    }
  }

  // First paint: a wireframe of this screen, inside the shell. Never on a
  // refetch — useFirstLoad latches, so saving does not re-flash the page.
  if (!jobs) {
    return (
      <AppShell title="Jobs">
        {showSkeleton && <PageSkeleton kind="list" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  return (
    <AppShell title="Jobs">
      <div className="row">
        <div className="grow" />
        <button className="secondary" onClick={() => setShowNew((v) => !v)}>
          {showNew ? "Close" : "+ New job"}
        </button>
      </div>

      {showNew && (
        <div className="card">
          <label htmlFor="cust">Customer name</label>
          <input id="cust" value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Sam Smith" />
          <label htmlFor="jname">Job name</label>
          <input id="jname" value={name} onChange={(e) => setName(e.target.value)} placeholder="Smith re-roof" />
          <label htmlFor="jtype">Job type</label>
          <select id="jtype" value={jobType} onChange={(e) => setJobType(e.target.value)}>
            <option value="retail">Retail (customer pays)</option>
            <option value="insurance-restoration">Insurance restoration</option>
            <option value="solar-financed">Solar (financed)</option>
          </select>
          <label htmlFor="jcontract">Contract amount ($)</label>
          <input id="jcontract" inputMode="decimal" value={contract} onChange={(e) => setContract(e.target.value)} placeholder="20000" />
          <div style={{ marginTop: 12 }}>
            <button onClick={createJob} disabled={busy || !customerName.trim() || !name.trim()}>
              {busy ? "Creating…" : "Create job"}
            </button>
          </div>
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {jobs === null ? (
        <p className="muted">Loading…</p>
      ) : jobs.length === 0 ? (
        <div className="card">
          <p>No jobs yet. Create your first one — it takes a minute.</p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          {jobs.map((j) => (
            <Link key={j.id} href={`/jobs/${j.id}`} className="list-item">
              <div className="row">
                <strong className="grow">
                  #{j.jobNo} · {j.name}
                </strong>
                <span className="pill">{TYPE_LABEL[j.jobType] ?? j.jobType}</span>
                <span className="pill">{j.status}</span>
              </div>
              <div className="muted">
                {j.customerName} · costs so far {dollars(j.costTotalCents)}
              </div>
            </Link>
          ))}
        </div>
      )}
    </AppShell>
  );
}
