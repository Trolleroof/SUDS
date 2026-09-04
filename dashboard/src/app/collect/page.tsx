import CollectPanel from "@/components/CollectPanel";
import DashboardTabs from "@/components/DashboardTabs";

export const dynamic = "force-dynamic";

export default function CollectPage() {
  return (
    <div className="app">
      <header className="header">
        <span className="brand">SUDS</span>
        <DashboardTabs current="collect" />
      </header>
      <div className="body">
        <main className="main">
          <CollectPanel />
        </main>
      </div>
    </div>
  );
}
