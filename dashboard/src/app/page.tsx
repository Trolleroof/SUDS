import Dashboard from "@/components/Dashboard";
import { listDatasets } from "@/lib/dataset";
import { datasetRoot } from "@/lib/paths";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  return (
    <Dashboard
      datasets={await listDatasets()}
      root={datasetRoot()}
      initialView={view === "review" ? "review" : "live"}
    />
  );
}
