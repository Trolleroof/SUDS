import Dashboard from "@/components/Dashboard";
import { listDatasets } from "@/lib/dataset";
import { datasetRoot } from "@/lib/paths";

export const dynamic = "force-dynamic";

export default async function Page() {
  return <Dashboard datasets={await listDatasets()} root={datasetRoot()} />;
}
